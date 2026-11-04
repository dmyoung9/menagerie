import json
import math
import os
import tempfile
from copy import deepcopy

from .reasoning import (
    LEGACY_MODES,
    MODEL_DEFAULT,
    generated_variant,
    reasoning_disabled,
    reasoning_presets,
)
from .reasoning import apply_reasoning as apply_reasoning


def costs(value=None):
    rows = value if isinstance(value, list) else [value or {"input": 0, "output": 0}]
    result = []
    threshold = 0
    for i, row in enumerate(rows):
        row = deepcopy(row)
        row.setdefault("cache", {})
        for k in ("read", "write"):
            row["cache"].setdefault(k, 0)
        for v in [
            row.get("input"),
            row.get("output"),
            row["cache"]["read"],
            row["cache"]["write"],
        ]:
            if type(v) not in (int, float) or not math.isfinite(v) or v < 0:
                raise ValueError("Invalid catalog pricing")
        if i:
            tier = row.get("tier", {})
            if (
                tier.get("type") != "context"
                or type(tier.get("size")) is not int
                or tier["size"] <= threshold
            ):
                raise ValueError("Invalid context price tier")
            threshold = tier["size"]
        elif "tier" in row:
            raise ValueError("Base price cannot have a tier")
        result.append(row)
    return result


def normalize(profile, alias=None):
    catalog = deepcopy(profile.get("catalog", {}))
    model = catalog.setdefault("model", {})
    catalog["version"] = 2
    catalog["catalog_id"] = (
        catalog.get("catalog_id") or alias or profile.get("id") or profile["name"]
    )
    model.setdefault("name", profile["name"])
    model.setdefault("enabled", True)
    model.setdefault(
        "capabilities", {"tools": False, "input": ["text"], "output": ["text"]}
    )
    caps = model["capabilities"]
    if type(caps.get("tools")) is not bool or any(
        not isinstance(caps.get(k), list)
        or not caps[k]
        or not all(v in {"text", "image", "audio", "video"} for v in caps[k])
        for k in ("input", "output")
    ):
        raise ValueError("Invalid declared capabilities")
    model.setdefault("variants", [])
    if not isinstance(model["variants"], list) or any(
        not isinstance(v.get("id"), str) or not v["id"] for v in model["variants"]
    ):
        raise ValueError("Invalid catalog variants")
    if len({v["id"] for v in model["variants"]}) != len(model["variants"]):
        raise ValueError("Duplicate variant IDs")
    if "reasoning" in catalog:
        presets = reasoning_presets(catalog)
        declared = caps.get("reasoning")
        disabled = reasoning_disabled(catalog)
        mode_ids = {p["id"] for p in presets}
        owned = LEGACY_MODES | mode_ids
        for variant in model["variants"]:
            if variant["id"] in mode_ids - LEGACY_MODES and not generated_variant(
                variant
            ):
                body = variant.get("body", {})
                settings = variant.get("settings", {})
                if (
                    not isinstance(body, dict)
                    or set(body)
                    - {
                        "reasoning_effort",
                        "chat_template_kwargs",
                        "reasoning_budget",
                        "thinking_budget",
                    }
                    or not isinstance(settings, dict)
                    or set(settings) - {"reasoningEffort"}
                ):
                    raise ValueError(
                        "Reasoning mode ID conflicts with an unrelated catalog variant"
                    )
        if catalog["reasoning"].get("default_mode") and any(
            v["id"] == MODEL_DEFAULT and not generated_variant(v)
            for v in model["variants"]
        ):
            raise ValueError(
                "The model-default variant ID is reserved when a deployment default is configured"
            )
        model["variants"] = [
            v
            for v in model["variants"]
            if v["id"] not in owned and not generated_variant(v)
        ]
        model["variants"] += [
            {
                "id": p["id"],
                "body": (
                    {}
                    if p["id"] == "default"
                    and not p.get("body")
                    and not p.get("prompt_prefix")
                    else {"menagerie_variant": p["id"]}
                ),
            }
            for p in presets
            if p["enabled"]
        ]
        if catalog["reasoning"].get("default_mode"):
            model["variants"].append(
                {"id": MODEL_DEFAULT, "body": {"menagerie_variant": MODEL_DEFAULT}}
            )
        # Explicit variants own exposure; don't ask clients to synthesize extra ones.
        supported = declared is True or (
            isinstance(declared, dict) and declared.get("supported") is True
        )
        caps["reasoning"] = {
            "supported": not disabled
            and (
                supported
                or bool(catalog["reasoning"].get("default_mode"))
                or any(
                    p["enabled"]
                    and (
                        p["id"] != "default" or p.get("body") or p.get("prompt_prefix")
                    )
                    for p in presets
                )
            )
        }
    if isinstance(caps.get("reasoning"), dict) and caps["reasoning"].get("supported"):
        model.setdefault("compatibility", {}).setdefault(
            "reasoningField", "reasoning_content"
        )
    model["cost"] = costs(model.get("cost"))
    context = profile["config"].get(
        "ctx-size", profile["config"].get("max-model-len", 4096)
    ) // profile["config"].get("parallel", 1)
    limits = model.setdefault("limit", {})
    limits["context"] = context
    limits["output"] = min(limits.get("output", 1024), context)
    if type(limits["output"]) is not int or limits["output"] <= 0:
        raise ValueError("Output limit must be positive")
    return catalog


def export_config(root, rows, gateway_url="http://127.0.0.1:8001/v1"):
    models = {}
    for row in rows:
        catalog = row["menagerie"]["catalog"]
        model = deepcopy(catalog["model"])
        model["modelID"] = row["id"]
        model["disabled"] = not model.pop("enabled", True)
        models[catalog["catalog_id"]] = model
    config = {
        "$schema": "https://opencode.ai/config.json",
        "providers": {
            "menagerie": {
                "name": "Menagerie",
                "package": "@opencode/ai/providers/openai-compatible",
                "settings": {"baseURL": gateway_url},
                "models": models,
            }
        },
    }
    path = root / "opencode-managed.json"
    text = json.dumps(config, indent=2) + "\n"
    if path.exists() and path.read_text() == text:
        return path
    fd, tmp = tempfile.mkstemp(dir=root, prefix=".opencode-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return path
