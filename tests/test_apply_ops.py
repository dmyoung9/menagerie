"""Stage-4 desired-vs-applied split and queued-apply contract tests (store layer).

All resources are synthetic; no process is started, stopped, or inferred. These
pin the invariants the model-first UI relies on:

- Saving moves ``desired`` only and never restarts anything.
- Saving while an apply is queued/applying is a concurrent conflict, not a
  silent overwrite.
- Activation (``record_applied``) resolves a pending delta.
- A failed or cancelled apply retains the saved change (still pending).
- "Discard" restores the applied snapshot and clears the operation.
- Daemon-restart reconciliation marks in-flight operations FAILED (never
  Applied).
- A unit that has never been activated is not pending.
"""

import pytest

import controlplane.queued_apply as qa
from controlplane import apply_ops, deployment_sets
from controlplane.apply_ops import (
    Conflict,
    current_applied_rev,
    discard,
    find_op,
    pending,
    save_desired,
    unit_fingerprint,
)
from controlplane.queued_apply import ApplyState
from controlplane.store import Store


def store_for(tmp_path):
    return Store(tmp_path / "state")


def put_standalone(store, ident: str, config: dict) -> dict:
    store.put(
        "profile",
        {
            "id": f"p{ident}",
            "name": ident,
            "artifact_id": "w",
            "runtime_id": "r",
            "config": config,
            "raw_args": [],
            "catalog": {},
        },
    )
    return store.put(
        "deployment",
        {
            "id": ident,
            "name": ident,
            "alias": ident,
            "port": 90000 + len(ident),
            "profile_id": f"p{ident}",
            "profile_snapshot": store.get("profile", f"p{ident}"),
            "state": "STOPPED",
            "residency": "on-demand",
            "priority": 50,
            "idle_timeout": 300,
            "enabled": True,
            "gpu": 0,
            "queue_timeout": 5,
        },
    )


def put_pool(store) -> dict:
    """A two-member runtime pool (multi-model unit)."""
    for ident in ("a", "b"):
        put_standalone(store, ident, {"ctx-size": 8192})
    store.put(
        "deployment_set",
        {
            "id": "pool",
            "name": "pool",
            "engine_pool": True,
            "max_loaded": 2,
            "member_ids": ["a", "b"],
            "residency": "on-demand",
            "priority": 50,
            "idle_timeout": 300,
            "enabled": True,
            "queue_timeout": 5,
            "allow_eviction": True,
        },
    )
    return deployment_sets.unit_for(store, "pool")


def unit(store, ident: str):
    return deployment_sets.unit_for(store, ident)


# ---------------------------------------------------------------------------
# fingerprints
# ---------------------------------------------------------------------------


def test_fingerprint_stable_for_volatile_fields(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    before = unit_fingerprint(s, d)
    # Volatile fields (state, telemetry) must not move the desired revision.
    volatile = d | {
        "state": "READY",
        "runtime_observation": {"memory": {"effective": {"devices": []}}},
    }
    assert unit_fingerprint(s, volatile) == before


def test_fingerprint_changes_when_config_changes(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    fp0 = unit_fingerprint(s, d)
    d2 = s.put(
        "deployment",
        {
            **d,
            "profile_snapshot": {
                **d["profile_snapshot"],
                "config": {"ctx-size": 16384},
            },
        },
    )
    assert unit_fingerprint(s, d2) != fp0


def test_fingerprint_includes_all_members_of_a_pool(tmp_path):
    s = store_for(tmp_path)
    pu = put_pool(s)
    fp0 = unit_fingerprint(s, pu)
    # Changing one member's policy changes the pool's configuration.
    ma = s.get("deployment", "a")
    s.put(
        "deployment",
        {
            **ma,
            "profile_snapshot": {
                **ma["profile_snapshot"],
                "config": {"ctx-size": 16384},
            },
        },
    )
    assert unit_fingerprint(s, pu) != fp0


def test_fingerprint_identical_for_identical_configs(tmp_path):
    s1, s2 = store_for(tmp_path / "a"), store_for(tmp_path / "b")
    u1 = put_pool(s1)
    put_pool(s2)
    assert unit_fingerprint(s1, u1) == unit_fingerprint(s2, u1)


# ---------------------------------------------------------------------------
# save_desired (the "save" half)
# ---------------------------------------------------------------------------


def test_fresh_unit_has_no_pending_operation(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    # A never-activated unit has no pending operation.
    assert pending(s, d)["pending"] is False
    assert find_op(s, d["id"]) is None


def test_save_desired_creates_pending_op(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    op = save_desired(s, d)
    # The operation itself is a pending delta (desired != applied).
    assert op.state == ApplyState.PENDING
    assert qa.is_pending(op)
    state = pending(s, d)
    # A never-activated unit has no applied configuration to differ from, so it
    # is *not* unit-pending even though the op records a saved change.
    assert state["pending"] is False
    assert state["desired_rev"] == unit_fingerprint(s, d)
    assert state["applied_rev"] is None
    # find_op re-reads the stored row into a fresh QueuedApplyOp; compare
    # by value, not identity.
    assert find_op(s, d["id"]) == op


def test_save_while_queued_raises_conflict(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    # Queue an apply on the op.
    op = save_desired(s, d)
    queued = qa.request_apply(op, 1.0, "tok", "fp")
    apply_ops.save_op(s, queued)
    # Now saving must be a conflict, not a silent overwrite.
    with pytest.raises(Conflict, match="being applied"):
        save_desired(s, d)
    # The queued op is intact.
    assert find_op(s, d["id"]).state == ApplyState.QUEUED


# ---------------------------------------------------------------------------
# record_applied (activation resolves)
# ---------------------------------------------------------------------------


def test_record_applied_resolves_pending(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    # Activate: applied == desired (8192). No pending delta yet.
    apply_ops.record_applied(s, d)
    assert pending(s, d)["pending"] is False
    # Save a change: desired (16384) now differs from applied (8192) -> pending.
    d2 = s.put(
        "deployment",
        {
            **d,
            "profile_snapshot": {
                **d["profile_snapshot"],
                "config": {"ctx-size": 16384},
            },
        },
    )
    save_desired(s, d2)
    assert pending(s, d2)["pending"] is True
    # Activation resolves the delta: applied becomes desired (16384).
    apply_ops.record_applied(s, d2)
    assert current_applied_rev(s, d2["id"]) == unit_fingerprint(s, d2)
    assert pending(s, d2)["pending"] is False
    # A brand-new unit (never activated) is also never pending after activation.
    d3 = put_standalone(s, "e", {"ctx-size": 4096})
    apply_ops.record_applied(s, d3)
    assert pending(s, d3)["pending"] is False


# ---------------------------------------------------------------------------
# request_apply / cancel
# ---------------------------------------------------------------------------


def test_request_apply_requires_token_and_scope(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    save_desired(s, d)
    with pytest.raises(Exception, match="token and scope fingerprint"):
        apply_ops.request_apply(s, d, "", "fp")
    queued = apply_ops.request_apply(s, d, "tok", "fp")
    assert queued.state == ApplyState.QUEUED
    assert queued.token == "tok"
    assert queued.scope_fingerprint == "fp"
    # Duplicate submission is rejected.
    with pytest.raises(Exception, match="not yet been queued"):
        apply_ops.request_apply(s, d, "tok2", "fp2")


def test_cancel_keeps_saved_change_pending(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    apply_ops.request_apply(s, d, "tok", "fp")
    apply_ops.cancel(s, d["id"])
    state = pending(s, d)
    op = state["op"]
    assert op.state == ApplyState.CANCELLED
    assert qa.is_pending(op)
    assert state["desired_rev"] != state["applied_rev"]  # saved change retained


# ---------------------------------------------------------------------------
# complete_apply (success / failure)
# ---------------------------------------------------------------------------


def test_complete_apply_success_marks_applied_and_snapshot(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    # Simulate: a change was saved (pending), then the user applied (restart).
    apply_ops.request_apply(s, d, "tok", "fp")
    # Change the config while "queued" is not allowed in a real flow; the
    # apply job restarts the unit which loads whatever is currently stored.
    d2 = s.put(
        "deployment",
        {
            **d,
            "profile_snapshot": {
                **d["profile_snapshot"],
                "config": {"ctx-size": 16384},
            },
        },
    )
    apply_ops.complete_apply(s, d2, error=None)
    assert pending(s, d2)["pending"] is False
    assert current_applied_rev(s, d2["id"]) == unit_fingerprint(s, d2)
    snap = apply_ops.load_applied(s, d2["id"])
    assert snap["fingerprint"] == unit_fingerprint(s, d2)


def test_complete_apply_failure_retains_desired(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    apply_ops.request_apply(s, d, "tok", "fp")
    apply_ops.complete_apply(s, d, error="runtime refused")
    op = pending(s, d)["op"]
    assert op.state == ApplyState.FAILED
    # The saved (desired) change is retained: still pending for a fresh review.
    assert qa.is_pending(op)
    assert op.rolled_back == ApplyState.ROLLODBACK_PENDING
    assert "runtime refused" in op.error


def test_complete_apply_failure_reports_default_message(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    apply_ops.request_apply(s, d, "tok", "fp")
    # An empty error falls back to the contract's default message.
    apply_ops.complete_apply(s, d, error="")
    op = pending(s, d)["op"]
    assert op.state == ApplyState.FAILED
    assert "Could not apply changes. Your saved changes are still pending." in op.error


# ---------------------------------------------------------------------------
# discard
# ---------------------------------------------------------------------------


def test_discard_restores_applied_config(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    apply_ops.record_applied(s, d)  # baseline: applied == 8192
    # Save a change (now desired=16384, applied=8192, pending).
    d2 = s.put(
        "deployment",
        {
            **d,
            "profile_snapshot": {
                **d["profile_snapshot"],
                "config": {"ctx-size": 16384},
            },
        },
    )
    op = save_desired(s, d2)
    assert qa.is_pending(op)
    # Discard restores the 8192 config and clears the op.
    restored = discard(s, d2)
    assert restored is not None
    # The stored config is back to the applied baseline (unit_fingerprint reads
    # fresh from the store, so it reflects the restored row).
    fresh = s.get("deployment", "d")
    assert fresh["profile_snapshot"]["config"] == {"ctx-size": 8192}
    assert restored == unit_fingerprint(s, fresh)
    assert pending(s, fresh)["pending"] is False
    assert find_op(s, d["id"]) is None


def test_discard_on_never_activated_unit_is_noop(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    assert discard(s, d) is None
    # Config untouched.
    assert s.get("deployment", "d")["profile_snapshot"]["config"] == {"ctx-size": 8192}


def test_discard_restores_pool_policy(tmp_path):
    s = store_for(tmp_path)
    pu = put_pool(s)
    apply_ops.record_applied(s, pu)
    # Change a shared pool policy (idle_timeout) -> pending.
    s.put("deployment_set", {**s.get("deployment_set", "pool"), "idle_timeout": 900})
    op = save_desired(s, pu)
    assert qa.is_pending(op)
    discard(s, pu)
    assert s.get("deployment_set", "pool")["idle_timeout"] == 300
    assert pending(s, deployment_sets.unit_for(s, "pool"))["pending"] is False


# ---------------------------------------------------------------------------
# daemon-restart reconciliation
# ---------------------------------------------------------------------------


def test_reconcile_all_marks_inflight_failed(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    apply_ops.request_apply(s, d, "tok", "fp")
    # Simulate the daemon dying while queued, then relaunching.
    apply_ops.reconcile_all(s)
    re = find_op(s, d["id"])
    assert re.state == ApplyState.FAILED
    assert re.needs_revalidation
    assert re.rolled_back == ApplyState.ROLLODBACK_UNKNOWN
    assert qa.is_pending(re)  # the saved change is retained
    # A settled PENDING op is left untouched by reconcile_all.
    d2 = put_standalone(s, "e", {"ctx-size": 4096})
    save_desired(s, d2)
    apply_ops.reconcile_all(s)
    assert find_op(s, "e") is not None
    assert find_op(s, "e").state == ApplyState.PENDING


# ---------------------------------------------------------------------------
# round-trip persistence
# ---------------------------------------------------------------------------


def test_op_round_trips_and_validates(tmp_path):
    s = store_for(tmp_path)
    d = put_standalone(s, "d", {"ctx-size": 8192})
    apply_ops.request_apply(s, d, "tok", "fp")
    # Read it back (find_op validates the persisted row and would raise on a
    # corrupt record).
    got = find_op(s, d["id"])
    assert got is not None
    assert got.token == "tok"
    assert got.scope_fingerprint == "fp"
    assert qa.validate_op(got) is None  # valid op: no exception raised
