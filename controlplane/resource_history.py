"""Retained per-run resource summaries; configuration restoration stays independent."""

import json
import time

from .resources import run_profile_hash
from .store import encode


def performance_samples(store, ident, hours):
    """Match retained samples to execution identity, never alias or mutable names."""
    from .resources import profile_hash

    deployment = store.get("deployment", ident)
    profile = deployment["profile_snapshot"]
    fingerprint = profile_hash(
        profile,
        store.get("artifact", profile["artifact_id"]),
        store.get("runtime", profile["runtime_id"]),
        deployment["gpu"],
    )
    now = time.time()
    cutoff = now - hours * 3600
    all_runs = store.list("session")
    next_start = {}
    seen = {}
    for run in sorted(all_runs, key=lambda s: s.get("started_at", 0), reverse=True):
        source = run.get("deployment_id") or run.get("deployment_snapshot", {}).get(
            "id"
        )
        next_start[run["id"]] = seen.get(source, now)
        seen[source] = run.get("started_at", now)
    runs = sorted(
        (
            s
            for s in all_runs
            if (s.get("ended_at") or now) >= cutoff
            and run_profile_hash(s) == fingerprint
        ),
        key=lambda s: s["started_at"],
        reverse=True,
    )[:1000]
    result = []
    # Bound database reads as well as the response. Downsample inside each matched
    # run, not across configurations (which can hide short runs completely).
    budget = max(1, 1000 // max(1, len(runs)))
    with store.connect() as c:
        for run in runs:
            source_id = run.get("deployment_id") or run["deployment_snapshot"]["id"]
            start = max(cutoff, run["started_at"])
            end = min(now, run.get("ended_at") or now, next_start[run["id"]] - 0.000001)
            bucket = max(2, (end - start) / budget)
            metric_path = "$.deployments." + json.dumps(source_id)
            rows = c.execute(
                "SELECT ts,data FROM samples WHERE ts IN ("
                "SELECT max(ts) FROM samples WHERE ts>=? AND ts<=? "
                "AND json_extract(data,?) IS NOT NULL "
                "AND (json_extract(data,?) IS NULL OR json_extract(data,?)=?) "
                "GROUP BY CAST((ts-?)/? AS INTEGER)) ORDER BY ts LIMIT ?",
                (
                    start,
                    end,
                    metric_path,
                    metric_path + ".session_id",
                    metric_path + ".session_id",
                    run["id"],
                    start,
                    bucket,
                    budget,
                ),
            ).fetchall()
            for row in rows:
                sample = json.loads(row["data"])
                observed = sample["deployments"][source_id]
                result.append(
                    {
                        "ts": row["ts"],
                        "deployments": {ident: observed | {"session_id": run["id"]}},
                        "runtime_metrics": {
                            ident: sample.get("runtime_metrics", {}).get(source_id, {})
                        },
                    }
                )
    return sorted(result, key=lambda s: s["ts"])


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
                "configuration": run.get("deployment_snapshot", {})
                .get("profile_snapshot", {})
                .get("config", {}),
                "runtime_name": run.get("runtime_identity", {}).get("name"),
                "gpu_index": run.get("deployment_snapshot", {}).get("gpu"),
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
