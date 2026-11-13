"""Model-first assignment and staged configuration. Call mutations under Manager.lock.

The live registry remains the runtime's configuration until reviewed application.
Desired snapshots are separate, so saving cannot change admission, routing or
process ownership underneath a running pool.
"""

import copy

from . import apply_ops, deployment_sets, pool_edit, runtime_pool
from .store import identity, uid


def desired(store, unit_id):
    try:
        return store.get("desired", unit_id)
    except KeyError:
        return None


class PreviewStore:
    """Read-only overlay for the ordinary launch validator; never changes disk."""

    def __init__(self, store, snapshot):
        self.base = store
        self.root = store.root
        self.rows = {(r["kind"], r["data"]["id"]): r["data"] for r in snapshot["rows"]}

    def get(self, kind, ident, c=None):
        return (
            copy.deepcopy(self.rows.get((kind, ident)))
            if (kind, ident) in self.rows
            else self.base.get(kind, ident, c)
        )

    def list(self, kind, c=None):
        rows = {r["id"]: r for r in self.base.list(kind, c)}
        rows.update({ident: r for (k, ident), r in self.rows.items() if k == kind})
        return copy.deepcopy(list(rows.values()))

    def __getattr__(self, name):
        if name in {"put", "delete", "transaction"}:
            raise AttributeError("Preview is read-only")
        return getattr(self.base, name)


def unit_id(store, ident):
    try:
        row = store.get("deployment", ident)
        if row.get("pending_unit"):
            return row["pending_unit"]
    except KeyError:
        pass
    unit = deployment_sets.unit_for(store, ident)
    if unit is None:
        raise KeyError(ident)
    return unit["id"]


def projection(store, row):
    snapshot = desired(store, unit_id(store, row["id"]))
    if snapshot:
        for entry in snapshot["rows"]:
            if entry["kind"] == "deployment" and entry["data"]["id"] == row["id"]:
                return (
                    row
                    | entry["data"]
                    | {
                        "revision": row["revision"],
                        "state": row["state"],
                        "changes_pending": True,
                        "active_alias": row["alias"],
                    }
                )
    return row


def choose_pool(store, member):
    if (
        member.get("runtime_assignment") != "automatic"
        or member.get("residency") != "on-demand"
    ):
        return None
    policy = {k: member[k] for k in deployment_sets.POLICY_KEYS if k != "enabled"}
    candidate = policy | {"members": [], "engine_pool": True}
    if pool_edit.eligible_for_pool(member, candidate, store):
        return None
    # Only pools created by this workflow participate. Legacy assignments and
    # explicit supervised groups are never silently converted or repurposed.
    for pool in sorted(store.list("deployment_set"), key=lambda r: r["id"]):
        if not pool.get("automatic_pool") or not pool.get("enabled"):
            continue
        if any(pool.get(k) != v for k, v in policy.items()):
            continue
        unit = deployment_sets.unit_for(store, pool["id"])
        if not pool_edit.eligible_for_pool(member, unit, store):
            return pool
    return {
        "id": uid(),
        "name": "Automatic runtime pool",
        "engine_pool": True,
        "automatic_pool": True,
        "max_loaded": 4,
        "member_ids": [],
        "enabled": True,
        **policy,
    }


def snapshot(store, unit):
    rows = []
    if unit.get("multi_model"):
        rows.append(
            {"kind": "deployment_set", "data": store.get("deployment_set", unit["id"])}
        )
    rows.extend(
        {"kind": "deployment", "data": store.get("deployment", i)}
        for i in unit["member_ids"]
    )
    return {"id": unit["id"], "rows": rows}


def fingerprint(snap):
    return identity(
        [{"kind": r["kind"], "data": apply_ops._strip(r["data"])} for r in snap["rows"]]
    )


def plan(manager, ident):
    key = unit_id(manager.store, ident)
    snap = desired(manager.store, key)
    if not snap:
        raise ValueError("No saved changes to apply")
    preview = copy.copy(manager)
    preview.store = PreviewStore(manager.store, snap)
    affected = preview.unit(key)
    result = (
        preview.plan([key])
        if affected["enabled"] and any(m["enabled"] for m in affected["members"])
        else {"errors": [], "warnings": [], "stops": []}
    )
    # Bind consent to exact desired configuration and unload consequences.
    result["plan_token"] = identity(
        {
            "desired": fingerprint(snap),
            "live": fingerprint(snapshot(manager.store, manager.unit(key))),
            "dependencies": [
                {
                    "runtime": manager.store.get(
                        "runtime", m["profile_snapshot"]["runtime_id"]
                    ),
                    "artifact": manager.store.get(
                        "artifact", m["profile_snapshot"]["artifact_id"]
                    ),
                }
                for m in affected["members"]
            ],
            "stops": [
                {
                    "id": i,
                    "configuration": apply_ops._strip(
                        manager.store.get("deployment", i)
                    ),
                }
                for i in result.get("stops", [])
            ],
        }
    )
    result["affected"] = [m["name"] for m in affected["members"]]
    result["stop_names"] = [
        manager.store.get("deployment", i)["name"] for i in result.get("stops", [])
    ]
    result["scope_fingerprint"] = apply_ops.scope_fingerprint(affected)
    return result


def validate_snapshot(store, snap):
    overlay = PreviewStore(store, snap)
    unit = deployment_sets.unit_for(overlay, snap["id"])
    errors = runtime_pool.validate(unit, overlay)
    if errors:
        raise ValueError("; ".join(errors))


def install(store, snap, c):
    for entry in snap["rows"]:
        kind, data = entry["kind"], entry["data"]
        current = store.get(kind, data["id"], c)
        # Keep process identity/lifecycle as it exists AFTER the drain/stop.
        row = apply_ops._strip(data) | {
            k: v for k, v in current.items() if k in apply_ops._VOLATILE
        }
        if data.get("pending_unit"):
            row["pending_unit"] = data["pending_unit"]
        else:
            row.pop("pending_unit", None)
        store.put(kind, row, c=c)
