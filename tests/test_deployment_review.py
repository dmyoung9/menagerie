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
