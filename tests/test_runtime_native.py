"""Behavioral contracts for engine-led execution; all resources are synthetic."""

import sqlite3
import time

import httpx
import pytest
from test_controlplane import baseline, seed

from controlplane import adapters, lifecycle, runtime_pool, runtime_protocol
from controlplane.api import create_app
from controlplane.resources import estimate
from controlplane.store import Store


def test_forks_share_protocol_and_capabilities_are_per_executable():
    for source in (None, "https://example.com/a-fork"):
        runtime = {"engine": "llama.cpp", "fork_url": source}
        assert not runtime_protocol.mechanisms(runtime, [])["fit"]
        assert runtime_protocol.mechanisms(runtime, ["fit"])["fit"]
    assert not runtime_protocol.mechanisms({"engine": "vllm"}, ["fit"])["fit"]


@pytest.mark.parametrize(
    "key", ["models-autoload", "models-memory-margin", "models-max"]
)
def test_shared_router_options_cannot_be_written_to_child_presets(key):
    runtime = {
        "execution_kind": "native",
        "capabilities": {"mechanisms": {"router": True}},
    }

    class SyntheticStore:
        def get(self, kind, ident):
            assert (kind, ident) == ("runtime", "engine")
            return runtime

    unit = {
        "engine_pool": True,
        "residency": "on-demand",
        "members": [{"profile_snapshot": {"runtime_id": "engine", "config": {key: 1}}}],
    }
    assert any(
        "Shared router settings" in error
        for error in runtime_pool.validate(unit, SyntheticStore())
    )
    with pytest.raises(ValueError, match="Shared router settings"):
        runtime_pool.preset(unit, SyntheticStore())


def test_automatic_values_and_observations_are_not_guessed():
    runtime = {
        "engine": "llama.cpp",
        "execution_kind": "native",
        "capabilities": {
            "formats": ["gguf"],
            "flags": ["fit", "ctx-size", "parallel", "gpu-layers"],
        },
    }
    artifact = {"format": "gguf", "size_bytes": 1024}
    config = {"fit": "on", "ctx-size": 0, "parallel": -1, "gpu-layers": "auto"}
    assert (
        adapters.validate_profile({"config": config, "raw_args": []}, artifact, runtime)
        == []
    )
    assert estimate(artifact, {})["peak_mib"] is None
    assert estimate(artifact, {"gpu-layers": "auto"})["ram_mib"] is None
    observation = adapters.runtime_observation(
        {
            "is_sleeping": True,
            "default_generation_settings": {"n_ctx": 4096, "prompt": "private"},
            "chat_template": "private",
        }
    )
    assert observation["resolved"] == {"n_ctx": 4096}
    assert "private" not in str(observation)
    assert (
        lifecycle.runtime(
            {"enabled": True, "state": "READY", "runtime_observation": observation}
        )
        == "sleeping"
    )


def test_old_registry_is_refused_without_mutation(tmp_path):
    path = tmp_path / "registry.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE schema_version(version INTEGER PRIMARY KEY)")
        connection.execute("INSERT INTO schema_version VALUES(2)")
    before = path.read_bytes()
    with pytest.raises(ValueError, match="fresh state"):
        Store(tmp_path)
    assert path.read_bytes() == before


def test_schema_inspection_closes_its_read_only_handle(tmp_path, monkeypatch):
    Store(tmp_path)
    connect = sqlite3.connect
    inspected = []

    def tracked(*args, **kwargs):
        connection = connect(*args, **kwargs)
        if kwargs.get("uri"):
            inspected.append(connection)
        return connection

    monkeypatch.setattr(sqlite3, "connect", tracked)
    Store(tmp_path)
    assert len(inspected) == 1
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        inspected[0].execute("SELECT 1")


async def test_pool_routes_models_with_one_process_and_stops_as_one_unit(tmp_path):
    app = create_app(tmp_path / "state")
    store, manager = app.state.store, app.state.manager
    await seed(store, tmp_path)
    manager.host = baseline()
    for member in store.list("deployment"):
        store.put("deployment", member | {"residency": "on-demand", "gpu": None})
    unit = store.put(
        "deployment_set",
        {
            "id": "pool",
            "name": "Pool",
            "engine_pool": True,
            "max_loaded": 2,
            "member_ids": ["a", "b"],
            "residency": "on-demand",
            "idle_timeout": 1,
            "priority": 50,
            "enabled": True,
            "queue_timeout": 5,
            "allow_eviction": False,
        },
    )
    try:
        assert not runtime_pool.validate(manager.unit("pool"), store)
        first = await manager.acquire("a")
        manager.release(first)
        second = await manager.acquire("b")
        manager.release(second)
        a, b = store.get("deployment", "a"), store.get("deployment", "b")
        assert a["pid"] == b["pid"]
        assert a["log_path"] == b["log_path"]
        assert len(manager.processes) == 1
        assert manager.runtime_port(b) == a["port"]
        assert runtime_protocol.observation(store, b)["residency"] == "unloaded"
        session = store.get("session", a["session_id"])
        assert session["pool_aggregate"]
        assert "--models-autoload" in session["argv"]
        assert session["argv"][session["argv"].index("--models-max") + 1] == "0"
        response = await manager.client.post(
            f"http://127.0.0.1:{manager.runtime_port(b)}/v1/chat/completions",
            json={"model": "b", "messages": []},
        )
        assert response.status_code == 200
        assert await manager.ready(b)
        b = store.get("deployment", "b")
        assert runtime_protocol.observation(store, b)["residency"] == "resident"
        assert runtime_protocol.observation(store, b)["memory"]["min"]["n_ctx"] == 4096
        revision = b["revision"]
        assert await manager.ready(b)
        assert store.get("deployment", "b")["revision"] == revision
        manager.last_use["a"] = manager.last_use["b"] = time.monotonic() - 60
        await manager.unload_idle()
        assert manager.owned(a)
        await manager.stop("pool")
        assert not manager.owned(a)
        assert all(m["state"] == "STOPPED" for m in store.list("deployment"))
        assert not manager.processes
        # No silent conversion of pinned/grouped residency into native LRU.
        assert runtime_pool.validate(
            manager.unit("pool") | {"residency": "pinned"}, store
        )
        assert unit["engine_pool"]
        default_alias = store.get("deployment", "a") | {"alias": "DEFAULT"}
        store.put("deployment", default_alias)
        assert "[DEFAULT]" in runtime_pool.preset(manager.unit("pool"), store)
    finally:
        await manager.close()


async def test_native_idle_has_one_owner_and_device_visibility_is_optional(tmp_path):
    app = create_app(tmp_path / "state")
    store, manager = app.state.store, app.state.manager
    await seed(store, tmp_path)
    runtime = store.get("runtime", "runtime")
    d = store.get("deployment", "a") | {"residency": "on-demand", "gpu": None}
    store.put("deployment", d)
    artifact = store.get("artifact", "weights")
    try:
        spec = adapters.launch_spec(
            d, d["profile_snapshot"], artifact, runtime, tmp_path, store
        )
        assert "CUDA_VISIBLE_DEVICES" not in spec["env"]
        assert "--sleep-idle-seconds" in spec["argv"]
        assert "--gpu-layers" not in spec["argv"]
        pinned = adapters.launch_spec(
            d | {"residency": "pinned", "gpu": 1},
            d["profile_snapshot"],
            artifact,
            runtime,
            tmp_path,
            store,
        )
        assert "--sleep-idle-seconds" not in pinned["argv"]
        assert pinned["env"]["CUDA_VISIBLE_DEVICES"] == "1"
        store.put("deployment", d | {"state": "READY"})
        manager.last_use["a"] = time.monotonic() - 1000
        await manager.unload_idle()
        assert store.get("deployment", "a")["state"] == "READY"
    finally:
        await manager.close()


async def test_pool_api_rejects_incompatible_policy_atomically(tmp_path):
    app = create_app(tmp_path / "state")
    store, manager = app.state.store, app.state.manager
    await seed(store, tmp_path)
    before = store.list("deployment_set")
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            token = (await client.get("/api/status")).json()["csrf_token"]
            response = await client.post(
                "/api/deployment-sets",
                headers={"X-Menagerie-Token": token},
                json={
                    "name": "Invalid pool",
                    "member_ids": ["a", "b"],
                    "engine_pool": True,
                    "residency": "pinned",
                },
            )
            assert response.status_code == 400
            assert "on-demand" in response.text
            assert store.list("deployment_set") == before
    finally:
        await manager.close()


async def test_sleep_observation_never_wakes_model_or_changes_configuration_revision(
    tmp_path,
):
    app = create_app(tmp_path / "state")
    store, manager = app.state.store, app.state.manager
    await seed(store, tmp_path)
    d = store.put(
        "deployment",
        store.get("deployment", "a") | {"state": "READY", "residency": "on-demand"},
    )
    calls = []

    def response(request):
        calls.append(request.url.path)
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/props":
            return httpx.Response(
                200,
                json={
                    "is_sleeping": True,
                    "default_generation_settings": {"n_ctx": 8192},
                    "prompt": "not retained",
                },
            )
        raise AssertionError("Sleep observation must not wake the model")

    await manager.client.aclose()
    manager.client = httpx.AsyncClient(transport=httpx.MockTransport(response))
    try:
        assert await manager.ready(d)
        assert calls == ["/health", "/props"]
        assert store.get("deployment", "a")["revision"] == d["revision"]
        observation = runtime_protocol.observation(store, d)
        assert observation["residency"] == "sleeping"
        assert "not retained" not in str(observation)
    finally:
        await manager.close()
