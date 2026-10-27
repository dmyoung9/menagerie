import copy
import json
import struct

import httpx
import pytest

from controlplane import adapters
from controlplane.api import create_app
from controlplane.capabilities import inspect, ollama
from controlplane.catalog import apply_reasoning, normalize
from controlplane.jobs import Jobs


def profile():
    return {"name": "Reasoner", "config": {}, "catalog": {"reasoning": {"presets": [
        {"id": "default", "enabled": True, "body": {}},
        {"id": "instant", "enabled": True, "body": {"chat_template_kwargs": {"enable_thinking": False}}},
        {"id": "low", "enabled": False, "body": {"reasoning_effort": "low"}},
        {"id": "high", "enabled": True, "body": {"reasoning_effort": "high"}},
    ]}}}


def test_explicit_exposure_and_normalization_are_stable():
    p = profile()
    original = copy.deepcopy(p)
    result = normalize(p)
    assert p == original
    assert [v["id"] for v in result["model"]["variants"]] == ["default", "instant", "high"]
    assert result["model"]["capabilities"]["reasoning"] == {"supported": True}
    assert result["model"]["compatibility"]["reasoningField"] == "reasoning_content"
    assert normalize(p | {"catalog": result}) == result


def test_selector_preserves_multimodal_payload_and_merges_controls():
    body = {"model": "reasoner", "menagerie_variant": "instant", "chat_template_kwargs": {"other": 1},
            "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}}]}]}
    result = apply_reasoning(body, profile())
    assert result["chat_template_kwargs"] == {"other": 1, "enable_thinking": False}
    assert result["messages"] == body["messages"]
    assert "menagerie_variant" not in result
    assert "menagerie_variant" in body
    assert apply_reasoning(body | {"menagerie_variant": "default"}, profile()) == {k: v for k, v in body.items() if k != "menagerie_variant"}
    with pytest.raises(ValueError, match="unexposed"):
        apply_reasoning(body | {"menagerie_variant": "low"}, profile())
    # Ordinary callers may send their own controls without using the selector.
    assert apply_reasoning({"reasoning_effort": "low"}, profile()) == {"reasoning_effort": "low"}


def test_reasoning_support_is_independent_of_preset_exposure():
    p = profile()
    p["catalog"]["reasoning"]["presets"] = []
    p["catalog"]["model"] = {"capabilities": {"tools": False, "input": ["text"], "output": ["text"], "reasoning": {"supported": True, "effort": ["low", "high"]}}, "compatibility": {"reasoningField": "reasoning"}}
    model = normalize(p)["model"]
    assert model["variants"] == []
    assert model["capabilities"]["reasoning"] == {"supported": True}
    assert model["compatibility"]["reasoningField"] == "reasoning"


@pytest.mark.parametrize("preset", [
    {"id": "instant", "enabled": True, "body": {}},
    {"id": "default", "enabled": True, "body": {"reasoning_effort": "high"}},
    {"id": "high", "enabled": True, "body": {"model": "other"}},
    {"id": "high", "enabled": True, "body": {"reasoning_budget": -1}},
    {"id": "high", "enabled": True, "body": {"thinking_budget": True}},
    {"id": "high", "enabled": True, "body": {"reasoning_effort": []}},
    {"id": "instant", "enabled": True, "body": {"chat_template_kwargs": {"enable_thinking": "false"}}},
])
def test_reject_invalid_reasoning_mappings(preset):
    p = profile()
    p["catalog"]["reasoning"]["presets"] = [preset]
    with pytest.raises(ValueError):
        normalize(p)


def test_metadata_hints_do_not_invent_reasoning_off_or_effort_levels():
    hints = inspect({"config": {"vision_config": {"model_type": "clip"}}, "tokenizer_config": {"chat_template": "{% if enable_thinking %}<think>{% endif %}{% if tools %}tools{% endif %}"}})
    assert hints["input"] == ["text", "image"]
    assert hints["thinking_toggle"] and hints["tools"] and hints["reasoning"]
    assert not inspect({})["reasoning"]
    assert inspect({"tokenizer.chat_template": "<think>"})["reasoning"]
    assert not inspect({"tokenizer.chat_template": "<think>"})["thinking_toggle"]
    assert not ollama({"capabilities": ["thinking", "vision"]})["thinking_toggle"]


def test_effort_detection_requires_explicit_levels_in_template():
    assert inspect({"chat_template": "{{ reasoning_effort }}"})["reasoning_effort"] == []
    hints = inspect({"chat_template": "{% if reasoning_effort == 'low' %}low{% elif 'high' == reasoning_effort %}high{% endif %}"})
    assert hints["reasoning_effort"] == ["high", "low"]


def test_local_gguf_retains_template_but_not_tokenizer_arrays(tmp_path):
    def string(value):
        raw = value.encode()
        return struct.pack("<Q", len(raw)) + raw
    weights = tmp_path / "model.gguf"
    weights.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 0, 2)
        + string("tokenizer.chat_template") + struct.pack("<I", 8) + string("{% if enable_thinking %}<think>{% endif %}")
        + string("tokenizer.ggml.tokens") + struct.pack("<IIQ", 9, 8, 1) + string("ignored"))
    metadata = adapters.inspect_artifact(weights)["metadata"]
    assert "tokenizer.ggml.tokens" not in metadata
    assert inspect(metadata)["thinking_toggle"]


async def test_gateway_and_catalog_use_deployment_presets(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    manager = app.state.manager
    store = app.state.store
    p = profile() | {"artifact_id": "model", "runtime_id": "engine", "raw_args": []}
    p["catalog"] = normalize(p)
    store.put("artifact", {"id": "model", "format": "gguf"})
    store.put("runtime", {"id": "engine"})
    d = store.put("deployment", {"id": "d", "name": "Reasoner", "alias": "reasoner", "profile_snapshot": p,
        "state": "READY", "enabled": True, "residency": "pinned", "port": 8120})
    async def acquire(alias):
        assert alias == "reasoner"
        return d
    released = []
    monkeypatch.setattr(manager, "acquire", acquire)
    monkeypatch.setattr(manager, "release", lambda row: released.append(row["id"]))
    requests = []
    def upstream(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})
    await manager.client.aclose()
    manager.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            rows = (await client.get("/v1/models")).json()["data"]
            assert [v["id"] for v in rows[0]["menagerie"]["catalog"]["model"]["variants"]] == ["default", "instant", "high"]
            for stream in (False, True):
                response = await client.post("/v1/chat/completions", json={"model": "reasoner", "menagerie_variant": "high", "messages": [], "stream": stream})
                assert response.status_code == 200
                assert requests[-1]["reasoning_effort"] == "high"
                assert "menagerie_variant" not in requests[-1]
            response = await client.post("/v1/chat/completions", json={"model": "reasoner", "menagerie_variant": "low"})
            assert response.status_code == 400
            assert len(requests) == 2
            assert released == ["d", "d"]
    finally:
        await manager.client.aclose()


async def test_hf_inspects_only_bounded_metadata_at_pinned_revision(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from controlplane import jobs
    sha = "a" * 40
    files = [SimpleNamespace(rfilename=name, size=size, lfs=None) for name, size in
             [("config.json", 100), ("tokenizer_config.json", 200), ("chat_template.jinja", 2 * 1024 * 1024), ("model.gguf", 10**10), ("mmproj-f16.gguf", 10**8)]]
    monkeypatch.setattr(jobs, "HfApi", lambda: SimpleNamespace(model_info=lambda *a, **k: SimpleNamespace(sha=sha, siblings=files)))
    seen = []
    def metadata(request):
        seen.append(str(request.url))
        assert f"/resolve/{sha}/" in str(request.url)
        return httpx.Response(200, json={"vision_config": {"type": "vision"}} if request.url.path.endswith("config.json") and not request.url.path.endswith("tokenizer_config.json") else {"chat_template": "{% if enable_thinking %}<think>{% endif %}"})
    app = create_app(tmp_path)
    manager = app.state.manager
    await manager.client.aclose()
    manager.client = httpx.AsyncClient(transport=httpx.MockTransport(metadata))
    try:
        result = await Jobs(manager).hf_files("org/model")
        assert result["revision"] == sha
        assert result["capabilities"]["thinking_toggle"]
        assert result["capabilities"]["input"] == ["text", "image"]
        assert result["capabilities"]["dependencies"] == [{"name": "mmproj-f16.gguf", "size": 10**8, "status": "candidate", "kind": "projector"}]
        assert len(seen) == 2
    finally:
        await manager.client.aclose()


async def test_projector_is_explicit_pinned_and_checksummed(tmp_path, monkeypatch):
    import hashlib
    from controlplane import jobs as module
    app = create_app(tmp_path / "state")
    jobs = Jobs(app.state.manager)
    weights = tmp_path / "model.gguf"
    weights.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 0, 0))
    projector = tmp_path / "mmproj.gguf"
    projector.write_bytes(b"companion")
    files = [{"name": p.name, "size": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in (weights, projector)]
    async def listing(*args):
        return {"files": files, "capabilities": {"dependencies": [{"name": projector.name}]}}
    monkeypatch.setattr(jobs, "hf_files", listing)
    monkeypatch.setattr(jobs, "progress", lambda *args: None)
    calls = []
    def download(**kwargs):
        calls.append(kwargs)
        return str(weights if kwargs["filename"] == weights.name else projector)
    monkeypatch.setattr(module, "hf_hub_download", download)
    try:
        result = await jobs.download("job", "org/model", "a" * 40, weights.name)
        assert len(calls) == 1
        assert "projector" not in result["metadata"]
        result = await jobs.download("job", "org/model", "a" * 40, weights.name, projector.name)
        assert result["metadata"]["projector"]["path"] == str(projector)
        assert all(c["revision"] == "a" * 40 for c in calls)
        files[1]["sha256"] = "0" * 64
        with pytest.raises(ValueError, match="Projector checksum mismatch"):
            await jobs.download("job", "org/model", "a" * 40, weights.name, projector.name)
        assert app.state.store.list("artifact")[0]["metadata"]["projector"]["sha256"] != "0" * 64
    finally:
        await app.state.manager.client.aclose()
