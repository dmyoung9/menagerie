"""Resource facts and advisory accounting. Estimates never reserve or gate memory."""

import math

from .store import identity


def positive(value, fallback=None):
    if isinstance(value, bool):
        return fallback
    try:
        value = float(value)
        return value if math.isfinite(value) and value > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def profile_hash(profile, artifact, runtime, gpu):
    """Fingerprint execution inputs, not names, revisions or catalog labels."""
    return identity(
        {
            "artifact": [
                artifact["id"],
                artifact.get("sha256"),
                artifact.get("size_bytes"),
            ],
            "runtime": [
                runtime["id"],
                runtime.get("capabilities", {}).get("sha256"),
                runtime.get("version"),
                runtime.get("execution_kind"),
                runtime.get("executable"),
                runtime.get("command_template"),
                runtime.get("env"),
            ],
            "config": profile["config"],
            "raw_args": profile.get("raw_args", []),
            "gpu": gpu,
        }
    )


def run_profile_hash(run):
    """Read legacy summaries using their preserved execution identities, without rewriting snapshots."""
    deployment = run.get("deployment_snapshot", {})
    profile = deployment.get("profile_snapshot")
    artifact, runtime = run.get("artifact_identity"), run.get("runtime_identity")
    if profile and artifact and runtime:
        return profile_hash(profile, artifact, runtime, deployment.get("gpu", 0))
    return run.get("profile_hash")


def estimate(artifact, config, measured=()):
    meta, arch = artifact.get("metadata", {}), artifact.get("architecture") or ""
    hf = meta.get("config") or {}
    hf = hf.get("text_config") or hf
    layers = positive(
        meta.get(f"{arch}.block_count"), positive(hf.get("num_hidden_layers"))
    )
    heads = positive(
        meta.get(f"{arch}.attention.head_count_kv"),
        positive(hf.get("num_key_value_heads")),
    )
    hidden, attention_heads = (
        positive(hf.get("hidden_size")),
        positive(hf.get("num_attention_heads")),
    )
    headsize = positive(
        meta.get(f"{arch}.attention.key_length"),
        positive(
            hf.get("head_dim"),
            hidden / attention_heads if hidden and attention_heads else None,
        ),
    )
    value_size = positive(meta.get(f"{arch}.attention.value_length"), headsize)
    ctx = positive(config.get("ctx-size", config.get("max-model-len")))
    cache = {"f16": 2, "q8_0": 1.0625, "q4_0": 0.5625}
    k, v = (
        cache.get(str(config.get("cache-type-k", "f16"))),
        cache.get(str(config.get("cache-type-v", "f16"))),
    )
    kv = (
        ctx * layers * heads * (headsize * k + value_size * v) / 1048576
        if all((ctx, layers, heads, headsize, value_size, k, v))
        else None
    )
    size = artifact.get("size_bytes")
    weights = size / 1048576 if isinstance(size, (int, float)) and size >= 0 else None
    offload = config.get("gpu-layers", "all")
    fraction = (
        min(1, max(0, int(offload)) / layers)
        if str(offload).isdigit() and layers
        else 0
        if str(offload) == "0"
        else 1
        if offload in ("all", -1)
        else None
    )
    gpu = (
        weights * fraction + (kv or 0) * (fraction > 0)
        if weights is not None and fraction is not None
        else None
    )
    ram = (
        weights * (1 - fraction) + (kv or 0) * (fraction == 0)
        if weights is not None and fraction is not None
        else None
    )
    observations = [
        s
        for s in measured
        if s.get("resource_history_retained", True)
        and (s.get("peak_gpu_mib") is not None or s.get("peak_ram_mib") is not None)
    ]
    gpu_peaks = [
        s["peak_gpu_mib"] for s in observations if s.get("peak_gpu_mib") is not None
    ]
    ram_peaks = [
        s["peak_ram_mib"] for s in observations if s.get("peak_ram_mib") is not None
    ]
    observed = bool(gpu_peaks or ram_peaks)
    return {
        "peak_mib": max(gpu_peaks)
        if observed and gpu_peaks
        else None
        if observed
        else gpu,
        "ram_mib": max(ram_peaks)
        if observed and ram_peaks
        else None
        if observed
        else ram,
        "file_size_bytes": size,
        "kv_mib": kv,
        "components": None
        if observed or fraction is None or weights is None
        else {
            "Weights": weights * fraction,
            **({"KV cache": kv} if kv is not None and fraction else {}),
        },
        "basis": "observed"
        if observed
        else "derived"
        if gpu is not None
        else "unavailable",
        "sample_count": len(observations) if observed else 0,
        "provenance": "Past per-process peaks for this configuration; not a guarantee"
        if observed
        else "File size + metadata-derived KV cache"
        if kv is not None
        else "File size only; KV cache unavailable from supplied metadata/configuration",
    }


def preview(manager, drafts):
    host, settings = manager.host, manager.settings()
    members = []
    for index, draft in enumerate(drafts):
        profile = draft["configuration"]
        for key in ("ctx-size", "max-model-len", "parallel"):
            value = profile["config"].get(key)
            if value is not None and (
                type(value) is not int or not 1 <= value <= 10**9
            ):
                raise ValueError(
                    f"{key} must be a positive integer within the preview range"
                )
        members.append(
            {
                "key": str(index),
                "name": draft["name"],
                "gpu": draft["gpu"],
                "estimate": manager.estimate(draft | {"profile_snapshot": profile}),
                "recommendation": {},
            }
        )
    gpus = []
    for gpu in host.get("gpus", []):
        total, used, free = (
            gpu.get("total_mib"),
            gpu.get("used_mib"),
            gpu.get("free_mib"),
        )
        selected = [m for m in members if m["gpu"] == gpu["index"]]
        known = all(m["estimate"]["peak_mib"] is not None for m in selected)
        needed = (
            sum(m["estimate"]["peak_mib"] or 0 for m in selected) if known else None
        )
        remaining = (
            free - settings["gpu_headroom_mib"] - needed
            if free is not None and needed is not None
            else None
        )
        gpus.append(
            {
                "index": gpu["index"],
                "name": gpu.get("name", "GPU"),
                "total_mib": total,
                "used_mib": used,
                "free_mib": free,
                "headroom_mib": settings["gpu_headroom_mib"],
                "draft_mib": needed,
                "remaining_mib": remaining,
                "status": "unavailable"
                if remaining is None
                else "over_budget"
                if remaining < 0
                else "within_budget",
            }
        )
    ram_known = all(m["estimate"]["ram_mib"] is not None for m in members)
    ram_demand = (
        sum(m["estimate"]["ram_mib"] or 0 for m in members) if ram_known else None
    )
    ram_free = host.get("ram_available_mib")
    return {
        "gpus": gpus,
        "members": members,
        "sample_ts": host.get("ts"),
        "sample_seconds": settings["sample_seconds"],
        "ram_available_mib": ram_free,
        "ram_headroom_mib": settings["ram_headroom_mib"],
        "ram_draft_mib": ram_demand,
        "ram_remaining_mib": ram_free - settings["ram_headroom_mib"] - ram_demand
        if ram_free is not None and ram_demand is not None
        else None,
        "note": "Advisory accounting only. No memory is reserved. Launch stops only at measured safety limits or a real runtime failure.",
    }


def validate_budget(manager, drafts):
    """Validate preview inputs, never reject a configuration on estimated capacity."""
    return preview(
        manager,
        [
            d
            | {
                "configuration": d.get("configuration")
                or manager.store.get("profile", d["profile_id"])
            }
            for d in drafts
        ],
    )
