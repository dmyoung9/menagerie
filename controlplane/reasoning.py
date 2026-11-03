"""Deployment-owned reasoning modes and bounded, request-local transformations."""

import json
import math
import re
from copy import deepcopy

LEGACY_MODES = {"default", "instant", "low", "medium", "high"}
MODEL_DEFAULT = "model-default"
MODE_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}")
CONTROL_KEY = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]{0,63}")


def reasoning_disabled(catalog):
    declared = catalog.get("model", {}).get("capabilities", {}).get("reasoning")
    return declared is False or (
        isinstance(declared, dict) and declared.get("supported") is False
    )


def _template_value(value, depth=0):
    if depth > 4:
        return False
    if value is None or type(value) in (bool, str):
        return not isinstance(value, str) or len(value) <= 4096
    if type(value) is int:
        return abs(value) <= 2**53
    if type(value) is float:
        return math.isfinite(value)
    if isinstance(value, list):
        return len(value) <= 64 and all(_template_value(v, depth + 1) for v in value)
    if isinstance(value, dict):
        return len(value) <= 64 and all(
            isinstance(k, str)
            and CONTROL_KEY.fullmatch(k)
            and k not in {"__proto__", "prototype", "constructor"}
            and _template_value(v, depth + 1)
            for k, v in value.items()
        )
    return False


def reasoning_presets(catalog):
    reasoning = catalog.get("reasoning", {})
    if not isinstance(reasoning, dict):
        raise ValueError("Reasoning configuration must be an object")
    presets = reasoning.get("presets", [])
    if not isinstance(presets, list) or len(presets) > 64:
        raise ValueError("Reasoning modes must be a list of at most 64 entries")
    seen = set()
    for preset in presets:
        if (
            not isinstance(preset, dict)
            or not isinstance(preset.get("id"), str)
            or not MODE_ID.fullmatch(preset["id"])
            or preset["id"] == MODEL_DEFAULT
            or preset["id"] in seen
            or type(preset.get("enabled")) is not bool
        ):
            raise ValueError("Invalid, reserved or duplicate reasoning mode ID")
        seen.add(preset["id"])
        if "name" in preset and (
            not isinstance(preset["name"], str)
            or not preset["name"].strip()
            or len(preset["name"]) > 80
        ):
            raise ValueError("Reasoning mode names must contain 1–80 characters")
        prefix = preset.get("prompt_prefix", "")
        if not isinstance(prefix, str) or len(prefix) > 4096 or "\0" in prefix:
            raise ValueError("Reasoning prompt prefix exceeds its limit or is invalid")
        body = preset.get("body", {})
        if not isinstance(body, dict) or set(body) - {
            "reasoning_effort",
            "chat_template_kwargs",
            "reasoning_budget",
            "thinking_budget",
        }:
            raise ValueError(
                "Reasoning modes may only override reasoning request controls"
            )
        if "reasoning_effort" in body and (
            not isinstance(body["reasoning_effort"], str)
            or not body["reasoning_effort"].strip()
            or len(body["reasoning_effort"]) > 128
        ):
            raise ValueError("Invalid reasoning effort")
        for key in ("reasoning_budget", "thinking_budget"):
            if key in body and (
                type(body[key]) is not int or not -1 <= body[key] <= 1048576
            ):
                raise ValueError("Invalid reasoning token budget")
        if "chat_template_kwargs" in body:
            kwargs = body["chat_template_kwargs"]
            if (
                not isinstance(kwargs, dict)
                or not _template_value(kwargs)
                or len(json.dumps(kwargs)) > 16384
                or set(kwargs)
                & {
                    "messages",
                    "tools",
                    "add_generation_prompt",
                    "bos_token",
                    "eos_token",
                }
            ):
                raise ValueError("Invalid or reserved reasoning template arguments")
            if (
                "enable_thinking" in kwargs
                and type(kwargs["enable_thinking"]) is not bool
            ):
                raise ValueError("enable_thinking must be boolean")
    default = reasoning.get("default_mode")
    if default is not None and (not isinstance(default, str) or default not in seen):
        raise ValueError("Default reasoning mode must reference a saved mode")
    return presets


def _prefix_message(result, prefix):
    messages = result.get("messages")
    if not isinstance(messages, list):
        raise ValueError("Prompt-prefix modes require a user message")
    message = next(
        (
            m
            for m in reversed(messages)
            if isinstance(m, dict) and m.get("role") == "user"
        ),
        None,
    )
    if message is None:
        raise ValueError("Prompt-prefix modes require a user message")
    content = message.get("content")
    if isinstance(content, str):
        if not content.startswith(prefix + "\n"):
            message["content"] = prefix + "\n" + content
    elif isinstance(content, list):
        if not (
            content
            and isinstance(content[0], dict)
            and content[0].get("type") == "text"
            and str(content[0].get("text", "")).startswith(prefix + "\n")
        ):
            message["content"] = [{"type": "text", "text": prefix + "\n"}, *content]
    else:
        raise ValueError("Prompt-prefix modes require text or multimodal user content")


def apply_reasoning(body, profile):
    """Explicit modes override mapped keys; implicit defaults fill missing keys only."""
    result = deepcopy(body)
    catalog = profile.get("catalog", {})
    explicit = "menagerie_variant" in result
    selected = result.pop("menagerie_variant", None)
    if explicit and (not isinstance(selected, str) or not selected):
        raise ValueError("Invalid reasoning mode selector")
    if explicit and selected == MODEL_DEFAULT:
        return result
    if not explicit:
        selected = catalog.get("reasoning", {}).get("default_mode")
        if selected is None:
            return result
    preset = next(
        (
            p
            for p in reasoning_presets(catalog)
            if p["id"] == selected and (p["enabled"] or not explicit)
        ),
        None,
    )
    if preset is None:
        raise ValueError("Unknown or unexposed reasoning option")
    override = deepcopy(preset.get("body", {}))
    if "chat_template_kwargs" in override:
        current = result.get("chat_template_kwargs", {})
        if not isinstance(current, dict):
            raise ValueError("chat_template_kwargs must be an object")
        mapped = override.pop("chat_template_kwargs")
        result["chat_template_kwargs"] = (
            current | mapped if explicit else mapped | current
        )
    result = result | override if explicit else override | result
    if preset.get("prompt_prefix"):
        _prefix_message(result, preset["prompt_prefix"])
    return result


def generated_variant(variant):
    body = variant.get("body", {})
    return isinstance(body, dict) and body == {"menagerie_variant": variant.get("id")}
