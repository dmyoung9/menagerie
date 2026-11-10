import httpx

from controlplane import adapters, runtime_protocol
from controlplane.api import create_app


def test_executable_features_ignore_supplier_labels_and_keep_absence_unknown():
    runtime = {"engine": "llama.cpp"}
    flags = ["mmproj", "reasoning-budget", "fit"]
    upstream = runtime_protocol.features(runtime, flags)
    fork = runtime_protocol.features(
        runtime | {"fork_url": "https://example.com/prism"}, flags
    )
    assert upstream == fork
    assert upstream["image_projector"]["status"] == "supported"
    assert upstream["native_pool"]["status"] == "unknown"
    assert upstream["image_projector"]["evidence"][0]["source"] == "runtime"
    assert (
        "model compatibility and inference unverified"
        in upstream["image_projector"]["evidence"][0]["detail"]
    )


async def test_changed_executable_invalidates_cached_help_without_running_replacement(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path / "state")
    path = tmp_path / "synthetic-engine"
    path.write_text("original")
    runtime = app.state.store.put(
        "runtime",
        {
            "id": "engine",
            "engine": "llama.cpp",
            "execution_kind": "native",
            "trust": True,
            "executable": str(path),
            "capabilities": {"flags": ["temp"], "sha256": adapters.file_hash(path)},
        },
    )
    calls = []

    async def command(*args):
        calls.append(args)
        return "--temp N  temperature (default: 0.8)"

    monkeypatch.setattr(adapters, "command", command)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        assert (
            await client.get("/api/runtimes/engine/capabilities")
        ).status_code == 200
        assert (
            await client.get("/api/runtimes/engine/capabilities")
        ).status_code == 200
        path.write_text("replacement build")
        response = await client.get("/api/runtimes/engine/capabilities")
        assert response.status_code == 400
        assert "executable changed" in response.text
    assert len(calls) == 1
    assert app.state.store.get("runtime", "engine") == runtime
