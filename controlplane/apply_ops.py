"""Persistence and derivation for the desired-vs-applied split and the queued
apply operation (Stage 4 of the model-first UI plan).

The Stage 1 state machine (``queued_apply``) is a pure contract over the
``QueuedApplyOp`` dataclass. This module is the *store* half of that contract:

- It persists one queued-apply operation per unit (kind ``queued_apply``),
  keyed by unit id, and one applied snapshot per unit (kind ``applied``).
- Model setup stages a separate ``desired`` snapshot (see ``model_setup``),
  leaving the live registry and routing unchanged. The older unloaded-edit
  API derives pending status from the current registry and applied snapshot.
- "Applied" is recorded whenever a unit is (re)activated: that is the moment the
  running process picks up the current configuration. A brand-new unit is never
  pending, because its first activation sets applied == desired.

Invariants (mirrored by ``queued_apply`` and the tests):

- Saving moves ``desired`` only. The runtime keeps the old configuration until
  an explicit, reviewed apply restarts it.
- A *new* save is always a fresh operation (``create_op``); it never rewinds
  an existing one. Saving while an apply is queued/applying is rejected as a
  concurrent conflict, not silently overwritten.
- A failed or cancelled apply retains the saved change (still pending).
- Daemon restarts reconcile in-flight operations to FAILED (never Applied).
- "Discard" restores the applied snapshot and clears the operation.
"""

from __future__ import annotations

import hashlib
import json
import time

from . import queued_apply as qa
from .manager import Conflict

# ``ApplyState`` is a plain class of *string* constants and the pure contract
# compares its members by identity (``op.state is not ApplyState.PENDING``).
# The store round-trips those values through JSON as fresh ``str`` objects, so
# a stored state is not ``is``-equal to the class constant. This maps each
# value back to the exact class-constant object (``PENDING is ROLLODBACK_PENDING``
# is ``True``, so the shared "pending" literal is unambiguous).
_STATE_BY_VALUE = {}
for _name in (
    "PENDING",
    "QUEUED",
    "APPLYING",
    "APPLIED",
    "FAILED",
    "CANCELLED",
    "EXPIRED",
    "INVALID",
    "ROLLODBACK_PENDING",
    "ROLLODBACK_UNKNOWN",
    "ROLLODBACK_SUCCEEDED",
):
    _STATE_BY_VALUE[getattr(qa.ApplyState, _name)] = getattr(qa.ApplyState, _name)


def scope_fingerprint(unit: dict) -> str:
    """Deterministic fingerprint of a unit's apply scope: which models belong
    to it and what kind of shared runtime it is. Recompute it at apply time
    and compare against the ``op.scope_fingerprint`` captured at review to
    detect scope changes (membership edits, pool-type flips) that invalidate a
    stale consent. Pure over the unit dict — no store access, so it is easy to
    test and to keep the review and the revalidation in agreement."""
    payload = {
        "unit_id": unit.get("id"),
        "member_ids": sorted(unit.get("member_ids", [])),
        "engine_pool": bool(unit.get("engine_pool")),
        "residency": unit.get("residency"),
        "priority": unit.get("priority"),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def op_public(op: qa.QueuedApplyOp) -> dict:
    """A JSON-serialisable view of an operation for the API. The op's raw
    fields are already serialise-ready (strs, floats, bools, None), so this is
    a plain field projection."""
    return {
        "state": op.state,
        "token": op.token,
        "scope_fingerprint": op.scope_fingerprint,
        "drain_deadline": op.drain_deadline,
        "created_at": op.created_at,
        "ended_at": op.ended_at,
        "error": op.error,
        "rolled_back": op.rolled_back,
        "needs_revalidation": op.needs_revalidation,
    }


def _state(value: str, default) -> qa.ApplyState:
    """Resolve a stored state string to the exact ``ApplyState`` class-constant
    object so identity comparisons in the pure contract keep working."""
    return _STATE_BY_VALUE.get(value, default)


# Fields the running configuration does *not* depend on. They are volatile
# (telemetry, process identity, lifecycle state) and must never make a saved
# change look like a different desired revision.
# Fields that are *not* model configuration. They are process/telemetry or
# store-metadata state and must never make a save look like a configuration
# change (the last item, ``revision``, is the row's store version, bumped on
# every ``put`` and therefore unrelated to the model config).
_VOLATILE = (
    "state",
    "pid",
    "reservation_active",
    "resume_on_boot",
    "draining",
    "runtime_observation",
    "lifecycle",
    "inflight",
    "historical_requests",
    "revision",
    "state_since",
    "failure_reason",
    "operation_id",
    "session_id",
    "log_path",
    "pid_started",
    "pending_unit",
)


def _strip(row: dict) -> dict:
    return {k: v for k, v in row.items() if k not in _VOLATILE}


def _unit_rows(store, unit: dict) -> list[dict]:
    """The stored rows that define a unit's configuration, read fresh from
    the store (so a stale unit dict can never produce a stale digest)."""
    rows: list[dict] = []
    if unit.get("multi_model"):
        rows.append(store.get("deployment_set", unit["id"]))
        for member_id in unit.get("member_ids", []):
            rows.append(store.get("deployment", member_id))
    else:
        rows.append(store.get("deployment", unit["id"]))
    return rows


def unit_fingerprint(store, unit: dict) -> str:
    """Deterministic hash of the unit's stored configuration.

    Volatile fields (state, pid, telemetry) are stripped so runtime activity
    never changes the desired revision. For a pool the configuration is the
    shared set row plus every member's policy and profile snapshot; for a
    standalone unit it is that single member row. The same configuration always
    yields the same digest, and any saved change changes it."""
    rows = _unit_rows(store, unit)
    rows.sort(key=lambda r: r.get("id", ""))
    blobs = [{"id": r.get("id"), "data": _strip(r)} for r in rows]
    blob = json.dumps(blobs, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def _op_id(unit_id: str) -> str:
    """One queued-apply operation per unit, keyed by unit id."""
    return unit_id


def _op_from_row(row: dict) -> qa.QueuedApplyOp:
    return qa.QueuedApplyOp(
        deployment_id=row.get("deployment_id", row.get("id")),
        desired_rev=row.get("desired_rev"),
        applied_rev=row.get("applied_rev"),
        state=_state(row.get("state"), qa.ApplyState.PENDING),
        token=row.get("token"),
        scope_fingerprint=row.get("scope_fingerprint"),
        drain_deadline=row.get("drain_deadline"),
        created_at=row.get("created_at", 0.0),
        ended_at=row.get("ended_at"),
        error=row.get("error"),
        rolled_back=_state(row.get("rolled_back"), qa.ApplyState.ROLLODBACK_PENDING),
        needs_revalidation=row.get("needs_revalidation", False),
    )


def find_op(store, unit_id: str):
    """Return the stored queued-apply op for a unit, or None.

    A persisted row is read back and validated through the contract's round-trip
    check so a corrupt record raises rather than being trusted."""
    try:
        row = store.get("queued_apply", unit_id)
    except KeyError:
        return None
    op = _op_from_row(row)
    qa.validate_op(op)
    return op


def save_op(store, op: qa.QueuedApplyOp, c=None) -> qa.QueuedApplyOp:
    """Persist an operation, bumping the row revision. Returns the op that
    was written, so callers can inspect its state and revision fields."""
    store.put(
        "queued_apply",
        {
            "id": op.deployment_id,
            "deployment_id": op.deployment_id,
            "desired_rev": op.desired_rev,
            "applied_rev": op.applied_rev,
            "state": op.state,
            "token": op.token,
            "scope_fingerprint": op.scope_fingerprint,
            "drain_deadline": op.drain_deadline,
            "created_at": op.created_at,
            "ended_at": op.ended_at,
            "error": op.error,
            "rolled_back": op.rolled_back,
            "needs_revalidation": op.needs_revalidation,
        },
        c=c,
    )
    return op


def load_applied(store, unit_id: str):
    """Return the stored applied snapshot for a unit, or None."""
    try:
        return store.get("applied", unit_id)
    except KeyError:
        return None


def snapshot_unit(store, unit: dict) -> dict:
    """Capture the current stored configuration of a unit as an applied snapshot.

    This is the configuration the runtime is *executing* at activation, and the
    exact thing "discard pending changes" restores to. It is self-contained
    (no store-history dependency)."""
    rows = _unit_rows(store, unit)
    return {
        "id": unit["id"],
        "unit_id": unit["id"],
        "fingerprint": unit_fingerprint(store, unit),
        "rows": [{"id": r.get("id"), "data": _strip(r)} for r in rows],
    }


def current_applied_rev(store, unit_id: str) -> str | None:
    snap = load_applied(store, unit_id)
    return snap.get("fingerprint") if snap else None


def record_applied(store, unit: dict, c=None) -> dict:
    """Record the current configuration as the *applied* configuration.

    Called at activation (first load or apply-restart). It snapshots the current
    config and resolves any pending operation, because from this moment on the
    running process matches the current config (desired == applied)."""
    now = time.time()
    snapshot = snapshot_unit(store, unit)
    store.put("applied", snapshot, c=c)
    unit_id = _op_id(unit["id"])
    prior = find_op(store, unit_id)
    created_at = prior.created_at if prior else now
    resolved = qa.QueuedApplyOp(
        deployment_id=unit_id,
        desired_rev=snapshot["fingerprint"],
        applied_rev=snapshot["fingerprint"],
        state=qa.ApplyState.APPLIED,
        created_at=created_at,
        ended_at=now,
        rolled_back=qa.ApplyState.ROLLODBACK_SUCCEEDED,
    )
    return save_op(store, resolved, c=c)


def save_desired(store, unit: dict) -> qa.QueuedApplyOp:
    """Move the unit's *desired* configuration to the current stored value.

    This is the "save" half of the desired/applied split. It never restarts
    anything. A saved change is always a *fresh* operation (``create_op``),
    never a rewind or extension of an existing one. Saving while an apply is
    queued/applying raises ``Conflict`` — the concurrent-conflict case the
    UI must reconcile, not silently overwrite.
    """
    unit_id = _op_id(unit["id"])
    op = find_op(store, unit_id)
    if op is not None and op.state in (qa.ApplyState.QUEUED, qa.ApplyState.APPLYING):
        raise Conflict(
            "A change is already being applied to this deployment. "
            "Resolve it before saving another change."
        )
    desired_rev = unit_fingerprint(store, unit)
    applied_rev = current_applied_rev(store, unit_id) or (op.applied_rev if op else "")
    new_op = qa.create_op(unit_id, desired_rev, applied_rev, time.time())
    return save_op(store, new_op)


def request_apply(
    store, unit: dict, token: str, scope_fingerprint: str
) -> qa.QueuedApplyOp:
    """Queue a reviewed apply for a unit ('Apply when idle').

    Requires a fresh token and the scope fingerprint the UI reviewed. The pure
    contract (``request_apply``) enforces that only a settled operation can be
    queued; duplicates and in-flight submissions raise."""
    unit_id = _op_id(unit["id"])
    op = find_op(store, unit_id)
    if op is None:
        op = save_desired(store, unit)
    new_op = qa.request_apply(op, time.time(), token, scope_fingerprint)
    return save_op(store, new_op)


def cancel(store, unit_id: str) -> qa.QueuedApplyOp:
    """Cancel the queued apply. The saved change remains pending."""
    op = find_op(store, unit_id)
    if op is None:
        raise ValueError("No queued-apply operation to cancel")
    new_op = qa.cancel(op)
    return save_op(store, new_op)


def complete_apply(store, unit: dict, error: str | None = None) -> dict:
    """Finalise a queued apply that has already restarted the unit.

    On success the applied snapshot becomes the current config and the op is
    APPLIED. On failure the saved (desired) change is retained and the op is
    FAILED, reporting rollback status."""
    unit_id = _op_id(unit["id"])
    if error is None:
        return record_applied(store, unit)
    op = find_op(store, unit_id)
    if op is None:
        raise ValueError("No queued-apply operation to complete")
    new_op = qa.QueuedApplyOp(
        deployment_id=op.deployment_id,
        desired_rev=op.desired_rev,
        applied_rev=op.applied_rev,
        state=qa.ApplyState.FAILED,
        token=op.token,
        scope_fingerprint=op.scope_fingerprint,
        drain_deadline=op.drain_deadline,
        created_at=op.created_at,
        ended_at=time.time(),
        error=error or "Could not apply changes. Your saved changes are still pending.",
        rolled_back=qa.ApplyState.ROLLODBACK_PENDING,
        needs_revalidation=True,
    )
    return save_op(store, new_op)


def expire(store, unit_id: str) -> qa.QueuedApplyOp:
    """Mark an in-flight queued apply as *expired*: the bounded hold for the
    unit to go idle was exceeded and the change is retained as pending for a
    fresh review. Distinct from FAILED, which reports a hard error."""
    op = find_op(store, unit_id)
    if op is None:
        raise ValueError("No queued-apply operation to expire")
    new_op = qa.QueuedApplyOp(
        deployment_id=op.deployment_id,
        desired_rev=op.desired_rev,
        applied_rev=op.applied_rev,
        state=qa.ApplyState.EXPIRED,
        token=op.token,
        scope_fingerprint=op.scope_fingerprint,
        drain_deadline=op.drain_deadline,
        created_at=op.created_at,
        ended_at=time.time(),
        error=(
            "Changes are still pending. Applying them timed out while waiting "
            "for active requests."
        ),
        rolled_back=qa.ApplyState.ROLLODBACK_PENDING,
        needs_revalidation=True,
    )
    return save_op(store, new_op)


def pending(store, unit: dict) -> dict:
    """Read-only desired-vs-applied status for a unit.

    A unit is pending only when it has been activated at least once (an
    applied snapshot exists) *and* the saved (desired) configuration differs
    from what the runtime last loaded. A never-activated unit is never pending:
    there is nothing to apply against."""
    unit_id = _op_id(unit["id"])
    op = find_op(store, unit_id)
    desired_rev = unit_fingerprint(store, unit)
    applied_rev = current_applied_rev(store, unit_id)
    is_pending = bool(op) and qa.is_pending(op)
    return {
        "op": op,
        "desired_rev": desired_rev,
        "applied_rev": applied_rev,
        "pending": is_pending
        and applied_rev is not None
        and desired_rev != applied_rev,
    }


def discard(store, unit: dict) -> str | None:
    """Restore the unit's stored configuration to the last *applied* snapshot
    ('discard pending changes') and clear the operation. Returns the restored
    applied fingerprint, or None if the unit was never activated (nothing to
    restore, and nothing was pending)."""
    unit_id = _op_id(unit["id"])
    snapshot = load_applied(store, unit_id)
    if snapshot is None or not snapshot.get("rows"):
        delete_op(store, unit_id)
        return None
    rows = snapshot["rows"]
    if unit.get("multi_model"):
        set_row = next((r for r in rows if r["id"] == unit["id"]), None)
        if set_row is not None:
            stored = store.get("deployment_set", unit["id"])
            store.put(
                "deployment_set",
                set_row["data"] | {k: v for k, v in stored.items() if k in _VOLATILE},
            )
    for r in rows:
        rid = r.get("id")
        if not rid:
            continue
        if rid == unit["id"] and unit.get("multi_model"):
            continue  # the set row was handled above
        existing = store.get("deployment", rid)
        store.put(
            "deployment",
            r["data"] | {k: v for k, v in existing.items() if k in _VOLATILE},
        )
    delete_op(store, unit_id)
    return snapshot.get("fingerprint")


def delete_op(store, unit_id: str):
    store.delete("queued_apply", unit_id)


def applied_alias(store, unit: dict, deployment_id: str) -> str | None:
    """Return the alias a deployment *was serving* in the applied snapshot, or
    ``None`` if the unit was never activated. This is the ID clients learned via
    discovery before the next application."""
    snapshot = load_applied(store, _op_id(unit["id"]))
    if snapshot is None or not snapshot.get("rows"):
        return None
    for r in snapshot["rows"]:
        if r.get("id") == deployment_id:
            return r["data"].get("alias")
    return None


def effective_alias(store, unit: dict, deployment_id: str) -> str | None:
    """The alias that is actually *served* for a deployment.

    Pending model-setup edits live separately, so the live row remains the
    authoritative routing identity until reviewed application."""
    live = store.get("deployment", deployment_id)
    live_alias = live.get("alias")
    return live_alias


def reconcile_all(store):
    """Daemon-restart recovery: every in-flight operation becomes FAILED and is
    flagged for revalidation; settled operations are untouched. Mirrors
    ``queued_apply.reconcile_op``. Returns the reconciled operations."""
    reconciled = []
    for row in store.list("queued_apply"):
        try:
            op = _op_from_row(row)
        except (ValueError, TypeError):
            continue  # corrupt row; validate_op would raise on read
        if op.state in (qa.ApplyState.QUEUED, qa.ApplyState.APPLYING):
            new_op = qa.reconcile_op(op, now=time.time())
            reconciled.append(save_op(store, new_op))
    return reconciled
