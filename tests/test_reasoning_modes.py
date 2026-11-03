import copy

import httpx
import pytest

from controlplane.api import create_app
from controlplane.capabilities import inspect
from controlplane.catalog import apply_reasoning, normalize
from controlplane.reasoning import reasoning_presets


def configured():
    return {
        "name": "Synthetic reasoner",
        "config": {},
        "catalog": {
            "reasoning": {
                "default_mode": "research",
                "presets": [
                    {
                        "id": "research",
                        "name": "Research 8K",
                        "enabled": True,
                        "body": {
                            "reasoning_effort": "xhigh",
                            "reasoning_budget": 8192,
                            "chat_template_kwargs": {
                                "enable_thinking": True,
                                "reasoning_effort": "spoon",
                            },
                        },
                    },
                    {
                        "id": "instruct",
                        "enabled": False,
                        "body": {
                            "thinking_budget": 2048,
                            "chat_template_kwargs": {
                                "enable_thinking": False,
                                "reasoning_effort": "ispoon",
                            },
                        },
                    },
                    {"id": "default", "enabled": True, "body": {"thinking_budget": -1}},
                ],
            }
        },
    }


def test_custom_modes_normalize_to_gateway_selectors_and_keep_order():
    profile = configured()
    original = copy.deepcopy(profile)
    catalog = normalize(profile)
    assert profile == original
    assert catalog["reasoning"] == original["catalog"]["reasoning"]
    assert reasoning_presets(catalog) == original["catalog"]["reasoning"]["presets"]
    assert catalog["model"]["variants"] == [
        {"id": "research", "body": {"menagerie_variant": "research"}},
        {"id": "default", "body": {"menagerie_variant": "default"}},
        {"id": "model-default", "body": {"menagerie_variant": "model-default"}},
    ]
    assert normalize(profile | {"catalog": catalog}) == catalog
    catalog["reasoning"]["presets"].pop(0)
    catalog["reasoning"]["default_mode"] = None
    assert [
        v["id"] for v in normalize(profile | {"catalog": catalog})["model"]["variants"]
    ] == ["default"]


def test_template_hint_detection_accepts_custom_efforts_without_guessing_levels():
    assert inspect(
        {
            "chat_template": "{% if reasoning_effort == 'spoon' %}research{% elif 'xhigh' == reasoning_effort %}deep{% endif %}"
        }
    )["reasoning_effort"] == ["spoon", "xhigh"]
    assert (
        inspect({"chat_template": "{{ reasoning_effort }}"})["reasoning_effort"] == []
    )


def test_empty_legacy_default_stays_empty_for_client_deduplication():
    profile = configured()
    profile["catalog"]["reasoning"]["presets"][-1]["body"] = {}
    catalog = normalize(profile)
    assert (
        next(v for v in catalog["model"]["variants"] if v["id"] == "default")["body"]
        == {}
    )
    assert normalize(profile | {"catalog": catalog}) == catalog


def test_unrelated_model_default_variant_is_not_silently_discarded():
    profile = configured()
    profile["catalog"]["model"] = {
        "variants": [{"id": "model-default", "body": {"temperature": 0.2}}]
    }
    with pytest.raises(ValueError, match="reserved"):
        normalize(profile)
    profile["catalog"]["reasoning"]["default_mode"] = None
    assert normalize(profile)["model"]["variants"][0] == {
        "id": "model-default",
        "body": {"temperature": 0.2},
    }


def test_hidden_default_and_custom_named_default_infer_support_stably():
    profile = configured()
    for preset in profile["catalog"]["reasoning"]["presets"]:
        preset["enabled"] = False
    normalized = normalize(profile)
    assert normalized["model"]["capabilities"]["reasoning"] == {"supported": True}
    assert normalize(profile | {"catalog": normalized}) == normalized
    profile["catalog"]["reasoning"] = {
        "presets": [
            {"id": "default", "enabled": True, "body": {"reasoning_budget": 1024}}
        ]
    }
    normalized = normalize(profile)
    assert normalized["model"]["capabilities"]["reasoning"] == {"supported": True}
    assert normalize(profile | {"catalog": normalized}) == normalized


def test_mode_ids_cannot_silently_replace_unrelated_catalog_variants():
    profile = configured()
    profile["catalog"]["model"] = {
        "variants": [{"id": "research", "body": {"temperature": 0.2}}]
    }
    with pytest.raises(ValueError, match="conflicts"):
        normalize(profile)


def test_implicit_default_fills_missing_fields_but_explicit_mode_owns_its_mapping():
    profile = configured()
    body = {
        "messages": [],
        "reasoning_effort": "low",
        "chat_template_kwargs": {"enable_thinking": False, "other": 1},
    }
    original = copy.deepcopy(body)
    implicit = apply_reasoning(body, profile)
    assert implicit["reasoning_effort"] == "low"
    assert implicit["reasoning_budget"] == 8192
    assert implicit["chat_template_kwargs"] == {
        "enable_thinking": False,
        "reasoning_effort": "spoon",
        "other": 1,
    }
    explicit = apply_reasoning(body | {"menagerie_variant": "research"}, profile)
    assert explicit["reasoning_effort"] == "xhigh"
    assert explicit["chat_template_kwargs"]["enable_thinking"] is True
    assert explicit["chat_template_kwargs"]["other"] == 1
    assert (
        apply_reasoning(body | {"menagerie_variant": "model-default"}, profile) == body
    )
    assert body == original
    assert apply_reasoning({"menagerie_variant": "default"}, profile) == {
        "thinking_budget": -1
    }


def test_unexposed_mode_can_be_deployment_default_but_not_explicitly_selected():
    profile = configured()
    profile["catalog"]["reasoning"]["default_mode"] = "instruct"
    assert (
        apply_reasoning({}, profile)["chat_template_kwargs"]["enable_thinking"] is False
    )
    with pytest.raises(ValueError, match="unexposed"):
        apply_reasoning({"menagerie_variant": "instruct"}, profile)
    profile["catalog"]["model"] = {"capabilities": {"reasoning": {"supported": False}}}
    assert apply_reasoning({"messages": []}, profile) == {"messages": []}
    with pytest.raises(ValueError, match="unexposed"):
        apply_reasoning({"menagerie_variant": "research"}, profile)


@pytest.mark.parametrize(
    "content",
    [
        "Explain",
        [
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,fixture"},
            },
            {"type": "text", "text": "Explain"},
        ],
    ],
)
def test_prompt_prefix_is_stateless_preserves_history_tools_and_multimodal_content(
    content,
):
    profile = configured()
    profile["catalog"]["reasoning"]["presets"][0]["prompt_prefix"] = "{REASON:research}"
    body = {
        "menagerie_variant": "research",
        "messages": [
            {"role": "system", "content": "Owner instructions"},
            {"role": "user", "content": "Earlier question"},
            {"role": "assistant", "content": "Earlier reply"},
            {"role": "user", "content": content},
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call",
                        "type": "function",
                        "function": {"name": "lookup", "arguments": "{}"},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call", "content": "result"},
        ],
        "tools": [{"type": "function", "function": {"name": "lookup"}}],
    }
    original = copy.deepcopy(body)
    result = apply_reasoning(body, profile)
    assert result["messages"][:3] == body["messages"][:3]
    assert result["messages"][4:] == body["messages"][4:]
    assert result["tools"] == body["tools"]
    changed = result["messages"][3]["content"]
    if isinstance(content, str):
        assert changed == "{REASON:research}\nExplain"
    else:
        assert changed[0] == {"type": "text", "text": "{REASON:research}\n"}
        assert changed[1:] == content
    assert (
        apply_reasoning(result | {"menagerie_variant": "research"}, profile) == result
    )
    assert body == original
    assert (
        apply_reasoning(body | {"menagerie_variant": "model-default"}, profile)[
            "messages"
        ]
        == body["messages"]
    )


@pytest.mark.parametrize(
    "patch",
    [
        {"id": "model-default"},
        {"id": "has spaces"},
        {"id": "x" * 65},
        {"name": ""},
        {"body": {"messages": []}},
        {"body": {"reasoning_effort": ""}},
        {"body": {"thinking_budget": True}},
        {"body": {"reasoning_budget": -2}},
        {"body": {"chat_template_kwargs": {"enable_thinking": "false"}}},
        {"body": {"chat_template_kwargs": {"tools": []}}},
        {"body": {"chat_template_kwargs": {"constructor": {}}}},
        {"body": {"chat_template_kwargs": {"value": float("inf")}}},
        {"body": {"chat_template_kwargs": {"value": 10**1000}}},
        {"prompt_prefix": "x" * 4097},
    ],
)
def test_modes_validate_bounds_and_cannot_replace_messages_or_runtime_controls(patch):
    profile = configured()
    profile["catalog"]["reasoning"]["presets"][0].update(patch)
    with pytest.raises(ValueError):
        normalize(profile)


def test_default_reference_duplicate_ids_and_mode_count_are_validated():
    profile = configured()
    profile["catalog"]["reasoning"]["default_mode"] = "missing"
    with pytest.raises(ValueError, match="Default"):
        normalize(profile)
    profile = configured()
    profile["catalog"]["reasoning"]["presets"] *= 2
    with pytest.raises(ValueError, match="duplicate"):
        normalize(profile)
    profile["catalog"]["reasoning"]["presets"] *= 32
    with pytest.raises(ValueError, match="64"):
        normalize(profile)


async def test_gateway_applies_defaults_modes_and_prefixes_before_any_runtime_load(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path)
    manager = app.state.manager
    profile = configured()
    profile["catalog"]["reasoning"]["presets"][0]["prompt_prefix"] = "{REASON:research}"
    deployment = app.state.store.put(
        "deployment",
        {
            "id": "d",
            "name": "Synthetic",
            "alias": "synthetic",
            "enabled": True,
            "state": "STOPPED",
            "profile_snapshot": profile,
            "port": 8120,
        },
    )
    acquisitions = []
    sent = []

    async def acquire(alias):
        acquisitions.append(alias)
        return deployment

    monkeypatch.setattr(manager, "acquire", acquire)
    monkeypatch.setattr(manager, "release", lambda row: None)

    def upstream(request):
        import json

        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    await manager.client.aclose()
    manager.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            for selector in ["missing", "instruct", None, []]:
                response = await client.post(
                    "/v1/chat/completions",
                    json={
                        "model": "synthetic",
                        "menagerie_variant": selector,
                        "messages": [],
                    },
                )
                assert response.status_code == 400
            assert (
                await client.post(
                    "/v1/chat/completions", json={"model": "synthetic", "messages": []}
                )
            ).status_code == 400
            assert not acquisitions and not sent
            for stream in [False, True]:
                response = await client.post(
                    "/v1/chat/completions",
                    json={
                        "model": "synthetic",
                        "messages": [{"role": "user", "content": "Hello"}],
                        "stream": stream,
                    },
                )
                assert response.status_code == 200
                assert sent[-1]["messages"][0]["content"] == "{REASON:research}\nHello"
                assert sent[-1]["reasoning_budget"] == 8192
                assert "menagerie_variant" not in sent[-1]
            response = await client.post(
                "/v1/chat/completions",
                json={
                    "model": "synthetic",
                    "menagerie_variant": "model-default",
                    "messages": [],
                },
            )
            assert response.status_code == 200
            assert "reasoning_effort" not in sent[-1]
    finally:
        await manager.close()
