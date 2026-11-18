"""Deployment-owned settings and client identity, without a live inference engine."""

import json

import httpx

from controlplane.api import create_app
from controlplane.schema import profile_view


async def test_inline_configuration_identity_isolation_and_atomicity(tmp_path):
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
                "flags": ["ctx-size", "parallel"],
                "mechanisms": {"router": True},
            },
        },
    )
    settings = {
        "artifact_id": "weights",
        "runtime_id": "engine",
        "config": {"ctx-size": 16384, "parallel": 2},
        "catalog": {
            "catalog_id": "opaque-old-key",
            "model": {"name": "Old name", "limit": {"output": 99999}},
        },
    }
    payload = {
        "name": "Gemma Four",
        "alias": "gemma4",
        "port": 8120,
        "artifact_id": settings["artifact_id"],
        "runtime_id": settings["runtime_id"],
        "config": settings["config"],
        "raw_args": [],
        "catalog": settings["catalog"],
    }
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            headers = {
                "X-Menagerie-Token": (await client.get("/api/status")).json()[
                    "csrf_token"
                ]
            }

            pool = await client.post(
                "/api/deployment-sets",
                json={
                    "name": "Gemma pool",
                    "engine_pool": True,
                    "runtime_id": "engine",
                    "port": 8130,
                    "residency": "on-demand",
                    "enabled": True,
                    "gpu": None,
                    "max_loaded": 4,
                    "priority": 50,
                    "idle_timeout": 300,
                    "allow_eviction": False,
                    "queue_timeout": 300,
                    "member_ids": [],
                },
                headers=headers,
            )
            assert pool.status_code == 200, pool.text
            payload["pool_id"] = pool.json()["id"]

            async def save(body, expected=None):
                return await client.post(
                    "/api/deployments"
                    + (f"?expected={expected}" if expected is not None else ""),
                    json=body,
                    headers=headers,
                )

            response = await save(payload)
            assert response.status_code == 200, response.text
            first = response.json()
            assert first["state"] == "STOPPED"
            assert store.list("job") == []
            assert first["profile_snapshot"]["catalog"]["model"]["limit"] == {
                "context": 8192,
                "output": 8192,
            }
            duplicate = await save(
                payload | {"name": "Other", "alias": "other", "port": 8121}
            )
            assert duplicate.status_code == 200, duplicate.text
            second = duplicate.json()
            # Each deployment owns its configuration; the snapshot is the
            # deployment's own five fields, not a second handle on a shared
            # profile.
            assert first["id"] != second["id"]
            assert profile_view(second) == second["profile_snapshot"]
            first_row = store.get("deployment", first["id"])
            conflict = await save(
                payload | {"id": first["id"], "name": "Changed"}, expected=0
            )
            assert conflict.status_code >= 400
            assert store.get("deployment", first["id"]) == first_row
            invalid = await save(
                payload
                | {
                    "alias": "invalid",
                    "port": 8122,
                    "raw_args": ["--port", "9000"],
                }
            )
            assert invalid.status_code >= 400
            assert store.get("deployment", first["id"]) == first_row
            renamed = await save(
                payload | {"id": first["id"], "name": "Gemma Renamed"},
                expected=first["revision"],
            )
            assert renamed.status_code == 200, renamed.text
            assert store.get("deployment", second["id"]) == second
            rows = (await client.get("/v1/models")).json()["data"]
            # generated-mode rename: the API identifier follows the display
            # name, so "Gemma Renamed" advertises as "gemma-renamed".
            gemma = next(row for row in rows if row["id"] == "gemma-renamed")
            assert gemma["menagerie"]["catalog"]["catalog_id"] == "gemma-renamed"
            assert gemma["menagerie"]["catalog"]["model"]["name"] == "Gemma Renamed"
            await client.post(
                "/api/integration/opencode/export", json={}, headers=headers
            )
            models = json.loads((tmp_path / "opencode-managed.json").read_text())[
                "providers"
            ]["menagerie"]["models"]
            assert models["gemma-renamed"]["name"] == "Gemma Renamed"
            assert models["gemma-renamed"]["modelID"] == "gemma-renamed"
            store.put(
                "session",
                {
                    "id": "session",
                    "deployment_snapshot": first,
                    "artifact_identity": store.get("artifact", "weights"),
                    "runtime_identity": store.get("runtime", "engine"),
                },
            )
            restored = await client.post(
                "/api/history/sessions/session/restore", json={}, headers=headers
            )
            assert restored.status_code == 200, restored.text
            recovery = restored.json()
            assert recovery["enabled"] is False and recovery["state"] == "STOPPED"
            assert recovery["port"] is None
            restored_pool = app.state.manager.unit(recovery["id"])
            assert restored_pool["engine_pool"] and restored_pool["port"] != 8130
            assert recovery["alias"] != first["alias"]
            assert (
                recovery["profile_snapshot"]["config"]
                == first["profile_snapshot"]["config"]
            )
            store.put(
                "deployment", renamed.json() | {"state": "READY"}, historical=False
            )
            row_before = store.get("deployment", first["id"])
            assert (await save(payload | {"id": first["id"]})).status_code == 409
            assert store.get("deployment", first["id"]) == row_before
    finally:
        await app.state.manager.close()
