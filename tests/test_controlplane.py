import asyncio
import json
import os
import socket
import struct
import sys
from pathlib import Path

import httpx
import pytest

from controlplane import adapters
from controlplane.api import create_app
from controlplane.catalog import normalize
from controlplane.manager import Conflict, Manager
from controlplane.store import Store


def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "state")


async def seed(store, tmp_path):
    script = tmp_path / "runtime"
    source = Path(__file__).with_name("fake_runtime.py").read_text().split("\n", 1)[1]
    script.write_text(f"#!{sys.executable}\n" + source)
    script.chmod(0o700)
    runtime = {
        "id": "runtime",
        "name": "fixture",
        "engine": "llama.cpp",
        "execution_kind": "native",
        "executable": str(script),
        "env": {},
        "trust": True,
    }
    runtime["capabilities"] = await adapters.probe(runtime)
    store.put("runtime", runtime)
    weights = tmp_path / "weights.gguf"
    weights.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 0, 0))
    store.put("artifact", adapters.inspect_artifact(weights) | {"id": "weights"})
    for ident in ("a", "b"):
        profile = store.put(
            "profile",
            {
                "id": ident,
                "name": ident,
                "artifact_id": "weights",
                "runtime_id": "runtime",
                "config": {},
                "raw_args": [],
                "catalog": {},
            },
        )
        store.put(
            "deployment",
            {
                "id": ident,
                "name": ident,
                "alias": ident,
                "port": port(),
                "profile_id": ident,
                "profile_snapshot": profile,
                "state": "STOPPED",
                "residency": "pinned",
                "priority": 50,
                "gpu": 0,
                "enabled": True,
                "reservation_mib": 2000,
                "allow_uncertain": True,
                "allow_eviction": False,
                "idle_timeout": 300,
                "queue_timeout": 5,
                "reservation_active": 0,
            },
        )


def baseline():
    return {
        "gpus": [
            {
                "index": 0,
                "total_mib": 16384,
                "free_mib": 14000,
                "used_mib": 2384,
                "temperature": 35,
            }
        ],
        "ram_available_mib": 32000,
        "processes": [],
        "ts": 1,
    }


def test_revision_and_backup(store):
    p = store.put("profile", {"id": "p", "config": {"ctx": 10}})
    store.put("profile", p | {"config": {"ctx": 20}}, expected=1)
    with pytest.raises(ValueError, match="Revision changed"):
        store.put("profile", p, expected=1)
    assert store.history("profile", "p")[-1]["config"]["ctx"] == 10
    assert store.backup().exists()


async def test_two_processes_independent_stop_and_failure_rollback(store, tmp_path):
    await seed(store, tmp_path)
    m = Manager(store)
    m.host = baseline()
    try:
        await m.activate(["a", "b"], override=True)
        assert {d["state"] for d in store.list("deployment")} == {"READY"}
        assert all("peak_gpu_mib" not in s for s in store.list("session"))
        assert all("peak_ram_mib" not in s for s in store.list("session"))
        pid_b = store.get("deployment", "b")["pid"]
        await m.stop("a")
        assert store.get("deployment", "b")["pid"] == pid_b
        assert await m.ready(store.get("deployment", "b"))
        await m.stop("b")
        d = store.get("deployment", "b")
        d["profile_snapshot"]["config"]["fail"] = True
        store.put("deployment", d)
        with pytest.raises(RuntimeError, match="exited"):
            await m.activate(["a", "b"], override=True)
        assert all(
            d["state"] == "FAILED" and not d["reservation_active"]
            for d in store.list("deployment")
        )
        assert all(not m.owned(d) for d in store.list("deployment"))
    finally:
        await m.close()


async def test_pinned_policy_and_busy_manual_stop(store, tmp_path):
    await seed(store, tmp_path)
    m = Manager(store)
    m.host = baseline()
    try:
        await m.activate(["a"], True)
        d = await m.acquire("a")
        with pytest.raises(Conflict, match="active requests"):
            await m.stop("a")
        with pytest.raises(Conflict, match="not ready"):
            await m.acquire("b")
        assert store.get("deployment", "a")["state"] == "READY"
        m.release(d)
        await m.stop("a")
    finally:
        await m.close()


async def test_capacity_port_conflict_and_stale_plan(store, tmp_path):
    await seed(store, tmp_path)
    m = Manager(store)
    m.host = baseline()
    plan = m.validate(["a"])
    d = store.get("deployment", "a")
    store.put("deployment", d | {"reservation_mib": 16000})
    assert any("capacity" in e for e in m.validate(["a"])["errors"])
    with pytest.raises(Conflict, match="changed"):
        await m.activate(["a"], True, token=plan["plan_token"])
    store.put("deployment", d)
    with socket.socket() as s:
        s.bind(("127.0.0.1", d["port"]))
        assert any("occupied" in e for e in m.validate(["a"])["errors"])
    await m.close()


async def test_gateway_streaming_nonstream_and_unknown(tmp_path):
    app = create_app(tmp_path / "api")
    store, m = app.state.store, app.state.manager
    await seed(store, tmp_path)
    m.host = baseline()
    try:
        await m.activate(["a"], True)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as c:
            denied = await c.post("/api/settings", json={})
            assert denied.status_code == 403
            bad_origin = await c.get(
                "/api/status", headers={"Origin": "http://evil.test"}
            )
            assert bad_origin.status_code == 403
            response = await c.post(
                "/v1/chat/completions",
                json={"model": "a", "messages": [], "stream": True},
            )
            assert response.status_code == 200 and "[DONE]" in response.text
            response = await c.post(
                "/v1/chat/completions", json={"model": "a", "messages": []}
            )
            assert response.json()["usage"]["completion_tokens"] == 2
            assert not m.inflight["a"]
            rows = (await c.get("/api/history/requests")).json()
            assert len(rows) == 2 and any(r["data"]["ttft"] is not None for r in rows)
            response = await c.post(
                "/v1/chat/completions", json={"model": "missing", "messages": []}
            )
            assert response.status_code == 404
    finally:
        await m.close()


def test_catalog_and_supervisor_owned_flags():
    p = {"name": "demo", "config": {"ctx-size": 8192, "parallel": 2}, "catalog": {}}
    cat = normalize(p, "demo")
    assert cat["model"]["limit"]["context"] == 4096
    assert cat["model"]["cost"][0]["cache"] == {"read": 0, "write": 0}
    assert not cat["model"]["capabilities"]["tools"]
    p.update(raw_args=["--port=4444"])
    r = {
        "engine": "llama.cpp",
        "execution_kind": "native",
        "capabilities": {"formats": ["gguf"]},
    }
    assert any(
        "supervisor" in e
        for e in adapters.validate_profile(
            p, {"format": "gguf", "local_path": "a.gguf"}, r
        )
    )


async def test_concurrent_admission_cannot_overbook_explicit_reservations(
    store, tmp_path
):
    await seed(store, tmp_path)
    for ident in ("a", "b"):
        d = store.get("deployment", ident)
        store.put("deployment", d | {"reservation_mib": 8000})
    m = Manager(store)
    m.host = baseline()
    try:
        results = await asyncio.gather(
            m.activate(["a"], True), m.activate(["b"], True), return_exceptions=True
        )
        assert sum(isinstance(r, Conflict) for r in results) == 1
        assert sum(d["state"] == "READY" for d in store.list("deployment")) == 1
    finally:
        await m.close()


async def test_failed_group_restores_authorized_previous_deployment(store, tmp_path):
    await seed(store, tmp_path)
    m = Manager(store)
    m.host = baseline()
    try:
        await m.activate(["a"], True)
        d = store.get("deployment", "b")
        d["profile_snapshot"]["config"]["fail"] = True
        store.put("deployment", d)
        with pytest.raises(RuntimeError):
            await m.activate(["b"], True, authorized_stops=["a"])
        assert store.get("deployment", "a")["state"] == "READY"
        assert await m.ready(store.get("deployment", "a"))
        assert store.get("deployment", "b")["state"] == "FAILED"
    finally:
        await m.close()


async def test_runtime_drift_and_stale_pid_do_not_execute_or_kill(store, tmp_path):
    await seed(store, tmp_path)
    m = Manager(store)
    m.host = baseline()
    script = tmp_path / "runtime"
    script.write_text(script.read_text() + "\n# changed\n")
    with pytest.raises(Conflict, match="changed"):
        await m.activate(["a"], True)
    assert store.get("deployment", "a")["state"] == "FAILED"
    assert not m.owned({"pid": os.getpid(), "pid_started": 0})
    await m.close()


async def test_pinned_not_automatic_victim_of_on_demand(store, tmp_path):
    await seed(store, tmp_path)
    m = Manager(store)
    m.host = baseline()
    try:
        a = store.get("deployment", "a")
        store.put("deployment", a | {"reservation_mib": 9000})
        await m.activate(["a"], True)
        b = store.get("deployment", "b")
        store.put("deployment", b | {"residency": "on-demand", "reservation_mib": 9000})
        m.host["gpus"][0]["free_mib"] = 4000
        with pytest.raises(Conflict, match="capacity"):
            await m.acquire("b")
        assert store.get("deployment", "a")["state"] == "READY"
        assert await m.ready(store.get("deployment", "a"))
    finally:
        await m.close()


async def test_ui_revision_guard_and_model_catalog_contract(tmp_path):
    app = create_app(tmp_path / "api")
    store, m = app.state.store, app.state.manager
    await seed(store, tmp_path)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        status = (await client.get("/api/status")).json()
        client.headers["X-Menagerie-Token"] = status["csrf_token"]
        d = store.get("deployment", "a")
        store.put("deployment", d | {"residency": "on-demand"})
        rows = (await client.get("/v1/models")).json()["data"]
        assert len(rows) == 1 and rows[0]["menagerie"]["catalog"]["version"] == 2
        # An unloaded enabled deployment is discoverable; a disabled
        # on-demand deployment is not, even though its profile and weights exist.
        other = store.get("deployment", "b")
        store.put("deployment", other | {"residency": "on-demand", "enabled": False})
        assert [
            row["id"] for row in (await client.get("/v1/models")).json()["data"]
        ] == ["a"]
        assert rows[0]["menagerie"]["catalog"]["model"]["cost"][0]["cache"]["read"] == 0
        exported = (
            await client.post("/api/integration/opencode/export", json={})
        ).json()
        config = json.loads(Path(exported["path"]).read_text())
        assert config["providers"]["menagerie"]["models"]["a"]["modelID"] == "a"
        bad = await client.post(
            "/api/profiles?expected=0",
            json={
                "id": "a",
                "name": "a",
                "artifact_id": "weights",
                "runtime_id": "runtime",
                "config": {},
                "raw_args": [],
                "catalog": {},
            },
        )
        assert bad.status_code == 400
    await m.close()


async def test_on_demand_idle_unload_and_reload(store, tmp_path, monkeypatch):
    await seed(store, tmp_path)
    d = store.get("deployment", "a")
    store.put("deployment", d | {"residency": "on-demand", "idle_timeout": 1})
    m = Manager(store)
    m.host = baseline()
    monkeypatch.setattr("controlplane.telemetry.sample", baseline)
    stopped = asyncio.Event()
    original = m._stop

    async def observed_stop(*args, **kwargs):
        await original(*args, **kwargs)
        stopped.set()

    monkeypatch.setattr(m, "_stop", observed_stop)
    try:
        first = await m.acquire("a")
        assert first["state"] == "READY"
        m.release(first)
        m.last_use["a"] -= 10
        m.loop_task = asyncio.create_task(m.monitor())
        await asyncio.wait_for(stopped.wait(), 5)
        assert store.get("deployment", "a")["state"] == "STOPPED"
        second = await m.acquire("a")
        assert second["pid"] != first["pid"] and second["state"] == "READY"
        m.release(second)
    finally:
        await m.close()


async def test_pressure_evicts_only_authorized_evictable(store, tmp_path, monkeypatch):
    await seed(store, tmp_path)
    d = store.get("deployment", "a")
    store.put("deployment", d | {"residency": "evictable", "allow_eviction": True})
    m = Manager(store)
    m.host = baseline()
    pressure = baseline()
    pressure["gpus"][0]["free_mib"] = 1000
    monkeypatch.setattr("controlplane.telemetry.sample", lambda: pressure)
    stopped = asyncio.Event()
    original = m._stop

    async def observed_stop(*args, **kwargs):
        await original(*args, **kwargs)
        stopped.set()

    monkeypatch.setattr(m, "_stop", observed_stop)
    try:
        await m.activate(["a", "b"], True)
        m.loop_task = asyncio.create_task(m.monitor())
        await asyncio.wait_for(stopped.wait(), 5)
        assert store.get("deployment", "a")["state"] == "STOPPED"
        assert store.get("deployment", "b")["state"] == "READY"
    finally:
        await m.close()


async def test_lifecycle_separates_deployed_serving_and_running(tmp_path):
    app = create_app(tmp_path / "api")
    store = app.state.store
    await seed(store, tmp_path)
    # b is a deployed on-demand alias; c is a retained (not deployed) record.
    b = store.get("deployment", "b")
    store.put("deployment", b | {"residency": "on-demand"})
    b = store.get("deployment", "b")
    store.put(
        "deployment", b | {"id": "c", "alias": "c", "port": port(), "enabled": False}
    )
    store.put("group", {"id": "pair", "name": "pair", "deployment_ids": ["a"]})
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        client.headers["X-Menagerie-Token"] = (await client.get("/api/status")).json()[
            "csrf_token"
        ]
        rows = {
            d["id"]: d for d in (await client.get("/api/registry/deployments")).json()
        }
        assert rows["a"]["lifecycle"] == {
            "deployed": True,
            "serving": False,
            "runtime": "held",
            "failure": None,
            "last_stop_reason": None,
        }
        assert (
            rows["b"]["lifecycle"]["runtime"] == "idle"
            and rows["b"]["lifecycle"]["serving"]
        )
        assert (
            rows["c"]["lifecycle"]["runtime"] == "not-deployed"
            and not rows["c"]["lifecycle"]["serving"]
        )
        assert [r["id"] for r in (await client.get("/v1/models")).json()["data"]] == [
            "b"
        ]
        snapshot = rows["c"]["profile_snapshot"]
        assert (
            await client.post("/api/deployments/c/enabled", json={"enabled": True})
        ).status_code == 200
        rows = {
            d["id"]: d for d in (await client.get("/api/registry/deployments")).json()
        }
        assert rows["c"]["lifecycle"]["deployed"] and rows["c"]["lifecycle"]["serving"]
        assert rows["c"]["profile_snapshot"] == snapshot
        store.put("deployment", store.get("deployment", "a") | {"state": "READY"})
        rows = {
            d["id"]: d for d in (await client.get("/api/registry/deployments")).json()
        }
        assert (
            rows["a"]["lifecycle"]["runtime"] == "running"
            and rows["a"]["lifecycle"]["serving"]
        )
        assert (
            await client.post("/api/deployments/a/enabled", json={"enabled": False})
        ).status_code == 409
