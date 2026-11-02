"""Synthetic retained resource facts, fingerprints and launch behavior."""

import time

import httpx
import pytest
from test_controlplane import baseline, seed
from test_resources import fixture

from controlplane.api import create_app
from controlplane.resource_history import prune, summaries
from controlplane.resources import profile_hash
from controlplane.schema import Deployment, DeploymentSet
from controlplane.store import identity


def test_fingerprint_ignores_labels_but_separates_execution_inputs(tmp_path):
    _, manager, draft = fixture(tmp_path)
    p = draft["configuration"]
    a = manager.store.get("artifact", "weights")
    r = manager.store.get("runtime", "runtime")
    fingerprint = profile_hash(p, a, r, 0)
    assert (
        profile_hash(
            p | {"name": "Renamed", "revision": 99, "catalog": {"x": True}}, a, r, 0
        )
        == fingerprint
    )
    for changed in (
        p | {"config": p["config"] | {"parallel": 2}},
        p | {"raw_args": ["--example"]},
    ):
        assert profile_hash(changed, a, r, 0) != fingerprint
    assert profile_hash(p, a, r, 1) != fingerprint
    assert profile_hash(p, a | {"sha256": "changed"}, r, 0) != fingerprint
    assert profile_hash(p, a, r | {"version": "changed"}, 0) != fingerprint


async def test_grouped_history_keeps_unknown_zero_failed_and_legacy_runs(tmp_path):
    app, manager, draft = fixture(tmp_path)
    store = manager.store
    p = draft["configuration"]
    a, r = store.get("artifact", "weights"), store.get("runtime", "runtime")
    now = time.time()
    common = {
        "profile_hash": identity(p),
        "deployment_snapshot": {"profile_snapshot": p, "gpu": 0},
        "artifact_identity": a,
        "runtime_identity": r,
        "started_at": now,
        "ended_at": now + 1,
        "outcome": "stopped",
    }
    store.put("session", common | {"id": "one", "peak_gpu_mib": 100, "peak_ram_mib": 0})
    store.put(
        "session", common | {"id": "two", "peak_gpu_mib": 300, "outcome": "failed"}
    )
    store.put("session", common | {"id": "unknown"})
    store.put(
        "session",
        common | {"id": "old", "started_at": now - 100 * 86400, "peak_gpu_mib": 99999},
    )
    estimate = manager.estimate(draft | {"profile_snapshot": p})
    assert estimate["peak_mib"] == 300 and estimate["ram_mib"] == 0
    assert estimate["components"] is None and estimate["basis"] == "observed"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        groups = (await client.get("/api/history/resources?artifact_id=weights")).json()
        assert len(groups) == 1 and groups[0]["run_count"] == 3
        assert groups[0]["gpu"] == {
            "sample_count": 2,
            "mean_peak_mib": 200,
            "max_peak_mib": 300,
        }
        assert groups[0]["ram"] == {
            "sample_count": 1,
            "mean_peak_mib": 0,
            "max_peak_mib": 0,
        }
        assert (
            await client.get("/api/history/resources?artifact_id=missing")
        ).json() == []
    await manager.close()


def test_retention_bounds_resource_facts_not_restorable_configuration(tmp_path):
    _, manager, _ = fixture(tmp_path)
    store = manager.store
    now = time.time()
    common = {
        "profile_hash": "synthetic",
        "started_at": now - 100 * 86400,
        "outcome": "stopped",
        "peak_gpu_mib": 500,
        "deployment_snapshot": {"configuration": "retained"},
    }
    store.put("session", common | {"id": "expired"})
    store.put("session", common | {"id": "recent", "started_at": now})
    store.put("session", common | {"id": "running", "outcome": "running"})
    with store.transaction() as c:
        prune(store, manager.settings(), c)
    old = store.get("session", "expired")
    assert old["deployment_snapshot"] == common["deployment_snapshot"]
    assert "peak_gpu_mib" not in old and old["resource_history_retained"] is False
    assert store.get("session", "running")["peak_gpu_mib"] == 500
    assert len(summaries(store, manager.settings())) == 1
    with store.transaction() as c:
        prune(store, manager.settings() | {"history_quota_mib": 0}, c)
    assert "peak_gpu_mib" not in store.get("session", "recent")


async def test_over_budget_and_uncertainty_never_gate_but_measured_limit_does(tmp_path):
    app = create_app(tmp_path / "state")
    store, manager = app.state.store, app.state.manager
    await seed(store, tmp_path)
    manager.host = baseline()
    d = store.get("deployment", "a")
    store.put("deployment", d | {"allow_uncertain": False, "reservation_mib": 999999})
    store.put(
        "session",
        {
            "id": "observed",
            "profile_hash": manager.estimate(d)["profile_hash"],
            "started_at": time.time(),
            "peak_gpu_mib": 100000,
            "outcome": "failed",
        },
    )
    try:
        plan = manager.plan(["a"])
        assert not plan["errors"] and any("over budget" in w for w in plan["warnings"])
        await manager.activate(["a"], token=plan["plan_token"])
        assert store.get("deployment", "a")["state"] == "READY"
        await manager.stop("a")
        manager.host["gpus"][0]["free_mib"] = 100
        assert any("headroom" in e for e in manager.plan(["a"])["errors"])
    finally:
        await manager.close()


def test_removed_controls_are_not_in_schema():
    assert "allow_uncertain" not in Deployment.model_fields
    assert "allow_uncertain" not in DeploymentSet.model_fields
    assert "reservation_mib" not in Deployment.model_fields


async def test_real_engine_error_is_exposed_and_redacted(tmp_path):
    app = create_app(tmp_path / "state")
    store, manager = app.state.store, app.state.manager
    await seed(store, tmp_path)
    d = store.get("deployment", "a")
    folder = store.root / "deployments" / "a"
    folder.mkdir(parents=True)
    (folder / "runtime.log").write_text(
        "CUDA out of memory: allocation failed\napi_key=synthetic-secret\n"
    )
    error = manager.engine_failure(d, 1)
    assert "CUDA out of memory" in error and "synthetic-secret" not in error
    store.put("session", {"id": "current", "started_at": time.time()})
    assert "CUDA out of memory" not in manager.engine_failure(
        d | {"session_id": "current"}, 1
    )
    await manager.close()


@pytest.mark.parametrize("limit", ["gpu", "ram", "temperature"])
async def test_only_measured_limits_abort_an_in_progress_launch(
    tmp_path, monkeypatch, limit
):
    app = create_app(tmp_path / "state")
    store, manager = app.state.store, app.state.manager
    await seed(store, tmp_path)
    manager.host = baseline()

    async def loading(_):
        if limit == "gpu":
            manager.host["gpus"][0]["free_mib"] = 100
        elif limit == "temperature":
            manager.host["gpus"][0]["temperature"] = 99
        else:
            manager.host["ram_available_mib"] = 100
        return False

    monkeypatch.setattr(manager, "ready", loading)
    try:
        expected = {
            "gpu": "GPU 0 free memory 100 MiB below 2048 MiB",
            "ram": "System RAM available memory 100 MiB below 4096 MiB",
            "temperature": "GPU 0 temperature 99 °C above 85 °C",
        }
        with pytest.raises(RuntimeError, match=expected[limit]):
            await manager.activate(["a"])
        d = store.get("deployment", "a")
        assert d["state"] == "FAILED" and not manager.owned(d)
        assert store.get("session", d["session_id"])["outcome"] == "failed"
    finally:
        await manager.close()
