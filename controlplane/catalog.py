import json
import math
import os
import tempfile
from copy import deepcopy


REASONING_OPTIONS = {"default", "instant", "low", "medium", "high"}


def reasoning_presets(catalog):
    reasoning = catalog.get("reasoning", {})
    if not isinstance(reasoning, dict):
        raise ValueError("Reasoning configuration must be an object")
    presets = reasoning.get("presets", [])
    if not isinstance(presets, list):
        raise ValueError("Reasoning presets must be a list")
    seen = set()
    for preset in presets:
        if not isinstance(preset, dict) or not isinstance(preset.get("id"), str) or preset["id"] not in REASONING_OPTIONS or preset["id"] in seen or type(preset.get("enabled")) is not bool:
            raise ValueError("Invalid or duplicate reasoning preset")
        seen.add(preset["id"])
        body = preset.get("body", {})
        if not isinstance(body, dict) or set(body) - {"reasoning_effort", "chat_template_kwargs", "reasoning_budget", "thinking_budget"}:
            raise ValueError("Reasoning presets may only override reasoning request controls")
        if "reasoning_effort" in body and (not isinstance(body["reasoning_effort"], str) or body["reasoning_effort"] not in {"none", "low", "medium", "high"}):
            raise ValueError("Invalid reasoning effort")
        for key in ("reasoning_budget", "thinking_budget"):
            if key in body and (type(body[key]) is not int or not 0 <= body[key] <= 1048576):
                raise ValueError("Invalid reasoning token budget")
        if "chat_template_kwargs" in body and (not isinstance(body["chat_template_kwargs"], dict) or set(body["chat_template_kwargs"]) != {"enable_thinking"} or type(body["chat_template_kwargs"]["enable_thinking"]) is not bool):
            raise ValueError("Only boolean enable_thinking is supported in reasoning template controls")
        if preset["id"] == "default" and body:
            raise ValueError("Default must leave request behavior unchanged")
        if preset["id"] != "default" and preset["enabled"] and not body:
            raise ValueError("Exposed reasoning presets need an explicit request mapping")
    return presets


def apply_reasoning(body, profile):
    """Optional selector for clients without native catalog-variant support."""
    result = deepcopy(body)
    selected = result.pop("menagerie_variant", None)
    if selected is None:
        return result
    preset = next((p for p in reasoning_presets(profile.get("catalog", {})) if p["id"] == selected and p["enabled"]), None)
    if preset is None:
        raise ValueError("Unknown or unexposed reasoning option")
    override = preset.get("body", {})
    if "chat_template_kwargs" in override:
        current = result.get("chat_template_kwargs", {})
        if not isinstance(current, dict):
            raise ValueError("chat_template_kwargs must be an object")
        result["chat_template_kwargs"] = current | override["chat_template_kwargs"]
    result.update({k: v for k, v in override.items() if k != "chat_template_kwargs"})
    return result


def costs(value=None):
    rows = value if isinstance(value, list) else [value or {"input": 0, "output": 0}]
    result = []
    threshold = 0
    for i, row in enumerate(rows):
        row = deepcopy(row)
        row.setdefault("cache", {})
        for k in ("read", "write"):
            row["cache"].setdefault(k, 0)
        for v in [row.get("input"), row.get("output"), row["cache"]["read"], row["cache"]["write"]]:
            if type(v) not in (int, float) or not math.isfinite(v) or v < 0:
                raise ValueError("Invalid catalog pricing")
        if i:
            tier = row.get("tier", {})
            if tier.get("type") != "context" or type(tier.get("size")) is not int or tier["size"] <= threshold:
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
    catalog["catalog_id"] = catalog.get("catalog_id") or alias or profile.get("id") or profile["name"]
    model.setdefault("name", profile["name"])
    model.setdefault("enabled", True)
    model.setdefault("capabilities", {"tools": False, "input": ["text"], "output": ["text"]})
    caps = model["capabilities"]
    if type(caps.get("tools")) is not bool or any(not isinstance(caps.get(k), list) or not caps[k] or not all(v in {"text", "image", "audio", "video"} for v in caps[k]) for k in ("input", "output")):
        raise ValueError("Invalid declared capabilities")
    model.setdefault("variants", [])
    if not isinstance(model["variants"], list) or any(not isinstance(v.get("id"), str) or not v["id"] for v in model["variants"]):
        raise ValueError("Invalid catalog variants")
    if len({v["id"] for v in model["variants"]}) != len(model["variants"]):
        raise ValueError("Duplicate variant IDs")
    if "reasoning" in catalog:
        presets = reasoning_presets(catalog)
        model["variants"] = [v for v in model["variants"] if v["id"] not in REASONING_OPTIONS]
        model["variants"] += [{"id": p["id"], "body": deepcopy(p.get("body", {}))} for p in presets if p["enabled"]]
        # Explicit variants own exposure; don't ask clients to synthesize extra ones.
        declared = caps.get("reasoning", {})
        supported = isinstance(declared, dict) and declared.get("supported") is True
        caps["reasoning"] = {"supported": supported or any(p["enabled"] and p["id"] != "default" for p in presets)}
    if isinstance(caps.get("reasoning"), dict) and caps["reasoning"].get("supported"):
        model.setdefault("compatibility", {}).setdefault("reasoningField", "reasoning_content")
    model["cost"] = costs(model.get("cost"))
    context = profile["config"].get("ctx-size", profile["config"].get("max-model-len", 4096)) // profile["config"].get("parallel", 1)
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
    config = {"$schema": "https://opencode.ai/config.json", "providers": {"menagerie": {"name": "Menagerie", "package": "@opencode/ai/providers/openai-compatible", "settings": {"baseURL": gateway_url}, "models": models}}}
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
