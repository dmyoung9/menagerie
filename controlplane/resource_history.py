"""Retained per-run resource summaries; configuration restoration stays independent."""

import time

from .resources import run_profile_hash
from .store import encode


def retained(store, settings):
    cutoff = time.time() - settings["summary_days"] * 86400
    return [
        s
        for s in store.list("session")
        if s.get("profile_hash")
        and s.get("resource_history_retained", True)
        and s.get("started_at", 0) >= cutoff
    ]


def summaries(store, settings, artifact_id=None):
    groups = {}
    for run in retained(store, settings):
        artifact = run.get("artifact_identity", {})
        if artifact_id is not None and artifact.get("id") != artifact_id:
            continue
        fingerprint = run_profile_hash(run)
        key = (artifact.get("id"), fingerprint)
        group = groups.setdefault(
            key,
            {
                "artifact_id": artifact.get("id"),
                "model_name": artifact.get("name", "Unknown model"),
                "profile_hash": fingerprint,
                "runs": [],
            },
        )
        group["runs"].append(
            {
                k: run.get(k)
                for k in (
                    "id",
                    "started_at",
                    "ended_at",
                    "outcome",
                    "peak_gpu_mib",
                    "peak_ram_mib",
                )
            }
        )
    result = []
    for group in groups.values():
        runs = sorted(group["runs"], key=lambda r: r["started_at"], reverse=True)
        group.update(
            runs=runs,
            run_count=len(runs),
            first_run_at=runs[-1]["started_at"],
            last_run_at=runs[0]["started_at"],
        )
        for field in ("gpu", "ram"):
            values = [
                r[f"peak_{field}_mib"]
                for r in runs
                if r[f"peak_{field}_mib"] is not None
            ]
            group[field] = {
                "sample_count": len(values),
                "mean_peak_mib": sum(values) / len(values) if values else None,
                "max_peak_mib": max(values) if values else None,
            }
        result.append(group)
    return sorted(result, key=lambda g: g["last_run_at"], reverse=True)


def prune(store, settings, c):
    """Bound resource summaries, without deleting restorable session snapshots."""
    cutoff = time.time() - settings["summary_days"] * 86400
    size = 0
    quota = settings["history_quota_mib"] * 1048576
    for run in sorted(
        store.list("session", c), key=lambda s: s.get("started_at", 0), reverse=True
    ):
        if run.get("outcome") == "running" or not run.get(
            "resource_history_retained", True
        ):
            continue
        size += len(
            encode(
                {
                    k: run.get(k)
                    for k in (
                        "id",
                        "profile_hash",
                        "started_at",
                        "ended_at",
                        "peak_gpu_mib",
                        "peak_ram_mib",
                    )
                }
            )
        )
        if run.get("started_at", 0) < cutoff or size > quota:
            run.pop("peak_gpu_mib", None)
            run.pop("peak_ram_mib", None)
            store.put(
                "session",
                run | {"resource_history_retained": False},
                historical=False,
                c=c,
            )
