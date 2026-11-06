"""Capability evidence uses synthetic metadata only; no models are executed."""

from copy import deepcopy

import httpx

from controlplane import adapters
from controlplane.api import create_app
from controlplane.capabilities import effective, inspect, recommendations


def test_missing_metadata_and_model_names_never_prove_unsupported_or_controls():
    result = inspect(
        {"name": "thinking-reasoning-vision", "config": None, "tokenizer_config": None}
    )
    assert all(value["status"] == "unknown" for value in result["findings"].values())
    assert not result["findings"]["reasoning"]["evidence"]


def test_markers_do_not_imply_toggle_effort_or_output_separation():
    findings = inspect({"chat_template": "<think>{{ content }}</think>"})["findings"]
    assert findings["reasoning"]["status"] == "supported"
    for key in ("reasoning_control", "reasoning_budget", "reasoning_output"):
        assert findings[key]["status"] == "unknown"


def test_template_comments_do_not_advertise_controls():
    finding = inspect({"chat_template": "{# enable_thinking <think> #}hello"})[
        "findings"
    ]
    assert finding["reasoning"]["status"] == "unknown"
    assert finding["reasoning_control"]["status"] == "unknown"


def test_selected_custom_template_does_not_rewrite_model_findings():
    result = effective(
        {"metadata": {"chat_template": "{% if enable_thinking %}<think>{% endif %}"}},
        {"engine": "llama.cpp"},
        {"config": {}},
        template="{{ content }}",
        template_source="user",
    )
    assert result["model"]["reasoning_control"]["status"] == "supported"
    assert result["effective"]["reasoning_control"]["status"] == "unknown"
    result = effective(
        {"metadata": {}},
        {"engine": "llama.cpp"},
        {"config": {}},
        template="{% if enable_thinking %}<think>{% endif %}",
        template_source="user",
    )
    assert result["model"]["reasoning"]["status"] == "unknown"
    assert result["effective"]["reasoning"]["evidence"][0]["source"] == "user"


def test_runtime_modalities_are_whitelisted_observations_not_template_content():
    facts = adapters.runtime_observation(
        {
            "modalities": {"vision": True, "audio": False, "prompt": "private"},
            "prompt": "private",
        }
    )
    assert facts["capabilities"] == {"input_image": True, "input_audio": False}
    assert "private" not in str(facts)
    result = effective(
        {"metadata": {}}, {"engine": "llama.cpp"}, {"config": {}}, observation=facts
    )
    assert result["model"]["input_image"]["status"] == "unknown"
    assert result["effective"]["input_image"]["status"] == "supported"
    assert result["effective"]["input_audio"]["status"] == "unsupported"


def test_template_controls_are_distinct_and_named_templates_are_inspected():
    findings = inspect(
        {
            "tokenizer_config": {
                "chat_template": [
                    {
                        "name": "default",
                        "template": "{% if enable_thinking %}<think>{% endif %}",
                    },
                ]
            }
        }
    )["findings"]
    assert findings["reasoning_control"]["value"] == {"type": "toggle", "levels": []}
    assert findings["reasoning_mechanism"]["value"] == "template-argument"
    findings = inspect(
        {
            "chat_template": "{% if reasoning_effort == 'low' %}a{% elif 'high' == reasoning_effort %}b{% endif %}"
        }
    )["findings"]
    assert findings["reasoning_control"]["value"] == {
        "type": "effort-levels",
        "levels": ["high", "low"],
    }


def test_conflicting_collected_evidence_is_retained():
    result = inspect(
        {
            "chat_template": "<think>",
            "discovery": {
                "findings": {
                    "reasoning": {
                        "status": "unsupported",
                        "evidence": [
                            {
                                "source": "model-card",
                                "detail": "Publisher says no reasoning",
                                "confidence": "medium",
                            }
                        ],
                    }
                }
            },
        }
    )["findings"]["reasoning"]
    assert result["status"] == "unknown"
    assert result["conflicting"]
    assert len(result["evidence"]) == 2


def test_projector_configuration_does_not_prove_compatibility_or_change_model():
    artifact = {"metadata": {"config": {"vision_config": {}}}}
    runtime = {"engine": "llama.cpp", "capabilities": {"flags": ["mmproj"]}}
    profile = {"config": {}, "catalog": {}}
    original = deepcopy(profile)
    missing = effective(artifact, runtime, profile)
    assert missing["model"]["input_image"]["status"] == "supported"
    assert missing["effective"]["input_image"]["status"] == "unsupported"
    assert missing["warnings"]
    profile["config"]["mmproj"] = "synthetic-projector.gguf"
    configured = effective(artifact, runtime, profile)
    assert configured["effective"]["input_image"]["status"] == "unknown"
    assert (
        effective(artifact, {"engine": "vllm"}, original)["effective"]["input_image"][
            "status"
        ]
        == "unknown"
    )


def test_recommendations_are_optional_schema_validated_and_never_persisted():
    metadata = {"generation_config": {"temperature": 0.6, "top_k": 20, "min_p": 2}}
    before = deepcopy(metadata)
    published = inspect(metadata)
    values = recommendations(
        {"discovery": published},
        {"temp": {"type": "number", "min": 0, "max": 5}, "min-p": {"min": 0, "max": 1}},
    )
    assert [entry["compatible"] for entry in values] == [True, False, False]
    assert metadata == before


async def test_preview_is_read_only_and_keeps_manual_declarations_unverified(tmp_path):
    app = create_app(tmp_path / "state")
    store = app.state.store
    store.put(
        "artifact", {"id": "model", "metadata": {"config": {"vision_config": {}}}}
    )
    store.put(
        "runtime",
        {"id": "runtime", "engine": "llama.cpp", "capabilities": {"flags": []}},
    )
    before = store.get("artifact", "model")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        token = (await client.get("/api/status")).json()["csrf_token"]
        response = await client.post(
            "/api/capabilities/preview",
            headers={"X-Menagerie-Token": token},
            json={
                "configuration": {
                    "name": "Synthetic",
                    "artifact_id": "model",
                    "runtime_id": "runtime",
                    "catalog": {
                        "model": {"capabilities": {"input": ["text", "image"]}}
                    },
                }
            },
        )
        assert response.status_code == 200, response.text
        image = response.json()["effective"]["input_image"]
        assert image["status"] == "unsupported"
        assert image["conflicting"]
        assert image["evidence"][-1]["source"] == "user"
    assert store.get("artifact", "model") == before
    assert store.list("profile") == []


async def test_observed_preview_requires_matching_session_and_requested_configuration(
    tmp_path,
):
    app = create_app(tmp_path / "state")
    store = app.state.store
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        token = (await client.get("/api/status")).json()["csrf_token"]
    store.put("artifact", {"id": "model", "metadata": {}})
    store.put("runtime", {"id": "runtime", "engine": "llama.cpp"})
    profile = {
        "name": "Synthetic",
        "artifact_id": "model",
        "runtime_id": "runtime",
        "config": {},
        "raw_args": [],
        "catalog": {},
    }
    deployment = store.put(
        "deployment",
        {
            "id": "deployment",
            "state": "READY",
            "session_id": "session",
            "profile_snapshot": profile,
        },
    )
    store.put(
        "runtime_observation",
        {
            "id": "deployment",
            "session_id": "session",
            "facts": {"capabilities": {"input_image": True}},
        },
        historical=False,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        headers = {"X-Menagerie-Token": token}
        body = {"deployment_id": "deployment", "configuration": profile}
        response = await client.post(
            "/api/capabilities/preview", headers=headers, json=body
        )
        assert response.json()["effective"]["input_image"]["status"] == "supported"
        body["configuration"] = profile | {"config": {"mmproj": "different-projector"}}
        response = await client.post(
            "/api/capabilities/preview", headers=headers, json=body
        )
        assert response.json()["effective"]["input_image"]["status"] == "unknown"
        store.put(
            "runtime_observation",
            {
                "id": "deployment",
                "session_id": "previous-session",
                "facts": {"capabilities": {"input_image": True}},
            },
            historical=False,
        )
        body["configuration"] = profile
        response = await client.post(
            "/api/capabilities/preview", headers=headers, json=body
        )
        assert response.json()["effective"]["input_image"]["status"] == "unknown"
    assert store.get("deployment", "deployment") == deployment
