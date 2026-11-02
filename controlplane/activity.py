"""Structured context for operation history and measured host protection."""

from contextvars import ContextVar

operation_id = ContextVar("operation_id", default=None)


def pressure_conditions(host, settings):
    conditions = []
    for gpu in host.get("gpus", []):
        for metric, key, threshold, direction, unit in (
            ("free_memory", "free_mib", "gpu_headroom_mib", "below", "MiB"),
            ("temperature", "temperature", "temperature_limit", "above", "°C"),
        ):
            value, limit = gpu.get(key), settings[threshold]
            if value is not None and (
                value < limit if direction == "below" else value > limit
            ):
                conditions.append(
                    dict(
                        resource=f"GPU {gpu['index']}",
                        metric=metric,
                        value=value,
                        threshold=limit,
                        direction=direction,
                        unit=unit,
                    )
                )
    value, limit = host.get("ram_available_mib"), settings["ram_headroom_mib"]
    if value is not None and value < limit:
        conditions.append(
            dict(
                resource="System RAM",
                metric="available_memory",
                value=value,
                threshold=limit,
                direction="below",
                unit="MiB",
            )
        )
    return conditions


def condition_text(condition):
    c = condition
    return (
        f"{c['resource']} {c['metric'].replace('_', ' ')} {c['value']:g} {c['unit']} "
        f"{c['direction']} {c['threshold']:g} {c['unit']}"
    )
