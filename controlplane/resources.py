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
    layers = positive(meta.get(f"{arch}.block_count"), 32)
    heads = positive(meta.get(f"{arch}.attention.head_count_kv"), 8)
    headsize = positive(meta.get(f"{arch}.attention.key_length"), 128)
    cache = {"f16": 2, "q8_0": 1.0625, "q4_0": .5625}
    ctx = positive(config.get("ctx-size", config.get("max-model-len")), 8192)
    kv = ctx * layers * heads * headsize * (cache.get(str(config.get("cache-type-k")), 2) + cache.get(str(config.get("cache-type-v")), 2)) / 1048576
    weights = positive(artifact.get("size_bytes"), 0) / 1048576
    overhead = 768 + 512 * max(1, positive(config.get("parallel"), 1))
    idle, peak = weights + kv + 768, weights + kv + overhead
    measured = [v for v in measured if positive(v, 0)]
    if measured:
        peak = max(measured) * 1.15 + 256
    return {"idle_mib": round(idle), "peak_mib": round(peak),
            "components": None if measured else {"Weights": round(weights), "KV cache": round(kv), "Runtime overhead": round(overhead)},
            "confidence": "medium" if measured else "low",
            "provenance": "previous process measurements + 15% + 256 MiB; workload-dependent" if measured else "GGUF file + generic KV + runtime overhead; hybrid architectures/offload uncertain",
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
        gpus.append({"index": gpu["index"], "name": gpu["name"], "total_mib": total,
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
            if "parallel" in schema:
                limit = int(positive(schema["parallel"].get("max"), 64))
                rec["parallel_recommended_max"] = next((n for n in range(min(limit, 256), 0, -1) if estimate(artifact, config | {"parallel": n})["peak_mib"] <= available), None)
            if context_key:
                field = schema[context_key]
                minimum = int(positive(field.get("min"), 512))
                maximum = int(positive(field.get("max"), 1048576))
                model_context = positive(meta.get(f"{arch}.context_length"), None)
                parallel = positive(config.get("parallel"), 1) if context_key == "ctx-size" else 1
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
                        "reason": "Generic memory estimate with desktop reserve and all draft peers; not a guaranteed safe limit"}
            m["recommendation"] = rec
    return {"gpus": gpus, "members": [{k: v for k, v in m.items() if k not in {"artifact", "schema"}} for m in members],
            "sample_ts": host.get("ts"), "ram_available_mib": host.get("ram_available_mib"),
            "ram_reserve_mib": settings["ram_headroom_mib"],
            "note": "Preview only: no deployments are saved, stopped or loaded. RAM/offload and hybrid architectures remain uncertain. Launch review rechecks current capacity."}
