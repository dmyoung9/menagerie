import sqlite3

import httpx
import pytest
from test_controlplane import seed

from controlplane import adapters, deployment_sets
from controlplane.api import create_app
from controlplane.store import Store, encode


def test_sampler_and_mtp_fields_are_probed_and_validated():
    fields = {
        "top-p": 0.9,
        "top-k": 40,
        "min-p": 0.05,
        "presence-penalty": 0.2,
        "repeat-penalty": 1.1,
        "spec-type": "draft-mtp",
        "spec-draft-model": "/models/draft.gguf",
        "spec-draft-n-max": 3,
        "n-cpu-moe": 4,
    }
    runtime = {
        "engine": "llama.cpp",
        "execution_kind": "native",
        "capabilities": {"formats": ["gguf"], "flags": list(fields)},
    }
    assert set(adapters.option_schema(runtime)) == set(fields)
    assert not adapters.option_schema(runtime | {"capabilities": {"flags": []}})
    alias_runtime = runtime | {
        "capabilities": {"flags": ["draft-max", "spec-draft-n-max"]}
    }
    assert set(adapters.option_schema(alias_runtime)) == {"spec-draft-n-max"}
    artifact = {"format": "gguf", "architecture": "example", "metadata": {}}
    profile = {"config": fields, "raw_args": []}
    assert adapters.validate_profile(profile, artifact, runtime) == []
    for key, bad in [
        ("top-p", 1.1),
        ("min-p", -1),
        ("top-k", 0.5),
        ("presence-penalty", 3),
        ("repeat-penalty", -1),
        ("spec-draft-n-max", 0),
    ]:
        assert any(
            key in error
            for error in adapters.validate_profile(
                profile | {"config": fields | {key: bad}}, artifact, runtime
            )
        )


HELP_DEFAULTS = """-t,    --threads N                      CPU threads (default: -1)
-tb,   --threads-batch N                batch threads (default:
                                        same as --threads)
--temp, --temperature N                 sampling temperature (default: 0.80)
--top-p N                               nucleus sampling (default: 0.95)
--spec-draft-n-max N                    draft tokens (default: 3, 2 for
                                        draft-mtp on CUDA)
--spec-draft-n-min N                    minimum draft tokens
                                        (default: 0)
--draft-max N                           the argument has been removed. use --spec-draft-n-max
--spec-type none,draft-simple,draft-mtp  speculation (default: none)
--ctx-size N                            context (default: 0, 0 = loaded from model)
--reasoning-budget N                    thinking tokens (default: -1)
--top-k N                               top k (default: unknown)
"""


def test_executable_defaults_are_scoped_wrapped_and_backend_specific():
    flags = [
        "threads",
        "threads-batch",
        "temp",
        "top-p",
        "top-k",
        "spec-draft-n-max",
        "spec-draft-n-min",
        "ctx-size",
        "reasoning-budget",
    ]
    runtime = {
        "engine": "prism",
        "managed": {"backend": "cuda"},
        "capabilities": {"flags": flags},
    }
    schema = adapters.option_schema(runtime, flags, HELP_DEFAULTS)
    assert schema["threads"]["engine_default"] == -1
    assert schema["threads-batch"]["default_from"] == "threads"
    assert schema["temp"]["engine_default"] == 0.8
    assert schema["top-p"]["engine_default"] == 0.95
    assert schema["spec-draft-n-max"]["engine_default"] == 2
    assert schema["spec-draft-n-min"]["engine_default"] == 0
    assert schema["ctx-size"]["engine_default"] == 0
    assert schema["reasoning-budget"]["engine_default"] == -1
    assert "engine_default" not in schema["top-k"]
    assert (
        schema["threads"]["default"] == 6
    )  # historical policy is not silently rewritten
    assert (
        adapters.option_schema(
            runtime | {"managed": {"backend": "cpu"}}, flags, HELP_DEFAULTS
        )["spec-draft-n-max"]["engine_default"]
        == 3
    )
    saved = runtime | {"capabilities": {"flags": flags, "schema": schema}}
    assert adapters.option_schema(saved)["spec-draft-n-max"]["engine_default"] == 2


@pytest.mark.asyncio
async def test_engine_help_defaults_are_cached_without_mutating_runtime(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path / "state")
    store = app.state.store
    runtime = store.put(
        "runtime",
        {
            "id": "engine",
            "engine": "llama.cpp",
            "execution_kind": "native",
            "trust": True,
            "executable": "/engines/fake",
            "capabilities": {"flags": ["temp", "spec-draft-n-max"]},
        },
    )
    calls = []

    async def command(argv, *args):
        calls.append(argv)
        return HELP_DEFAULTS

    monkeypatch.setattr(adapters, "command", command)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            for _ in range(2):
                response = await client.get("/api/runtimes/engine/capabilities")
                assert response.status_code == 200
                assert response.json()["schema"]["temp"]["engine_default"] == 0.8
        assert calls == [["/engines/fake", "--help"]]
        assert store.get("runtime", "engine") == runtime
    finally:
        await app.state.manager.close()


@pytest.mark.asyncio
async def test_untrusted_custom_and_container_defaults_do_not_execute(
    tmp_path, monkeypatch
):
    async def forbidden(*args, **kwargs):
        raise AssertionError("Must not execute")

    monkeypatch.setattr(adapters, "command", forbidden)
    runtime = {
        "engine": "llama.cpp",
        "execution_kind": "native",
        "trust": True,
        "capabilities": {"flags": ["temp"]},
    }
    for changed in [
        {"trust": False},
        {"engine": "custom"},
        {"execution_kind": "docker"},
    ]:
        schema = await adapters.configuration_schema(runtime | changed)
        assert not schema or "engine_default" not in schema["temp"]


def test_request_totals_seed_retained_history_once_and_survive_cleanup(tmp_path):
    store = Store(tmp_path)
    with store.connect() as c:
        c.execute("DROP TABLE request_totals")
        for ident, error in [
            ("success", None),
            ("failed", "upstream_error"),
            ("cancelled", "client_cancelled"),
        ]:
            c.execute(
                "INSERT INTO requests VALUES(?,?,?,?)",
                (ident, 1, "a", encode({"error": error})),
            )
    store.put("session", {"id": "old", "deployment_id": "b", "request_count": 7})
    store = Store(tmp_path)
    assert store.request_totals() == {"a": 3, "b": 7}
    with store.connect() as c:
        c.execute("DELETE FROM requests")
        c.execute(
            "UPDATE request_totals SET completed=completed+1 WHERE deployment_id=?",
            ("a",),
        )
    assert Store(tmp_path).request_totals() == {"a": 4, "b": 7}
    member = {
        "name": "Example",
        "id": "a",
        "enabled": True,
        "state": "STOPPED",
        "residency": "on-demand",
    }
    unit = {
        "id": "group",
        "name": "Group",
        "enabled": True,
        "state": "STOPPED",
        "residency": "on-demand",
        "members": [member, member | {"id": "b"}],
    }
    described = deployment_sets.describe(unit, {}, {"a": 2}, store.request_totals())
    assert described["inflight"] == 2
    assert described["historical_requests"] == 11
    assert [m["historical_requests"] for m in described["members"]] == [4, 7]


def test_counter_seed_handles_large_session_snapshots_and_is_idempotent(
    tmp_path, monkeypatch
):
    store = Store(tmp_path)
    # Snapshot payloads must not become a temporary disk-backed sort. The same
    # fixture can also be exercised under the service's read-only-temp sandbox.
    for index in range(12):
        store.put(
            "session",
            {
                "id": str(index),
                "deployment_id": f"fixture-{index % 2}",
                "request_count": index,
                "snapshot": {"metadata": "x" * (2 * 1024 * 1024)},
            },
            historical=False,
        )
    statements = []
    connect = sqlite3.connect

    def traced_connect(*args, **kwargs):
        connection = connect(*args, **kwargs)
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(sqlite3, "connect", traced_connect)
    assert Store(tmp_path).request_totals() == {"fixture-0": 30, "fixture-1": 36}
    # Check the actual executed query plans, not source spelling: neither the
    # scalar reads nor an INSERT...SELECT migration may need a temp B-tree.
    reads = [
        sql
        for sql in statements
        if "SELECT" in sql.upper() and not sql.lstrip().upper().startswith("CREATE")
    ]
    assert reads
    with connect(store.path) as connection:
        for sql in reads:
            plan = connection.execute("EXPLAIN QUERY PLAN " + sql).fetchall()
            assert not any("TEMP B-TREE" in row[-1] for row in plan)
    assert Store(tmp_path).request_totals() == {"fixture-0": 30, "fixture-1": 36}


@pytest.mark.asyncio
async def test_finished_gateway_requests_count_success_failure_and_cancellation(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path / "state")
    store, manager = app.state.store, app.state.manager
    await seed(store, tmp_path)
    deployment = store.get("deployment", "a")

    async def acquire(alias):
        manager.inflight["a"] = manager.inflight.get("a", 0) + 1
        return deployment

    monkeypatch.setattr(manager, "acquire", acquire)
    status = 200

    def upstream(request):
        return httpx.Response(
            status, json={"choices": [], "usage": {"completion_tokens": 2}}
        )

    await manager.client.aclose()
    manager.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            assert (
                await client.post(
                    "/v1/chat/completions", json={"model": "a", "messages": []}
                )
            ).status_code == 200
            status = 500
            assert (
                await client.post(
                    "/v1/chat/completions", json={"model": "a", "messages": []}
                )
            ).status_code == 500
            from starlette.requests import Request

            async def disconnected(self):
                return True

            monkeypatch.setattr(Request, "is_disconnected", disconnected)
            assert (
                await client.post(
                    "/v1/chat/completions", json={"model": "a", "messages": []}
                )
            ).status_code == 499
            assert store.request_totals()["a"] == 3
            assert manager.inflight["a"] == 0
            rows = (await client.get("/api/serving-deployments")).json()
            assert next(d for d in rows if d["id"] == "a")["historical_requests"] == 3
    finally:
        await manager.close()
