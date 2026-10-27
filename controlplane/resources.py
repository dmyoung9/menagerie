"""Side-effect-free resource estimates shared by draft previews and admission."""
import math
from . import adapters


def positive(value, fallback):
    try:
        value = float(value)
        return value if math.isfinite(value) and value > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def estimate(artifact, config, reservation=0, measured=()):
    meta, arch = artifact.get("metadata", {}), artifact.get("architecture") or ""
    hf = meta.get("config", {}).get("text_config") or meta.get("config", {})
    layers = positive(meta.get(f"{arch}.block_count"), positive(hf.get("num_hidden_layers"), 32))
    heads = positive(meta.get(f"{arch}.attention.head_count_kv"), positive(hf.get("num_key_value_heads"), 8))
    headsize = positive(meta.get(f"{arch}.attention.key_length"), positive(hf.get("head_dim"), positive(hf.get("hidden_size"), 4096) / positive(hf.get("num_attention_heads"), 32)))
    cache = {"f16": 2, "q8_0": 1.0625, "q4_0": .5625}
    ctx = positive(config.get("ctx-size", config.get("max-model-len")), 8192)
    kv = ctx * layers * heads * headsize * (cache.get(str(config.get("cache-type-k")), 2) + cache.get(str(config.get("cache-type-v")), 2)) / 1048576
    weights = positive(artifact.get("size_bytes"), 0) / 1048576
    offload = config.get("gpu-layers", "all")
    fraction = min(1, max(0, int(offload)) / layers) if str(offload).isdigit() else 1
    ram = weights * (1 - fraction)
    weights *= fraction
    if fraction == 0:
        ram += kv + 1280
        kv = 0
    overhead = 768 + 512 * max(1, positive(config.get("parallel"), 1))
    if fraction == 0:
        overhead = 0
    idle, peak = weights + kv + (768 if fraction else 0), weights + kv + overhead
    measured = [v for v in measured if positive(v, 0)]
    if measured:
        peak = max(measured) * 1.15 + 256
    return {"idle_mib": round(idle), "peak_mib": round(peak), "ram_mib": round(ram),
            "components": None if measured else {"Weights": round(weights), "KV cache": round(kv), "Runtime overhead": round(overhead)},
            "confidence": "medium" if measured else "low",
            "provenance": "previous process measurements + 15% + 256 MiB; workload-dependent" if measured else "Weight size, model metadata, KV cache and runtime overhead estimate",
            "reservation_mib": reservation or round(peak), "physical_limit": False}


def preview(manager, drafts):
    host, settings = manager.host, manager.settings()
    members = []
    for index, draft in enumerate(drafts):
        profile = draft["configuration"]
        artifact = manager.store.get("artifact", profile["artifact_id"])
        runtime = manager.store.get("runtime", profile["runtime_id"])
        for key in ("ctx-size", "max-model-len", "parallel"):
            value = profile["config"].get(key)
            if value is not None and (type(value) is not int or not 1 <= value <= 10**9):
                raise ValueError(f"{key} must be a positive integer within the preview range")
        utilization = profile["config"].get("gpu-memory-utilization")
        if utilization is not None and (type(utilization) not in (int, float) or not .05 <= utilization <= .95):
            raise ValueError("gpu-memory-utilization must be a number between 0.05 and 0.95")
        d = draft | {"profile_snapshot": profile}
        members.append({"key": str(index), "name": draft["name"], "gpu": draft["gpu"],
                        "estimate": manager.estimate(d), "recommendation": {},
                        "artifact": artifact, "schema": adapters.option_schema(runtime)})
    gpus = []
    for gpu in host.get("gpus", []):
        total, used = gpu.get("total_mib"), gpu.get("used_mib")
        if total is None or used is None:
            continue
        selected = [m for m in members if m["gpu"] == gpu["index"]]
        # Editing an inactive deployment never removes another process from this baseline.
        needed = sum(m["estimate"]["peak_mib"] for m in selected)
        reserve = settings["gpu_headroom_mib"]
        remaining = total - used - reserve - needed
        explicit = sum(d["reservation_mib"] for d in drafts if d["gpu"] == gpu["index"])
        explicit += sum(d.get("reservation_mib", 0) for d in manager.store.list("deployment") if d.get("gpu") == gpu["index"] and d.get("state") in {"QUEUED", "STARTING", "LOADING", "READY", "DEGRADED", "STOPPING"})
        gpus.append({"index": gpu["index"], "name": gpu.get("name", "GPU"), "total_mib": total,
                     "used_mib": used, "reserve_mib": reserve, "draft_mib": needed,
                     "remaining_mib": remaining,
                     "reservation_error": explicit + reserve > total,
                     "verdict": "Over budget" if remaining < 0 else "Tight fit" if remaining < total * .1 else "Fits estimate"})
        for m in selected:
            schema, artifact = m["schema"], m["artifact"]
            config = drafts[int(m["key"])]["configuration"]["config"]
            context_key = next((k for k in ("ctx-size", "max-model-len") if k in schema), None)
            meta, arch = artifact.get("metadata", {}), artifact.get("architecture") or ""
            layers = positive(meta.get(f"{arch}.block_count"), None)
            rec = {"gpu_layers_max": int(layers) if layers else None}
            available = total - used - reserve - (needed - m["estimate"]["peak_mib"])
            if "allocation_mib" in m["estimate"]:
                rec["gpu_memory_utilization_max"] = max(0, min(.95, available / total))
                rec["gpu_memory_utilization_min"] = max(.05, m["estimate"]["required_mib"] / total)
                available = min(available, m["estimate"]["allocation_mib"])
            if "parallel" in schema:
                limit = int(positive(schema["parallel"].get("max"), 64))
                context = positive(config.get("ctx-size"), 8192)
                rec["parallel_recommended_max"] = next((n for n in range(min(limit, 256, int(context // 32)), 0, -1) if estimate(artifact, config | {"parallel": n})["peak_mib"] <= available), None)
            if context_key:
                field = schema[context_key]
                minimum = int(positive(field.get("min"), 512))
                maximum = int(positive(field.get("max"), 1048576))
                hf = meta.get("config", {}).get("text_config") or meta.get("config", {})
                model_context = positive(meta.get(f"{arch}.context_length"), positive(hf.get("max_position_embeddings"), None))
                parallel = positive(config.get("parallel"), 1) if context_key == "ctx-size" else 1
                minimum = max(minimum, int(parallel * 32))
                if model_context:
                    maximum = min(maximum, int(model_context * parallel))
                # All peers retain their current configuration; only this member varies.
                low, high, best = minimum, maximum, None
                while low <= high:
                    mid = (low + high) // 2
                    candidate = estimate(artifact, config | {context_key: mid})["peak_mib"]
                    if candidate <= available:
                        best, low = mid, mid + 1
                    else:
                        high = mid - 1
                rec |= {"context_key": context_key, "context_recommended_max": best,
                        "context_default": min(8192, best) if best is not None else None,
                         "reason": "Estimated capacity after desktop reserve and other selected models"}
            m["recommendation"] = rec
    return {"gpus": gpus, "members": [{k: v for k, v in m.items() if k not in {"artifact", "schema"}} for m in members],
            "sample_ts": host.get("ts"), "ram_available_mib": host.get("ram_available_mib"),
            "ram_reserve_mib": settings["ram_headroom_mib"],
            "note": "Limits use model metadata and estimated memory. Changing system load can still cause a launch to fail."}


def validate_budget(manager, drafts):
    """Apply the same peer-preserving budget used by the configuration controls."""
    resolved = []
    for draft in drafts:
        profile = draft.get("configuration") or manager.store.get("profile", draft["profile_id"])
        resolved.append(draft | {"configuration": profile})
    result = preview(manager, resolved)
    errors = []
    for gpu in result["gpus"]:
        if gpu["remaining_mib"] < 0 or gpu["reservation_error"]:
            errors.append(f"GPU {gpu['index']} configuration exceeds the available memory budget; reduce context/concurrency, select smaller weights, or choose CPU/RAM offload")
    ram = sum(m["estimate"]["ram_mib"] for m in result["members"])
    if any(m["estimate"].get("required_mib", 0) > m["estimate"].get("allocation_mib", float("inf")) for m in result["members"]):
        errors.append("vLLM's GPU memory allocation is below the estimated model and context requirement; increase its allocation or reduce context")
    if ram and ram > (result["ram_available_mib"] or 0) - result["ram_reserve_mib"]:
        errors.append("CPU/RAM offload exceeds available system memory after the desktop reserve")
    if errors:
        raise ValueError("; ".join(errors))
