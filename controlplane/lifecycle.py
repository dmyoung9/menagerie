"""Derived deployment lifecycle shared by the registry, dashboard and catalog.

The registry keeps three independent facts: whether a deployment is enabled
(part of the serving set), which process state it is in, and which groups
reference it. Clients should not have to reconstruct the combination, so this
module derives the same answers everywhere.
"""

ACTIVE = {"QUEUED", "STARTING", "LOADING", "READY", "DEGRADED", "STOPPING"}
LOADING = {"VALIDATING", "QUEUED", "STARTING", "LOADING"}


def visible(deployment, settings):
    """True when the alias is published by /v1/models."""
    return bool(deployment.get("enabled")) and (
        deployment.get("state") == "READY"
        or bool(settings.get("expose_on_demand", True)) and deployment.get("residency") == "on-demand"
    )


def runtime(deployment):
    """Collapse the process state machine into a client-facing runtime word."""
    if not deployment.get("enabled"):
        return "not-deployed"
    state = deployment.get("state")
    if state in LOADING:
        return "loading"
    if state == "READY":
        return "running"
    if state == "DEGRADED":
        return "degraded"
    if state == "STOPPING":
        return "stopping"
    if state in {"FAILED", "ERROR"}:
        return "failed"
    # Stopped while deployed: on-demand aliases load on first request, while
    # pinned and evictable ones need an explicit start or group activation.
    return "idle" if deployment.get("residency") == "on-demand" else "held"


def describe(deployment, groups, settings):
    state = deployment.get("state")
    failed = state in {"FAILED", "ERROR"}
    reason = deployment.get("failure_reason")
    return {
        "deployed": bool(deployment.get("enabled")),
        "serving": visible(deployment, settings),
        "runtime": runtime(deployment),
        "groups": [g["id"] for g in groups if deployment["id"] in g.get("deployment_ids", [])],
        "failure": reason if failed else None,
        "last_stop_reason": None if failed else reason,
    }
