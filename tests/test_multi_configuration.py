"""Multi-model settings are private instances of reusable installed artifacts."""
from copy import deepcopy

import httpx

from controlplane.api import create_app
from test_controlplane import seed, baseline, port


async def test_multi_configuration_reuse_edit_rollback_and_membership(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put("artifact", {"id": "weights", "name": "Gemma", "format": "gguf", "local_path": "/unused.gguf"})
    store.put("runtime", {"id": "engine", "name": "Engine", "engine": "llama.cpp", "execution_kind": "native", "executable": "/unused", "capabilities": {"formats": ["gguf"], "flags": ["ctx-size"]}})

    def member(alias, port):
        return {"name": alias, "alias": alias, "port": port, "configuration": {"name": alias, "artifact_id": "weights", "runtime_id": "engine", "config": {"ctx-size": 8192}}}

    def draft(unit):
        return {"id": unit["id"], "name": unit["name"], "members": [member(m["alias"], m["port"]) | {"id": m["id"]} for m in unit["members"]]}

    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            headers = {"X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]}
            async def save(body, expected=None):
                return await client.post("/api/deployment-sets" + (f"?expected={expected}" if expected is not None else ""), json=body, headers=headers)
            async def unit(ident):
                return next(u for u in (await client.get("/api/serving-deployments")).json() if u["id"] == ident)
            a = await save({"name": "Pair A", "members": [member("a-gemma", 8120), member("a-other", 8121)]})
            assert a.status_code == 200, a.text
            a = await unit(a.json()["id"])
            b = await save({"name": "Pair B", "members": [member("b-gemma", 8122), member("b-other", 8123)]})
            assert b.status_code == 200, b.text
            b = await unit(b.json()["id"])
            assert set(a["member_ids"]).isdisjoint(b["member_ids"])
            assert len({m["profile_id"] for u in (a, b) for m in u["members"]}) == 4
            assert all(m["profile_snapshot"]["artifact_id"] == "weights" for u in (a, b) for m in u["members"])

            changed = draft(a)
            changed["members"][0]["name"] = "Gemma renamed"
            changed["members"][0]["configuration"]["config"]["ctx-size"] = 32768
            changed.update(idle_timeout=900)
            response = await save(changed, a["revision"])
            assert response.status_code == 200, response.text
            a = await unit(a["id"])
            assert a["members"][0]["profile_snapshot"]["config"]["ctx-size"] == 32768
            assert all(m["idle_timeout"] == 900 for m in a["members"])
            assert await unit(b["id"]) == b
            catalog = (await client.get("/v1/models")).json()["data"]
            assert next(m for m in catalog if m["id"] == "a-gemma")["menagerie"]["catalog"]["model"]["name"] == "Gemma renamed"

            before = {k: store.list(k) for k in ("profile", "deployment", "deployment_set")}
            invalid = deepcopy(changed)
            invalid["members"].append(member("b-gemma", 8124))  # late failure must roll back earlier edits
            assert (await save(invalid, a["revision"])).status_code == 409
            assert (await save(changed, 0)).status_code >= 400
            steal = deepcopy(changed)
            steal["members"][0]["id"] = b["member_ids"][0]
            assert (await save(steal, a["revision"])).status_code == 409
            assert {k: store.list(k) for k in before} == before

            store.put("deployment", store.get("deployment", a["member_ids"][0]) | {"state": "READY"}, historical=False)
            assert (await save(changed, a["revision"])).status_code == 409
            store.put("deployment", store.get("deployment", a["member_ids"][0]) | {"state": "STOPPED"}, historical=False)
            changed["members"] = changed["members"][:1] + [member("a-new", 8124)]
            assert (await save(changed, a["revision"])).status_code == 200
            detached = store.get("deployment", a["member_ids"][1])
            assert detached["enabled"] is False
            assert detached["state"] == "STOPPED"
            assert store.list("job") == []
    finally:
        await app.state.manager.close()


async def test_reused_weights_have_independent_serving_lifecycles(tmp_path):
    app = create_app(tmp_path / "state")
    store, manager = app.state.store, app.state.manager
    await seed(store, tmp_path)
    manager.host = baseline()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            headers = {"X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]}
            units = []
            for name in ("one", "two"):
                members = [{"name": f"{name}-{i}", "alias": f"{name}-{i}", "port": port(), "reservation_mib": 1000,
                            "configuration": {"name": "Gemma", "artifact_id": "weights", "runtime_id": "runtime"}} for i in range(2)]
                response = await client.post("/api/deployment-sets", json={"name": name, "residency": "on-demand", "allow_uncertain": True, "members": members}, headers=headers)
                assert response.status_code == 200, response.text
                units.append(response.json())
            acquired_one = await manager.acquire("one-0")
            acquired_two = await manager.acquire("two-0")
            assert all(store.get("deployment", i)["state"] == "READY" for u in units for i in u["member_ids"])
            manager.release(acquired_one)
            await manager.stop(units[0]["id"])
            assert all(store.get("deployment", i)["state"] == "STOPPED" for i in units[0]["member_ids"])
            assert all(store.get("deployment", i)["state"] == "READY" for i in units[1]["member_ids"])
            manager.release(acquired_two)
    finally:
        await manager.close()
