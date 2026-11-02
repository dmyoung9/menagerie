"""Review UI history uses measured conditions and exact execution/run identities."""

import time
from copy import deepcopy

import httpx

from controlplane.activity import condition_text, pressure_conditions
from controlplane.api import create_app
from controlplane.jobs import Jobs
from controlplane.resources import profile_hash
from controlplane.store import encode


def setup(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    artifact = store.put(
        "artifact",
        {
            "id": "model",
            "name": "Example",
            "format": "gguf",
            "local_path": "/models/example.gguf",
        },
    )
    runtime = store.put(
        "runtime",
        {
            "id": "engine",
            "name": "Example engine",
            "engine": "llama.cpp",
            "execution_kind": "native",
            "executable": "/never/executed",
        },
    )
    profile = {
        "id": "profile",
        "name": "Example",
        "artifact_id": "model",
        "runtime_id": "engine",
        "config": {"ctx-size": 8192},
        "raw_args": [],
        "catalog": {},
    }
    deployment = store.put(
        "deployment",
        {
            "id": "deployment",
            "name": "Example",
            "profile_snapshot": profile,
            "alias": "example",
            "gpu": 0,
            "state": "STOPPED",
            "enabled": True,
            "port": 8120,
        },
    )
    return app, artifact, runtime, deployment


def test_pressure_conditions_identify_each_measured_resource():
    settings = {
        "gpu_headroom_mib": 2048,
        "ram_headroom_mib": 4096,
        "temperature_limit": 85,
    }
    host = {
        "gpus": [
            {"index": 0, "free_mib": 1024, "temperature": 90},
            {"index": 1, "free_mib": None, "temperature": None},
        ],
        "ram_available_mib": 2048,
    }
    conditions = pressure_conditions(host, settings)
    assert [c["metric"] for c in conditions] == [
        "free_memory",
        "temperature",
        "available_memory",
    ]
    assert condition_text(conditions[0]) == "GPU 0 free memory 1024 MiB below 2048 MiB"
    assert condition_text(conditions[1]) == "GPU 0 temperature 90 °C above 85 °C"
    assert pressure_conditions({"gpus": [], "ram_available_mib": None}, settings) == []
    assert (
        pressure_conditions(
            {
                "gpus": [{"index": 0, "free_mib": 2048, "temperature": 85}],
                "ram_available_mib": 4096,
            },
            settings,
        )
        == []
    )


async def test_job_and_lifecycle_share_correlation_and_target(tmp_path):
    app, _, _, d = setup(tmp_path)
    manager = app.state.manager

    async def action(_):
        manager.transition(d["id"], "VALIDATING")
        manager.transition(d["id"], "QUEUED")

    job = Jobs(manager).submit(
        "Load Example", action, deployment_id=d["id"], operation="load"
    )
    import asyncio

    await asyncio.gather(*manager.tasks)
    events = app.state.store.events(0)
    relevant = [e for e in events if e["kind"] in {"state", "job"}]
    assert len(relevant) == 3
    assert {e["data"]["operation_id"] for e in relevant} == {job["id"]}
    assert relevant[-1]["data"]["name"] == "Load Example"
    assert relevant[-1]["deployment_id"] == d["id"]
    await manager.client.aclose()


async def test_performance_excludes_other_configuration_and_breaks_runs(tmp_path):
    app, artifact, runtime, d = setup(tmp_path)
    store, manager = app.state.store, app.state.manager
    now = time.time()
    for ident, start, context in (
        ("old", now - 100, 8192),
        ("changed", now - 50, 16384),
        ("new", now - 10, 8192),
    ):
        snapshot = deepcopy(d)
        snapshot["profile_snapshot"]["config"]["ctx-size"] = context
        store.put(
            "session",
            {
                "id": ident,
                "deployment_id": d["id"],
                "deployment_snapshot": snapshot,
                "artifact_identity": artifact,
                "runtime_identity": runtime,
                "profile_hash": profile_hash(
                    snapshot["profile_snapshot"], artifact, runtime, 0
                ),
                "started_at": start,
                "ended_at": start + 5,
                "outcome": "stopped",
            },
        )
        with store.connect() as c:
            c.execute(
                "INSERT INTO samples VALUES(?,?)",
                (
                    start + 1,
                    encode(
                        {
                            "ts": start + 1,
                            "deployments": {
                                d["id"]: {"session_id": ident, "rss_mib": 512}
                            },
                            "runtime_metrics": {
                                d["id"]: {
                                    "llamacpp:prompt_seconds_total": 1,
                                    "llamacpp:prompt_tokens_total": 20,
                                }
                            },
                        }
                    ),
                ),
            )
    copy = deepcopy(d) | {"id": "another-instance", "alias": "another"}
    store.put("deployment", copy)
    store.put(
        "session",
        {
            "id": "concurrent",
            "deployment_id": copy["id"],
            "deployment_snapshot": copy,
            "artifact_identity": artifact,
            "runtime_identity": runtime,
            "started_at": now - 4,
            "ended_at": now - 1,
        },
    )
    with store.connect() as c:
        c.execute(
            "INSERT INTO samples VALUES(?,?)",
            (
                now - 2,
                encode(
                    {
                        "ts": now - 2,
                        "deployments": {
                            copy["id"]: {"session_id": "concurrent", "rss_mib": 999}
                        },
                    }
                ),
            ),
        )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.get(f"/api/deployments/{d['id']}/performance")
        assert response.status_code == 200
        samples = response.json()
        assert [s["deployments"][d["id"]]["session_id"] for s in samples] == [
            "old",
            "new",
        ]
        assert (
            samples[0]["runtime_metrics"][d["id"]]["llamacpp:prompt_tokens_total"] == 20
        )
    await manager.client.aclose()


async def test_request_filter_happens_before_limit_and_logs_scope_to_run(tmp_path):
    app, _, _, d = setup(tmp_path)
    store, manager = app.state.store, app.state.manager
    folder = store.root / "deployments" / d["id"]
    folder.mkdir(parents=True)
    log = folder / "runtime.log"
    log.write_text("10.000 old run\n20.000 selected run\n30.000 later run\n")
    store.put("deployment", d | {"log_path": str(log)}, historical=False)
    store.put(
        "session",
        {"id": "run", "deployment_id": d["id"], "started_at": 19, "ended_at": 21},
    )
    store.put(
        "session",
        {"id": "other", "deployment_id": "different", "started_at": 19, "ended_at": 21},
    )
    with store.connect() as c:
        c.execute(
            "INSERT INTO requests VALUES(?,?,?,?)",
            ("wanted", 1, d["id"], encode({"model_alias": "example"})),
        )
        c.executemany(
            "INSERT INTO requests VALUES(?,?,?,?)",
            [(str(i), i + 2, "different", "{}") for i in range(301)],
        )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        assert len((await client.get("/api/history/requests")).json()) == 300
        rows = (
            await client.get("/api/history/requests?deployment_id=deployment")
        ).json()
        assert [r["id"] for r in rows] == ["wanted"]
        assert (
            await client.get("/api/deployments/deployment/logs?session_id=run")
        ).json()["text"] == "20.000 selected run"
        assert (
            await client.get("/api/deployments/deployment/logs?session_id=other")
        ).status_code == 400
    await manager.client.aclose()


async def test_legacy_samples_stop_at_next_configuration_even_if_run_was_not_closed(
    tmp_path,
):
    app, artifact, runtime, d = setup(tmp_path)
    store, manager = app.state.store, app.state.manager
    now = time.time()
    for ident, context, start in (
        ("unclosed", 8192, now - 100),
        ("replacement", 16384, now - 50),
    ):
        snapshot = deepcopy(d)
        snapshot["profile_snapshot"]["config"]["ctx-size"] = context
        store.put(
            "session",
            {
                "id": ident,
                "deployment_id": d["id"],
                "deployment_snapshot": snapshot,
                "artifact_identity": artifact,
                "runtime_identity": runtime,
                "started_at": start,
                "ended_at": None,
            },
        )
    with store.connect() as c:
        for offset in (90, 40):
            c.execute(
                "INSERT INTO samples VALUES(?,?)",
                (
                    now - offset,
                    encode(
                        {
                            "ts": now - offset,
                            "deployments": {d["id"]: {"rss_mib": offset}},
                        }
                    ),
                ),
            )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        rows = (await client.get("/api/deployments/deployment/performance")).json()
        assert len(rows) == 1
        assert rows[0]["deployments"]["deployment"]["rss_mib"] == 90
    await manager.client.aclose()
