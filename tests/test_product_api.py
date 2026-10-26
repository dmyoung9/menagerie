"""Product-facing metadata; no live runtime or installed service required."""
import json

import httpx

from controlplane.api import create_app


async def test_connection_details_and_exports_use_configured_gateway(tmp_path):
    app = create_app(tmp_path, gateway_port=9123)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        status = (await client.get("/api/status")).json()
        assert status["gateway_url"] == "http://127.0.0.1:9123/v1"
        integration = (await client.get("/api/integration/opencode")).json()
        assert integration["endpoint"] == status["gateway_url"]
        export = await client.post("/api/integration/opencode/export", json={}, headers={"X-Menagerie-Token": status["csrf_token"]})
        assert export.status_code == 200
        config = json.loads((tmp_path / "opencode-managed.json").read_text())
        assert config["providers"]["llama.cpp"]["settings"]["baseURL"] == status["gateway_url"]
        assert (await client.get("/v1/models")).status_code == 200
        assert json.loads((tmp_path / "opencode-managed.json").read_text()) == config


async def test_container_engine_registry_exposes_typed_options_without_probing(tmp_path):
    app = create_app(tmp_path)
    app.state.store.put("runtime", {"id": "container", "name": "vLLM", "engine": "vllm", "execution_kind": "docker", "executable": "unused", "capabilities": {"formats": ["safetensors"]}})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        rows = (await client.get("/api/registry/runtimes")).json()
        assert rows[0]["capabilities"]["schema"]["max-model-len"]["type"] == "integer"
        assert rows[0]["capabilities"]["formats"] == ["safetensors"]
        assert "schema" not in app.state.store.get("runtime", "container")["capabilities"]


async def test_wizard_configuration_saves_without_loading_and_preserves_snapshot(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put("artifact", {"id": "model", "name": "Example", "format": "gguf", "local_path": "/models/example.gguf"})
    store.put("runtime", {"id": "engine", "name": "Engine", "engine": "llama.cpp", "execution_kind": "native", "executable": "/not/executed", "capabilities": {"formats": ["gguf"], "flags": ["ctx-size", "parallel", "gpu-layers"]}})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        headers = {"X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]}
        payload = {"name": "Example settings", "artifact_id": "model", "runtime_id": "engine", "config": {"ctx-size": 65536, "parallel": 2, "gpu-layers": "all"}, "raw_args": [], "catalog": {"catalog_id": "example", "model": {"capabilities": {"tools": False, "input": ["text"], "output": ["text"]}, "limit": {"output": 8192}}}}
        response = await client.post("/api/profiles", json=payload, headers=headers)
        assert response.status_code == 200, response.text
        profile = response.json()
        assert profile["catalog"]["model"]["limit"] == {"context": 32768, "output": 8192}
        response = await client.post("/api/deployments", json={"name": "Example", "profile_id": profile["id"], "alias": "example", "port": 8120, "residency": "on-demand", "allow_uncertain": False}, headers=headers)
        assert response.status_code == 200, response.text
        deployment = response.json()
        assert deployment["state"] == "STOPPED"
        assert deployment["enabled"] is True
        assert store.list("job") == []
        revised = await client.post("/api/profiles?expected=1", json=payload | {"id": profile["id"], "config": {"ctx-size": 16384, "parallel": 1}}, headers=headers)
        assert revised.status_code == 200, revised.text
        assert store.get("deployment", deployment["id"])["profile_snapshot"]["revision"] == 1
        assert store.get("deployment", deployment["id"])["profile_snapshot"]["config"]["ctx-size"] == 65536


async def test_personal_migration_endpoints_are_not_product_features(tmp_path):
    archive = tmp_path / "history.sqlite3"
    archive.write_bytes(b"preserved historical data")
    app = create_app(tmp_path)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            headers = {"X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]}
            for path in ("/api/import/shelf/preview", "/api/import/shelf"):
                assert (await client.post(path, json={}, headers=headers)).status_code == 404
            assert (await client.get("/api/history/legacy")).status_code == 404
            assert app.state.store.list("job") == []
            assert archive.read_bytes() == b"preserved historical data"
    finally:
        await app.state.manager.close()
