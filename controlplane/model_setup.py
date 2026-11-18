"""Model-first assignment and staged configuration. Call mutations under Manager.lock.

The live registry remains the runtime's configuration until reviewed application.
Desired snapshots are separate, so saving cannot change admission, routing or
process ownership underneath a running pool.
"""

import copy

from . import apply_ops, deployment_sets, runtime_pool
from .store import identity


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
    live_unit = manager.unit(key)
    from .manager import ACTIVE

    loaded = any(m["state"] in ACTIVE for m in live_unit["members"])
    result = (
        preview.plan([key])
        if loaded
        and affected["enabled"]
        and any(m["enabled"] for m in affected["members"])
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
    result["loaded"] = loaded
    result["inflight"] = sum(
        manager.inflight.get(i, 0) for i in live_unit["member_ids"]
    )
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
        store.put(kind, row, c=c)
