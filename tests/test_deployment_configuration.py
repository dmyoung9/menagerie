"""Deployment-owned settings and client identity, without a live inference engine."""

import json

import httpx

from controlplane.api import create_app


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
            "capabilities": {"formats": ["gguf"], "flags": ["ctx-size", "parallel"]},
        },
    )
    settings = {
        "name": "Ignored settings label",
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
        "configuration": settings,
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
            assert second["profile_id"] != first["profile_id"]
            profiles_before = store.list("profile")
            conflict = await save(
                payload | {"id": first["id"], "name": "Changed"}, expected=0
            )
            assert conflict.status_code >= 400
            assert store.list("profile") == profiles_before
            invalid = await save(
                payload
                | {
                    "alias": "invalid",
                    "port": 8122,
                    "configuration": settings | {"raw_args": ["--port", "9000"]},
                }
            )
            assert invalid.status_code >= 400
            assert store.list("profile") == profiles_before
            renamed = await save(
                payload | {"id": first["id"], "name": "Gemma Renamed"},
                expected=first["revision"],
            )
            assert renamed.status_code == 200, renamed.text
            assert store.get("deployment", second["id"]) == second
            rows = (await client.get("/v1/models")).json()["data"]
            gemma = next(row for row in rows if row["id"] == "gemma4")
            assert gemma["menagerie"]["catalog"]["catalog_id"] == "gemma4"
            assert gemma["menagerie"]["catalog"]["model"]["name"] == "Gemma Renamed"
            await client.post(
                "/api/integration/opencode/export", json={}, headers=headers
            )
            models = json.loads((tmp_path / "opencode-managed.json").read_text())[
                "providers"
            ]["menagerie"]["models"]
            assert models["gemma4"]["name"] == "Gemma Renamed"
            assert models["gemma4"]["modelID"] == "gemma4"
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
            assert recovery["port"] not in {first["port"], second["port"]}
            assert recovery["alias"] != first["alias"]
            assert (
                recovery["profile_snapshot"]["config"]
                == first["profile_snapshot"]["config"]
            )
            store.put(
                "deployment", renamed.json() | {"state": "READY"}, historical=False
            )
            before = store.list("profile")
            assert (await save(payload | {"id": first["id"]})).status_code == 409
            assert store.list("profile") == before
    finally:
        await app.state.manager.close()
