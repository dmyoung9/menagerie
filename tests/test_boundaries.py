import struct

import httpx
import pytest

from controlplane import adapters
from controlplane.api import create_app
from controlplane.jobs import Jobs
from controlplane.store import encode


def test_malformed_gguf_is_bounded(tmp_path):
    p = tmp_path / "bad.gguf"
    p.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 0, 1) + struct.pack("<Q", 2**63))
    with pytest.raises(ValueError, match="limit"):
        adapters.inspect_artifact(p)


async def test_untrusted_runtime_and_environment_do_not_execute(tmp_path):
    runtime = {
        "engine": "llama.cpp",
        "execution_kind": "native",
        "executable": "/missing",
        "env": {},
        "trust": False,
    }
    with pytest.raises(ValueError, match="trust"):
        await adapters.probe(runtime)
    runtime.update(trust=True, env={"LD_PRELOAD": "/bad.so"})
    with pytest.raises(ValueError, match="Unsupported environment"):
        await adapters.probe(runtime)


def test_container_spec_is_pinned_readonly_loopback_and_gpu_explicit(tmp_path):
    model = tmp_path / "model.gguf"
    model.touch()
    runtime = {
        "engine": "vllm",
        "execution_kind": "docker",
        "executable": "vllm/vllm-openai@sha256:" + "a" * 64,
        "env": {},
        "capabilities": {"formats": ["safetensors"]},
    }
    deployment = {"id": "example", "alias": "stable", "port": 8123, "gpu": 0}
    profile = {"config": {}, "raw_args": []}
    artifact = {"format": "safetensors", "local_path": str(tmp_path)}
    spec = adapters.launch_spec(
        deployment, profile, artifact, runtime, tmp_path / "work"
    )
    argv = spec["argv"]
    assert "--privileged" not in argv
    assert "--cap-drop=ALL" in argv and "--security-opt=no-new-privileges" in argv
    assert "127.0.0.1:8123:8123" in argv
    assert str(tmp_path) + ":/models:ro" in argv
    assert argv[argv.index("--gpus") + 1] == "device=0"
    assert runtime["executable"] in argv


async def test_hf_search_contract_and_offline_error(tmp_path, monkeypatch):
    app = create_app(tmp_path)

    class Model:
        id, downloads, gated, tags = "org/model", 12, False, []

    class API:
        def list_models(self, *, search, limit, sort):
            return [Model()]

    monkeypatch.setattr("controlplane.jobs.HfApi", API)
    jobs = Jobs(app.state.manager)
    assert (await jobs.hf_search("model"))[0]["id"] == "org/model"

    class Offline:
        def list_models(self, **kwargs):
            raise OSError("offline")

    monkeypatch.setattr("controlplane.jobs.HfApi", Offline)
    with pytest.raises(ValueError, match="catalog unavailable"):
        await jobs.hf_search("model")
    await app.state.manager.close()


async def test_purge_preserves_configuration_and_sessions(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put("session", {"id": "historical", "started_at": 1})
    store.put("profile", {"id": "p", "name": "saved"})
    with store.connect() as c:
        c.execute("INSERT INTO samples VALUES(?,?)", (1, encode({"ts": 1})))
        c.execute("INSERT INTO requests VALUES(?,?,?,?)", ("r", 1, "d", "{}"))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        client.headers["X-Menagerie-Token"] = (await client.get("/api/status")).json()[
            "csrf_token"
        ]
        denied = await client.post("/api/history/purge", json={"older_than_days": 1})
        assert denied.status_code == 400
        response = await client.post(
            "/api/history/purge", json={"older_than_days": 1, "confirm": True}
        )
        assert response.json()["samples_removed"] == 1
        assert response.json()["requests_removed"] == 1
    assert store.get("session", "historical") and store.get("profile", "p")
    await app.state.manager.close()
