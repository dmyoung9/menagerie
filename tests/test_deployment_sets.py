import asyncio
import time

import httpx
import pytest

from controlplane import deployment_sets
from controlplane.api import create_app
from controlplane.manager import Manager, Conflict
from test_controlplane import seed, baseline, port


def link(store, ids=("a", "b"), **policy):
    value = {"id": "pair", "name": "Pair", "member_ids": list(ids), "residency": "on-demand", "priority": 50, "idle_timeout": 1, "allow_eviction": True, "enabled": True, "queue_timeout": 5} | policy
    with store.transaction() as c:
        saved = store.put("deployment_set", value, c=c)
        for ident in ids:
            d = store.get("deployment", ident, c)
            store.put("deployment", d | {k: value[k] for k in deployment_sets.POLICY_KEYS}, c=c)
    return saved


async def setup(tmp_path):
    app = create_app(tmp_path / "state")
    await seed(app.state.store, tmp_path)
    app.state.manager.host = baseline()
    return app, app.state.store, app.state.manager


def third(store):
    d = store.get("deployment", "a")
    p = store.put("profile", d["profile_snapshot"] | {"id": "c", "name": "c", "catalog": {}})
    store.put("deployment", d | {"id": "c", "name": "Large", "alias": "c", "port": port(), "profile_id": p["id"], "profile_snapshot": p, "residency": "on-demand", "allow_eviction": True})


async def test_either_alias_loads_whole_unit_and_member_stop_stops_all(tmp_path):
    _, store, m = await setup(tmp_path)
    link(store)
    try:
        a, b = await asyncio.gather(m.acquire("a"), m.acquire("b"))
        assert all(d["state"] == "READY" for d in store.list("deployment"))
        assert len(store.list("session")) == 2
        m.release(a)
        m.release(b)
        await m.stop("a")
        assert all(d["state"] == "STOPPED" for d in store.list("deployment"))
    finally:
        await m.close()


async def test_shared_idle_timer_waits_for_every_member(tmp_path):
    _, store, m = await setup(tmp_path)
    link(store)
    try:
        a = await m.acquire("a")
        m.last_use.update(a=time.monotonic() - 10, b=time.monotonic() - 10)
        async with m.lock:
            await m.unload_idle()
        assert all(d["state"] == "READY" for d in store.list("deployment"))
        m.release(a)
        async with m.lock:
            await m.unload_idle()
        assert all(d["state"] == "READY" for d in store.list("deployment"))
        m.last_use.update(a=time.monotonic() - 10, b=time.monotonic() - 10)
        async with m.lock:
            await m.unload_idle()
        assert all(d["state"] == "STOPPED" for d in store.list("deployment"))
    finally:
        await m.close()


async def test_bidirectional_switch_evicts_entire_units(tmp_path):
    _, store, m = await setup(tmp_path)
    link(store)
    third(store)
    try:
        large = await m.acquire("c")
        m.release(large)
        m.host["gpus"][0]["free_mib"] = 3000
        small = await m.acquire("b")
        assert store.get("deployment", "c")["state"] == "STOPPED"
        assert all(store.get("deployment", i)["state"] == "READY" for i in ("a", "b"))
        m.release(small)
        large = await m.acquire("c")
        assert all(store.get("deployment", i)["state"] == "STOPPED" for i in ("a", "b"))
        assert store.get("deployment", "c")["state"] == "READY"
        m.release(large)
    finally:
        await m.close()


async def test_switch_waits_without_blocking_nested_requests(tmp_path):
    _, store, m = await setup(tmp_path)
    link(store)
    third(store)
    try:
        large = await m.acquire("c")
        m.host["gpus"][0]["free_mib"] = 3000
        switch = asyncio.create_task(m.acquire("a"))
        await asyncio.sleep(.05)
        assert not switch.done()
        assert store.get("deployment", "c")["state"] == "READY"
        nested = await asyncio.wait_for(m.acquire("c"), 1)
        m.release(nested)
        assert not switch.done()
        m.release(large)
        a = await switch
        assert all(store.get("deployment", i)["state"] == "READY" for i in ("a", "b"))
        switch_back = asyncio.create_task(m.acquire("c"))
        await asyncio.sleep(.05)
        assert not switch_back.done()
        nested_member = await asyncio.wait_for(m.acquire("b"), 1)
        assert all(store.get("deployment", i)["state"] == "READY" for i in ("a", "b"))
        m.release(nested_member)
        m.release(a)
        c = await switch_back
        assert all(store.get("deployment", i)["state"] == "STOPPED" for i in ("a", "b"))
        m.release(c)
    finally:
        await m.close()


async def test_manual_unload_waits_and_never_unloads_only_idle_sibling(tmp_path):
    _, store, m = await setup(tmp_path)
    link(store)
    try:
        a = await m.acquire("a")
        stopping = asyncio.create_task(m.stop("pair"))
        await asyncio.sleep(.05)
        assert not stopping.done()
        assert store.get("deployment", "b")["state"] == "READY"
        m.release(a)
        await stopping
        assert all(d["state"] == "STOPPED" for d in store.list("deployment"))
    finally:
        await m.close()


async def test_partial_launch_failure_rolls_back_all_new_members_and_restores_predecessor(tmp_path):
    _, store, m = await setup(tmp_path)
    link(store)
    third(store)
    failed = store.get("deployment", "b")
    failed["profile_snapshot"]["config"]["fail"] = True
    store.put("deployment", failed)
    try:
        large = await m.acquire("c")
        m.release(large)
        m.host["gpus"][0]["free_mib"] = 3000
        with pytest.raises(RuntimeError, match="exited"):
            await m.acquire("a")
        assert all(store.get("deployment", i)["state"] == "FAILED" for i in ("a", "b"))
        assert all(store.get("deployment", i)["reservation_active"] == 0 for i in ("a", "b"))
        assert store.get("deployment", "c")["state"] == "READY"
    finally:
        await m.close()


async def test_plan_expands_full_unit_and_pinned_units_are_not_automatic_victims(tmp_path):
    _, store, m = await setup(tmp_path)
    link(store, residency="pinned")
    third(store)
    try:
        await m.activate(["pair"])
        m.host["gpus"][0]["free_mib"] = 3000
        assert m.automatic_stops(["c"]) == []
        plan = m.validate(["c"], ["a"])
        assert set(plan["stops"]) == {"a", "b"}
        assert set(m.validate(["a"])["estimates"]) == {"a", "b"}
    finally:
        await m.close()


async def test_new_deployment_owns_shared_policy_and_ignores_unused_group_records(tmp_path):
    app, store, m = await setup(tmp_path)
    group = store.put("group", {"id": "old-group", "name": "Pair", "deployment_ids": ["a", "b"], "authorized_stops": []})
    original = {d["id"]: d for d in store.list("deployment")}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            s = (await client.get("/api/status")).json()
            assert len(s["serving_deployments"]) == 2
            headers = {"X-Menagerie-Token": s["csrf_token"]}
            body = {"name": "Pair", "member_ids": ["a", "b"], "residency": "on-demand", "allow_eviction": True}
            response = await client.post("/api/deployment-sets", json=body, headers=headers)
            assert response.status_code == 200, response.text
            created = response.json()
            units = (await client.get("/api/serving-deployments")).json()
            assert len(units) == 1 and len(units[0]["members"]) == 2
            for d in store.list("deployment"):
                assert d["alias"] == original[d["id"]]["alias"]
                assert d["profile_snapshot"] == original[d["id"]]["profile_snapshot"]
                assert d["residency"] == "on-demand"
            overlap = await client.post("/api/deployment-sets", json=body, headers=headers)
            assert overlap.status_code == 409
            split_enable = await client.post("/api/deployments/a/enabled", json={"enabled": False}, headers=headers)
            assert split_enable.status_code == 409
            enable = await client.post(f"/api/serving-deployments/{created['id']}/enabled", json={"enabled": False}, headers=headers)
            assert enable.status_code == 200
            assert not any(d["enabled"] for d in store.list("deployment"))
            for path in ("/api/groups", "/api/groups/old-group/validate", "/api/groups/old-group/activate", "/api/groups/old-group/stop", "/api/groups/old-group/convert?expected=1"):
                assert (await client.post(path, json=body, headers=headers)).status_code == 404
            assert (await client.get("/api/registry/groups")).status_code == 404
            assert store.get("group", group["id"]) == group
    finally:
        await m.close()


async def test_partial_failure_is_degraded_and_pinned_catalog_never_advertises_half_pair(tmp_path):
    app, store, m = await setup(tmp_path)
    link(store, residency="pinned")
    for ident, value in (("a", "READY"), ("b", "FAILED")):
        store.put("deployment", store.get("deployment", ident) | {"state": value, "failure_reason": "Engine exited" if value == "FAILED" else None})
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            unit = (await client.get("/api/serving-deployments")).json()[0]
            assert unit["state"] == "DEGRADED"
            assert "Engine exited" in unit["lifecycle"]["failure"]
            assert (await client.get("/v1/models")).json()["data"] == []
    finally:
        # These synthetic states do not own any OS processes.
        for d in store.list("deployment"):
            store.put("deployment", d | {"state": "STOPPED"})
        await m.close()


async def test_membership_change_invalidates_review_token(tmp_path):
    _, store, m = await setup(tmp_path)
    try:
        plan = m.validate(["a"])
        link(store)
        with pytest.raises(Conflict, match="plan changed"):
            await m.activate(["a"], token=plan["plan_token"])
        assert store.list("session") == []
    finally:
        await m.close()


async def test_per_gpu_planning_does_not_evict_an_unrelated_gpu(tmp_path):
    _, store, m = await setup(tmp_path)
    link(store)
    b = store.get("deployment", "b")
    store.put("deployment", b | {"gpu": 1})
    third(store)
    c = store.get("deployment", "c")
    store.put("deployment", c | {"state": "READY", "reservation_active": 6000})
    m.host["gpus"].append({"index": 1, "total_mib": 16384, "free_mib": 3000, "used_mib": 13384, "temperature": 35})
    try:
        assert m.automatic_stops(["pair"]) == []
        store.put("deployment", store.get("deployment", "c") | {"gpu": 1})
        assert m.automatic_stops(["pair"]) == ["c"]
    finally:
        store.put("deployment", store.get("deployment", "c") | {"state": "STOPPED"})
        await m.close()


async def test_live_membership_changes_are_rejected_and_separation_preserves_members(tmp_path):
    app, store, m = await setup(tmp_path)
    try:
        await m.activate(["a"])
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            headers = {"X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]}
            body = {"name": "Pair", "member_ids": ["a", "b"], "residency": "on-demand"}
            response = await client.post("/api/deployment-sets", json=body, headers=headers)
            assert response.status_code == 409
            assert store.list("deployment_set") == []
            assert store.get("deployment", "a")["state"] == "READY"
            await m.stop("a")
            response = await client.post("/api/deployment-sets", json=body, headers=headers)
            unit = response.json()
            assert response.status_code == 200, response.text
            changed = await client.post(f"/api/deployment-sets?expected={unit['revision']}", json=body | {"id": unit["id"], "idle_timeout": 900}, headers=headers)
            assert changed.status_code == 200, changed.text
            assert "source_group_id" not in store.get("deployment_set", unit["id"])
            separated = await client.post(f"/api/deployment-sets/{unit['id']}/dissolve?expected={changed.json()['revision']}", json={}, headers=headers)
            assert separated.status_code == 200
            assert len(deployment_sets.units(store)) == 2
            assert all(d["idle_timeout"] == 900 for d in store.list("deployment"))
            assert {d["alias"] for d in store.list("deployment")} == {"a", "b"}
    finally:
        await m.close()


async def wait_job(store, ident):
    async with asyncio.timeout(15):
        while True:
            job = store.get("job", ident)
            if job["state"] not in {"QUEUED", "RUNNING"}:
                assert job["state"] == "SUCCEEDED", job.get("error")
                return job
            await asyncio.sleep(.02)


async def test_public_api_launch_and_member_stop_control_the_complete_deployment(tmp_path):
    app, store, m = await setup(tmp_path)
    link(store)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            headers = {"X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]}
            unreviewed = await client.post("/api/serving-deployments/pair/start", json={}, headers=headers)
            assert unreviewed.status_code == 409
            plan = (await client.post("/api/serving-deployments/pair/validate", json={}, headers=headers)).json()
            assert set(plan["estimates"]) == {"a", "b"}
            launched = await client.post("/api/serving-deployments/pair/start", json={"plan_token": plan["plan_token"]}, headers=headers)
            assert launched.status_code == 200, launched.text
            await wait_job(store, launched.json()["id"])
            assert all(d["state"] == "READY" for d in store.list("deployment"))
            assert {r["id"] for r in (await client.get("/v1/models")).json()["data"]} == {"a", "b"}
            a = await m.acquire("a")
            stopped = await client.post("/api/deployments/b/stop", json={}, headers=headers)
            await asyncio.sleep(.05)
            assert all(d["state"] == "READY" for d in store.list("deployment"))
            b = await asyncio.wait_for(m.acquire("b"), 1)
            m.release(b)
            m.release(a)
            await wait_job(store, stopped.json()["id"])
            assert all(d["state"] == "STOPPED" for d in store.list("deployment"))
            activation = store.list("activation")[0]
            restored = await client.post(f"/api/history/activations/{activation['id']}/restore", json={}, headers=headers)
            assert restored.status_code == 200, restored.text
            assert len(restored.json()["member_ids"]) == 2
            restored_unit = m.unit(restored.json()["id"])
            assert not restored_unit["enabled"]
            assert all(d["state"] == "STOPPED" for d in restored_unit["members"])
    finally:
        await m.close()


async def test_pressure_never_splits_a_deployment_or_unloads_a_busy_member(tmp_path, monkeypatch):
    from controlplane import telemetry
    _, store, m = await setup(tmp_path)
    link(store, residency="evictable")
    try:
        await m.activate(["pair"])
        a = await m.acquire("a")
        def pressure():
            value = baseline()
            value["ts"] = time.time()
            value["gpus"][0]["free_mib"] = 1000
            return value
        monkeypatch.setattr(telemetry, "sample", pressure)
        m.loop_task = asyncio.create_task(m.monitor())
        await asyncio.sleep(.1)
        assert all(d["state"] == "READY" for d in store.list("deployment"))
        m.release(a)
        async with asyncio.timeout(6):
            while any(d["state"] != "STOPPED" for d in store.list("deployment")):
                await asyncio.sleep(.05)
    finally:
        await m.close()


async def test_pinned_restart_restores_whole_unit_but_manual_unload_stays_unloaded(tmp_path, monkeypatch):
    from controlplane import telemetry
    _, store, m = await setup(tmp_path)
    link(store, residency="pinned")
    monkeypatch.setattr(telemetry, "sample", lambda: baseline() | {"ts": time.time()})
    await m.activate(["pair"])
    await m.close()
    restarted = Manager(store)
    try:
        await restarted.start()
        async with asyncio.timeout(8):
            while not all(d["state"] == "READY" for d in store.list("deployment")):
                await asyncio.sleep(.05)
        await restarted.stop("pair")
    finally:
        await restarted.close()
    again = Manager(store)
    try:
        await again.start()
        await asyncio.sleep(.05)
        assert all(d["state"] == "STOPPED" for d in store.list("deployment"))
        assert not any(d.get("resume_on_boot") for d in store.list("deployment"))
    finally:
        await again.close()


async def test_switch_timeout_does_not_interrupt_busy_predecessor(tmp_path):
    _, store, m = await setup(tmp_path)
    link(store, queue_timeout=1)
    third(store)
    store.put("deployment", store.get("deployment", "c") | {"queue_timeout": 5})
    try:
        c = await m.acquire("c")
        m.host["gpus"][0]["free_mib"] = 3000
        with pytest.raises(TimeoutError):
            await m.acquire("a")
        assert store.get("deployment", "c")["state"] == "READY"
        assert all(store.get("deployment", i)["state"] == "STOPPED" for i in ("a", "b"))
        assert m.waiting == 0
        m.release(c)
    finally:
        await m.close()
