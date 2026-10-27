"""Serving deployments with one or more individually supervised model members.

A standalone model is a one-member unit. An owning set supplies shared residency
policy for multiple members without changing their aliases or profile snapshots.
"""
from . import lifecycle

POLICY_KEYS = ("residency", "priority", "idle_timeout", "allow_eviction", "enabled", "queue_timeout")


def units(store):
    members = {d["id"]: d for d in store.list("deployment")}
    sets = store.list("deployment_set")
    owned = {i for s in sets for i in s["member_ids"]}
    return [s | {"members": [members[i] for i in s["member_ids"]], "multi_model": True} for s in sets] + [d | {"member_ids": [d["id"]], "members": [d], "multi_model": False} for d in members.values() if d["id"] not in owned]


def unit_for(store, ident):
    return next((u for u in units(store) if u["id"] == ident or ident in u["member_ids"]), None)


def expand(store, ids):
    result = []
    for ident in ids:
        unit = unit_for(store, ident)
        if unit is None:
            raise KeyError(f"Unknown deployment: {ident}")
        result.extend(i for i in unit["member_ids"] if i not in result)
    return result


def state(unit):
    states = [d["state"] for d in unit["members"]]
    if all(s == "READY" for s in states):
        return "READY"
    if "STOPPING" in states:
        return "STOPPING"
    for loading in ("LOADING", "STARTING", "QUEUED", "VALIDATING"):
        if loading in states:
            return loading
    if any(s in {"READY", "DEGRADED"} for s in states):
        return "DEGRADED"
    if any(s in {"FAILED", "ERROR"} for s in states):
        return "FAILED"
    return "STOPPED"


def describe(unit, settings, inflight=None):
    value = state(unit)
    members = [d | {"inflight": (inflight or {}).get(d["id"], 0), "lifecycle": lifecycle.describe(d, settings) | {"serving": lifecycle.visible(d | {"state": value}, settings)}} for d in unit["members"]]
    errors = [f"{d['name']}: {d['failure_reason']}" for d in members if d.get("failure_reason") and d["state"] in {"FAILED", "ERROR", "DEGRADED"}]
    effective = unit | {"state": value, "failure_reason": "; ".join(errors) or None}
    derived = lifecycle.describe(effective, settings)
    if errors:
        derived.update(failure="; ".join(errors), last_stop_reason=None)
    return effective | {"members": members, "inflight": sum((inflight or {}).get(d["id"], 0) for d in members), "lifecycle": derived}
