"""Model-first user outcomes, isolated from processes and inference."""

import asyncio
import time

import httpx
import pytest
from test_controlplane import baseline, port, seed

from controlplane import apply_ops, model_setup, queued_apply
from controlplane.api import create_app
from controlplane.manager import Conflict


async def test_process_pool_addition_review_apply_and_selected_load(tmp_path):
    app = create_app(tmp_path / "state")
    manager, store = app.state.manager, app.state.store
    await seed(store, tmp_path)
    manager.host = baseline()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        client.headers["X-Menagerie-Token"] = (await client.get("/api/status")).json()[
            "csrf_token"
        ]

        def setup_draft(name):
            return draft(name, port()) | {
                "configuration": {
                    "name": name,
                    "artifact_id": "weights",
                    "runtime_id": "runtime",
                    "config": {},
                },
                "queue_timeout": 10,
            }

        try:
            first = await save(client, setup_draft("Alpha"))
            key = manager.unit(first["id"])["id"]
            assert manager.unit(key)["engine_pool"]
            plan = manager.plan([first["id"]])
            assert plan["errors"] == []
            await manager.load_model(first["id"], plan["plan_token"])
            owner = store.get("deployment", first["id"])
            second = await save(client, setup_draft("Beta"))
            assert second["changes_pending"]
            assert store.get("deployment", first["id"])["pid"] == owner["pid"]
            review = await client.post(
                f"/api/deployments/{second['id']}/review-apply", json={}
            )
            assert review.status_code == 200, review.text
            plan = review.json()
            assert plan["errors"] == []
            apply_ops.save_op(
                store,
                queued_apply.request_apply(
                    apply_ops.find_op(store, key),
                    time.time(),
                    plan["plan_token"],
                    plan["scope_fingerprint"],
                ),
            )
            await manager.apply_desired(key, lambda _: None)
            assert model_setup.desired(store, key) is None
            assert set(manager.unit(key)["member_ids"]) == {first["id"], second["id"]}
            plan = manager.plan([second["id"]])
            result = await manager.load_model(second["id"], plan["plan_token"])
            assert result["residency"] == "resident"
            assert {
                r["id"] for r in (await client.get("/v1/models")).json()["data"]
            } == {"alpha", "beta"}
            assert store.list("request") == []
            for row in (first, second):
                live = store.get("deployment", row["id"])
                await save(
                    client,
                    setup_draft(row["name"])
                    | {"id": row["id"], "port": live["port"], "enabled": False},
                    live["revision"],
                )
            plan = model_setup.plan(manager, key)
            assert plan["errors"] == []
            apply_ops.save_op(
                store,
                queued_apply.request_apply(
                    apply_ops.find_op(store, key),
                    time.time(),
                    plan["plan_token"],
                    plan["scope_fingerprint"],
                ),
            )
            await manager.apply_desired(key, lambda _: None)
            assert all(
                m["state"] == "STOPPED" and not m["enabled"]
                for m in manager.unit(key)["members"]
            )
            assert (await client.get("/v1/models")).json()["data"] == []
            assert apply_ops.find_op(store, key).state == "applied"
        finally:
            await manager.close()


@pytest.fixture
async def setup(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put(
        "artifact",
        {
            "id": "weights",
            "name": "Weights",
            "format": "gguf",
            "local_path": "/unused.gguf",
        },
    )
    store.put(
        "runtime",
        {
            "id": "engine",
            "name": "Engine",
            "engine": "llama.cpp",
            "execution_kind": "native",
            "executable": "/unused",
            "capabilities": {
                "formats": ["gguf"],
                "flags": ["ctx-size"],
                "mechanisms": {"router": True},
            },
        },
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        client.headers["X-Menagerie-Token"] = (await client.get("/api/status")).json()[
            "csrf_token"
        ]
        yield app.state.manager, store, client
    await app.state.manager.client.aclose()


def draft(name, port):
    return {
        "name": name,
        "alias": name.lower(),
        "port": port,
        "runtime_assignment": "automatic",
        "allow_eviction": True,
        "configuration": {
            "name": name,
            "artifact_id": "weights",
            "runtime_id": "engine",
            "config": {},
        },
    }


async def save(client, data, revision=None):
    response = await client.post(
        "/api/model-setups" + (f"?expected={revision}" if revision is not None else ""),
        json=data,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_automatic_assignment_and_busy_addition_preserve_live_pool(setup):
    manager, store, client = setup
    first = await save(client, draft("Alpha", 8130))
    pool = manager.unit(first["id"])
    assert pool["engine_pool"]
    second = await save(client, draft("Beta", 8131))
    assert manager.unit(second["id"])["id"] == pool["id"]
    for ident in (first["id"], second["id"]):
        store.put("deployment", store.get("deployment", ident) | {"state": "READY"})
    before = manager.unit(first["id"])
    added = await save(client, draft("Gamma", 8132))
    assert added["changes_pending"]
    assert manager.unit(first["id"]) == before
    assert not store.get("deployment", added["id"])["enabled"]
    pending = (await client.get(f"/api/deployments/{added['id']}/pending")).json()
    assert pending["pending"] and set(pending["affected"]) == {"Alpha", "Beta", "Gamma"}
    assert store.list("job") == []


async def test_active_rename_keeps_live_alias_and_discard_preserves_runtime(setup):
    manager, store, client = setup
    first = await save(client, draft("Alpha", 8130))
    live = store.put("deployment", first | {"state": "READY"})
    changed = await save(
        client, draft("Renamed", 8130) | {"id": first["id"]}, live["revision"]
    )
    assert changed["alias"] == "renamed" and changed["active_alias"] == "alpha"
    assert store.get("deployment", first["id"])["alias"] == "alpha"
    response = await client.post(f"/api/deployments/{first['id']}/discard", json={})
    assert response.status_code == 200, response.text
    assert store.get("deployment", first["id"])["state"] == "READY"
    assert store.get("deployment", first["id"])["alias"] == "alpha"


async def test_incompatible_and_legacy_setups_stay_separate(setup):
    manager, store, client = setup
    dedicated = await save(
        client, draft("Legacy", 8130) | {"runtime_assignment": "dedicated"}
    )
    automatic = await save(client, draft("Automatic", 8131))
    pinned = await save(client, draft("Pinned", 8132) | {"residency": "pinned"})
    assert not manager.unit(dedicated["id"])["multi_model"]
    assert not manager.unit(pinned["id"])["multi_model"]
    assert manager.unit(automatic["id"])["member_ids"] == [automatic["id"]]


async def test_cancel_during_drain_never_stops_live_model(setup, monkeypatch):
    manager, store, client = setup
    first = await save(client, draft("Alpha", 8130))
    live = store.put("deployment", first | {"state": "READY"})
    await save(client, draft("Renamed", 8130) | {"id": first["id"]}, live["revision"])
    key = manager.unit(first["id"])["id"]
    monkeypatch.setattr(
        manager, "plan", lambda ids: {"errors": [], "stops": [], "plan_token": "base"}
    )
    plan = model_setup.plan(manager, key)
    op = apply_ops.find_op(store, key)
    apply_ops.save_op(
        store,
        queued_apply.request_apply(
            op, time.time(), plan["plan_token"], plan["scope_fingerprint"]
        ),
    )
    manager.inflight[first["id"]] = 1
    waiting = asyncio.Event()
    task = asyncio.create_task(manager.apply_desired(key, lambda _: waiting.set()))
    await asyncio.wait_for(waiting.wait(), 2)
    assert key in manager.apply_holds
    response = await client.post(f"/api/deployments/{first['id']}/cancel", json={})
    assert response.status_code == 200
    with pytest.raises(Conflict, match="cancelled"):
        await task
    assert key not in manager.apply_holds
    assert store.get("deployment", first["id"])["state"] == "READY"
    assert model_setup.desired(store, key)


@pytest.mark.parametrize("change", ["consent", "timeout", "launch"])
async def test_failed_application_preserves_desired_configuration(
    setup, monkeypatch, change
):
    manager, store, client = setup
    first = await save(client, draft("Alpha", 8130))
    live = store.put("deployment", first | {"state": "READY"})
    await save(client, draft("Renamed", 8130) | {"id": first["id"]}, live["revision"])
    key = manager.unit(first["id"])["id"]
    monkeypatch.setattr(
        manager, "plan", lambda ids: {"errors": [], "stops": [], "plan_token": "base"}
    )
    plan = model_setup.plan(manager, key)
    op = queued_apply.request_apply(
        apply_ops.find_op(store, key),
        time.time(),
        plan["plan_token"],
        plan["scope_fingerprint"],
    )
    if change == "timeout":
        op = op._with(drain_deadline=time.time() - 1)
    apply_ops.save_op(store, op)
    if change == "consent":
        live = store.get("deployment", first["id"])
        store.put("deployment", live | {"priority": 12})
    stopped = []

    async def stop(ident, reason, force=False):
        stopped.append(ident)
        for member in manager.unit(ident)["members"]:
            store.put("deployment", member | {"state": "STOPPED"})

    async def fail(*args, **kwargs):
        raise Conflict("Synthetic launch failure")

    monkeypatch.setattr(manager, "_stop_unit_locked", stop)
    monkeypatch.setattr(manager, "_activate_locked", fail)
    with pytest.raises(Conflict):
        await manager.apply_desired(key, lambda _: None)
    assert model_setup.desired(store, key)
    assert store.get("deployment", first["id"])["alias"] == "alpha"
    assert key not in manager.apply_holds
    if change != "launch":
        assert stopped == []
    assert apply_ops.find_op(store, key).state in {"failed", "expired"}


async def test_load_waits_for_selected_member_residency_without_inference(
    setup, monkeypatch
):
    manager, store, client = setup
    first = await save(client, draft("Alpha", 8130))

    async def activate(*args, **kwargs):
        assert kwargs["token"] == "reviewed"
        store.put(
            "deployment", store.get("deployment", first["id"]) | {"state": "READY"}
        )

    monkeypatch.setattr(manager, "activate", activate)
    observed = []

    async def ready(member):
        observed.append(member["id"])
        store.put(
            "runtime_observation",
            {
                "id": member["id"],
                "session_id": member.get("session_id"),
                "facts": {
                    "residency": "resident" if len(observed) == 2 else "unloaded"
                },
            },
        )
        return True

    monkeypatch.setattr(manager, "ready", ready)
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={})

    await manager.client.aclose()
    manager.client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    result = await manager.load_model(first["id"], "reviewed")
    assert result["residency"] == "resident" and len(observed) == 2
    assert [r.url.path for r in requests] == ["/models/load"]
    assert manager.inflight[first["id"]] == 0


async def test_reviewed_apply_updates_routing_and_clears_pending_only_after_readiness(
    setup, monkeypatch
):
    manager, store, client = setup
    first = await save(client, draft("Alpha", 8130))
    live = store.put("deployment", first | {"state": "READY"})
    await save(client, draft("Renamed", 8130) | {"id": first["id"]}, live["revision"])
    key = manager.unit(first["id"])["id"]
    assert [r["id"] for r in (await client.get("/v1/models")).json()["data"]] == [
        "alpha"
    ]
    monkeypatch.setattr(
        manager, "plan", lambda ids: {"errors": [], "stops": [], "plan_token": "base"}
    )
    plan = model_setup.plan(manager, key)
    op = queued_apply.request_apply(
        apply_ops.find_op(store, key),
        time.time(),
        plan["plan_token"],
        plan["scope_fingerprint"],
    )
    apply_ops.save_op(store, op)

    async def stop(ident, reason, force=False):
        for member in manager.unit(ident)["members"]:
            store.put("deployment", member | {"state": "STOPPED"})

    async def activate(ids, **kwargs):
        assert model_setup.desired(store, key)
        assert apply_ops.find_op(store, key).state == "applying"
        for ident in ids:
            store.put("deployment", store.get("deployment", ident) | {"state": "READY"})

    monkeypatch.setattr(manager, "_stop_unit_locked", stop)
    monkeypatch.setattr(manager, "_activate_locked", activate)
    await manager.apply_desired(key, lambda _: None)
    assert model_setup.desired(store, key) is None
    assert apply_ops.find_op(store, key).state == "applied"
    assert not store.list("apply_recovery")
    assert [r["id"] for r in (await client.get("/v1/models")).json()["data"]] == [
        "renamed"
    ]


async def test_member_disable_keeps_neighbor_available_and_runtime_running(setup):
    manager, store, client = setup
    first = await save(client, draft("Alpha", 8130))
    second = await save(client, draft("Beta", 8131))
    for row in (first, second):
        store.put("deployment", row | {"state": "READY"})
    response = await client.post(
        f"/api/deployments/{first['id']}/enabled", json={"enabled": False}
    )
    assert response.status_code == 200
    assert all(m["state"] == "READY" for m in manager.unit(first["id"])["members"])
    assert [r["id"] for r in (await client.get("/v1/models")).json()["data"]] == [
        "beta"
    ]
