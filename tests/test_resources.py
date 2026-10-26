"""Resource previews never mutate registry or authorize runtime actions."""
from copy import deepcopy
import time

import httpx

from controlplane.api import create_app
from controlplane.resources import estimate, preview


def fixture(tmp_path):
    app = create_app(tmp_path)
    store, manager = app.state.store, app.state.manager
    store.put("artifact", {"id": "weights", "name": "Example", "local_path": "/unused.gguf", "format": "gguf", "size_bytes": 4 * 1024**3,
                           "architecture": "llama", "metadata": {"llama.block_count": 32, "llama.context_length": 32768}})
    store.put("runtime", {"id": "runtime", "name": "Engine", "engine": "llama.cpp", "execution_kind": "native", "executable": "/never/executed",
                          "capabilities": {"flags": ["ctx-size", "parallel", "gpu-layers"]}})
    manager.host = {"ts": time.time(), "gpus": [{"index": 0, "name": "GPU", "total_mib": 16384, "used_mib": 2048, "free_mib": 14336}], "ram_available_mib": 8192}
    draft = {"name": "Example", "gpu": 0, "reservation_mib": 0, "configuration": {"name": "Example", "artifact_id": "weights", "runtime_id": "runtime", "config": {"ctx-size": 8192, "parallel": 1}}}
    return app, manager, draft


def test_components_match_shared_launch_estimate_and_peers_reduce_recommendation(tmp_path):
    app, manager, draft = fixture(tmp_path)
    one = preview(manager, [draft])
    e = one["members"][0]["estimate"]
    assert sum(e["components"].values()) == e["peak_mib"]
    assert e == manager.estimate(draft | {"profile_snapshot": draft["configuration"]})
    assert one["members"][0]["recommendation"]["gpu_layers_max"] == 32
    two = preview(manager, [draft, draft])
    assert two["gpus"][0]["draft_mib"] == 2 * e["peak_mib"]
    assert two["members"][0]["recommendation"]["context_recommended_max"] < one["members"][0]["recommendation"]["context_recommended_max"]
    assert one["gpus"][0]["remaining_mib"] == 16384 - 2048 - 2048 - e["peak_mib"]


def test_pressure_unknown_gpu_and_reservations_are_not_hidden(tmp_path):
    _, manager, draft = fixture(tmp_path)
    draft["reservation_mib"] = 20000
    result = preview(manager, [draft])
    assert result["gpus"][0]["reservation_error"]
    assert result["gpus"][0]["draft_mib"] == result["members"][0]["estimate"]["peak_mib"]  # not reservation + peak
    manager.host["gpus"][0]["used_mib"] = 15000
    result = preview(manager, [draft])
    assert result["gpus"][0]["verdict"] == "Over budget"
    assert result["members"][0]["recommendation"]["context_recommended_max"] is None
    manager.host["gpus"] = []
    assert preview(manager, [draft])["gpus"] == []


def test_recommendation_fits_but_next_token_does_not_and_scales_with_concurrency(tmp_path):
    _, manager, draft = fixture(tmp_path)
    manager.host["gpus"][0]["total_mib"] = 11000
    result = preview(manager, [draft])
    best = result["members"][0]["recommendation"]["context_recommended_max"]
    artifact = manager.store.get("artifact", "weights")
    available = 11000 - 2048 - 2048
    config = draft["configuration"]["config"]
    assert estimate(artifact, config | {"ctx-size": best})["peak_mib"] <= available
    assert estimate(artifact, config | {"ctx-size": best + 1})["peak_mib"] > available
    draft["configuration"]["config"]["parallel"] = 2
    assert preview(manager, [draft])["members"][0]["recommendation"]["context_recommended_max"] < best
    draft["configuration"]["config"]["parallel"] = 4
    assert preview(manager, [draft])["members"][0]["recommendation"]["context_recommended_max"] is None


def test_measurement_provenance_does_not_fabricate_internal_breakdown(tmp_path):
    _, manager, draft = fixture(tmp_path)
    artifact = manager.store.get("artifact", "weights")
    result = estimate(artifact, draft["configuration"]["config"], measured=[6000])
    assert result["peak_mib"] == 7156
    assert result["confidence"] == "medium"
    assert result["components"] is None


def test_separate_gpu_budgets_and_model_context_ceiling(tmp_path):
    _, manager, draft = fixture(tmp_path)
    manager.host["gpus"].append({"index": 1, "name": "Second GPU", "total_mib": 32768, "used_mib": 0})
    other = deepcopy(draft) | {"gpu": 1}
    result = preview(manager, [draft, other])
    assert result["gpus"][0]["draft_mib"] == result["gpus"][1]["draft_mib"]
    assert result["gpus"][0]["used_mib"] == 2048
    assert result["gpus"][1]["used_mib"] == 0
    assert result["members"][1]["recommendation"]["context_recommended_max"] == 32768


async def test_preview_endpoint_is_bounded_authenticated_and_side_effect_free(tmp_path):
    app, manager, draft = fixture(tmp_path)
    before = {k: deepcopy(manager.store.list(k)) for k in ("artifact", "runtime", "profile", "deployment", "job")}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            assert (await client.post("/api/resources/preview", json={"members": [draft]})).status_code == 403
            headers = {"X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]}
            response = await client.post("/api/resources/preview", json={"members": [draft]}, headers=headers)
            assert response.status_code == 200, response.text
            assert response.json()["members"][0]["recommendation"]["context_default"] <= 8192
            assert (await client.post("/api/resources/preview", json={"members": [draft] * 65}, headers=headers)).status_code == 422
            bad = deepcopy(draft)
            bad["configuration"]["artifact_id"] = "missing"
            assert (await client.post("/api/resources/preview", json={"members": [bad]}, headers=headers)).status_code == 404
            bad = deepcopy(draft)
            bad["configuration"]["config"]["ctx-size"] = 1e300
            assert (await client.post("/api/resources/preview", json={"members": [bad]}, headers=headers)).status_code == 400
        assert {k: manager.store.list(k) for k in before} == before
    finally:
        await manager.close()
