"""Keep the dashboard's wire decoders aligned with real, offline API responses."""

import json
import shutil
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from huggingface_hub.hf_api import ModelInfo

from controlplane.api import create_app
from controlplane.schema import Artifact, Deployment, DeploymentSet, Profile, Runtime


async def test_frontend_decodes_actual_api_responses(tmp_path, monkeypatch):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js 22+ is required for the frontend contract check")
    app = create_app(tmp_path)
    monkeypatch.setattr(
        "controlplane.jobs.HfApi",
        lambda: SimpleNamespace(
            list_models=lambda **kwargs: [
                ModelInfo(id="fixture/qwen", gated=None, downloads=None, tags=None)
            ]
        ),
    )
    store, manager = app.state.store, app.state.manager
    artifact = store.put(
        "artifact",
        Artifact(
            id="model",
            name="Model",
            local_path="/unused/model.gguf",
            metadata={"vendor": {"retain": True}},
        ).model_dump(),
    )
    runtime = store.put(
        "runtime",
        Runtime(
            id="runtime",
            name="Runtime",
            engine="llama.cpp",
            executable="/unused/runtime",
        ).model_dump(),
    )
    profile = store.put(
        "profile",
        Profile(
            id="profile",
            name="Profile",
            artifact_id=artifact["id"],
            runtime_id=runtime["id"],
            catalog={"vendor": {"retain": True}},
        ).model_dump(),
    )
    member = store.put(
        "deployment",
        Deployment(
            id="member",
            name="Member",
            profile_id=profile["id"],
            alias="member",
            port=8120,
        ).model_dump(exclude_none=True)
        | {"state": "STOPPED", "profile_snapshot": profile},
    )
    store.put(
        "deployment", member | {"id": "standalone", "alias": "standalone", "port": 8121}
    )
    store.put(
        "deployment_set",
        DeploymentSet(id="group", name="Group", member_ids=[member["id"]]).model_dump(
            exclude_none=True
        ),
    )
    now = time.time()
    manager.host = {
        "ts": now,
        "cpu_count": None,
        "ram_available_mib": None,
        "gpus": [
            {
                "index": 0,
                "name": "Unavailable GPU",
                "total_mib": None,
                "used_mib": None,
                "free_mib": None,
            }
        ],
        "processes": [],
        "errors": ["Telemetry unavailable"],
        "pressure": False,
    }
    store.put(
        "job",
        {"id": "job", "name": "Example job", "state": "STOPPED", "created_at": now},
    )
    store.put(
        "session",
        {
            "id": "session",
            "started_at": now,
            "deployment_snapshot": member,
            "outcome": "stopped",
            "peak_gpu_mib": 0,
        },
    )
    store.put(
        "activation",
        {
            "id": "activation",
            "state": "STOPPED",
            "started_at": now,
            "deployment_name": "Group",
        },
    )
    store.event("state", {"to": "STOPPED", "reason": None}, member["id"])
    store.event("future_event", {"vendor": [1, 2]})
    with store.transaction() as connection:
        connection.execute(
            "INSERT INTO requests VALUES(?,?,?,?)",
            (
                "request",
                now,
                member["id"],
                json.dumps(
                    {
                        "model_alias": "member",
                        "latency": None,
                        "ttft": None,
                        "output_tokens": None,
                        "error": None,
                    }
                ),
            ),
        )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:

        async def get(path):
            response = await client.get(path)
            response.raise_for_status()
            return response.json()

        status = await get("/api/status")
        payload = {"status": status}
        payload["catalog"] = await get("/api/catalog/hf?q=qwen")
        for kind in ("models", "runtimes", "profiles", "deployments", "jobs"):
            payload[kind] = await get(f"/api/registry/{kind}")
        payload["serving"] = await get("/api/serving-deployments")
        store.put(
            "artifact", {"id": "unknown-format", "name": "Unknown", "format": "unknown"}
        )
        payload["recommendation"] = await get(
            "/api/models/unknown-format/engine-recommendation"
        )
        for kind in ("sessions", "requests", "activations"):
            payload[kind] = await get(f"/api/history/{kind}")
        payload["events"] = await get("/api/events")
        payload["revisions"] = await get("/api/profiles/profile/revisions")
        preview = await client.post(
            "/api/resources/preview",
            json={
                "members": [
                    {
                        "configuration": Profile(
                            **{
                                key: value
                                for key, value in profile.items()
                                if key != "revision"
                            }
                        ).model_dump()
                    }
                ]
            },
            headers={"X-Menagerie-Token": status["csrf_token"]},
        )
        preview.raise_for_status()
        payload["preview"] = preview.json()
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [node, "--experimental-strip-types", "frontend/tests/backend-contracts.ts"],
        cwd=root,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
