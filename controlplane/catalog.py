import json
import math
import os
import tempfile
from copy import deepcopy


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
    model["cost"] = costs(model.get("cost"))
    context = profile["config"].get("ctx-size", profile["config"].get("max-model-len", 4096)) // profile["config"].get("parallel", 1)
    limits = model.setdefault("limit", {})
    limits["context"] = context
    limits["output"] = min(limits.get("output", 1024), context)
    if type(limits["output"]) is not int or limits["output"] <= 0:
        raise ValueError("Output limit must be positive")
    return catalog


def export_config(root, rows):
    models = {}
    for row in rows:
        catalog = row["shelf"]
        model = deepcopy(catalog["model"])
        model["modelID"] = row["id"]
        model["disabled"] = not model.pop("enabled", True)
        models[catalog["catalog_id"]] = model
    config = {"$schema": "https://opencode.ai/config.json", "providers": {"llama.cpp": {"name": "Menagerie", "package": "@opencode/ai/providers/openai-compatible", "settings": {"baseURL": "http://127.0.0.1:8001/v1"}, "models": models}}}
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
