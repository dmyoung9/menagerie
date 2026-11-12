"""Contract tests for the desired-vs-applied split and the queued-apply
state machine (Stage 1 of the model-first UI plan).

These pin the invariants the Stage 4 API and the "Apply when idle" flow rely
on: saving does not apply; applying requires a reviewed token and scope
fingerprint and a bounded drain; cancellation is only pre-application;
revalidation and daemon-restart recovery never falsely report Applied; and
retrying a failed or interrupted apply is a fresh review (a new operation
with a fresh token), never a rewind.
"""

import pytest

from controlplane import queued_apply as qa
from controlplane.queued_apply import ApplyState, QueuedApplyOp


def base(now=0.0, desired="rev1", applied="rev0"):
    """A freshly saved change: PENDING with a desired-vs-applied delta."""
    return qa.create_op("d1", desired, applied, now)


def state_op(state, desired="rev1", applied="rev0", **kw):
    """Directly construct an operation in a given state, as the API would
    when reading a persisted row back."""
    return QueuedApplyOp("d1", desired, applied, state=state, **kw)


# ---------------------------------------------------------------------------
# Save does not apply
# ---------------------------------------------------------------------------


def test_save_moves_desired_and_leaves_applied():
    saved = qa.save_op(base(), "rev2", 5.0)
    assert saved.state == ApplyState.PENDING
    assert saved.desired_rev == "rev2"
    assert saved.applied_rev == "rev0"  # save does not apply
    assert saved.ended_at is None
    assert qa.is_pending(saved) is True
    again = qa.save_op(saved, "rev3", 6.0)
    assert again.desired_rev == "rev3"
    assert again.applied_rev == "rev0"  # applied still untouched


def test_save_rejected_while_a_previous_apply_is_in_flight():
    queued_op = qa.request_apply(base(), 1.0, "tok", "fp")
    with pytest.raises(ValueError, match="in-flight"):
        qa.save_op(queued_op, "rev9", 2.0)
    applying_op = qa.drain(queued_op, now=3.0, active_requests=0)
    with pytest.raises(ValueError, match="in-flight"):
        qa.save_op(applying_op, "rev9", 4.0)
    cancelled = state_op(ApplyState.CANCELLED)
    with pytest.raises(ValueError, match="in-flight"):
        qa.save_op(cancelled, "rev9", 5.0)


# ---------------------------------------------------------------------------
# request_apply: review required, duplicates rejected
# ---------------------------------------------------------------------------


def test_request_apply_requires_reviewed_token_and_scope():
    op = base()
    with pytest.raises(ValueError, match="token and scope fingerprint"):
        qa.request_apply(op, 1.0, token="", scope_fingerprint="fp")
    with pytest.raises(ValueError, match="token and scope fingerprint"):
        qa.request_apply(op, 1.0, token="tok", scope_fingerprint=None)


def test_request_apply_rejected_when_already_queued_or_inflight():
    op = qa.request_apply(base(), 1.0, "tok", "fp")
    with pytest.raises(ValueError, match="not yet been queued"):
        qa.request_apply(op, 2.0, "tok2", "fp2")  # duplicate submission
    op = qa.drain(op, now=3.0, active_requests=0)  # now APPLYING
    with pytest.raises(ValueError, match="not yet been queued"):
        qa.request_apply(op, 4.0, "tok3", "fp3")  # while applying
    for st in (
        ApplyState.CANCELLED,
        ApplyState.FAILED,
        ApplyState.EXPIRED,
        ApplyState.APPLIED,
    ):
        with pytest.raises(ValueError, match="not yet been queued"):
            qa.request_apply(state_op(st), 5.0, "tok", "fp")


# ---------------------------------------------------------------------------
# drain: bounded hold, idle -> applying, deadline -> expired
# ---------------------------------------------------------------------------


def test_drain_holds_with_active_requests_then_applies_when_idle():
    op = qa.request_apply(base(), 1.0, "tok", "fp")
    assert qa.drain(op, now=5.0, active_requests=3).state == ApplyState.QUEUED
    assert qa.drain(op, now=6.0, active_requests=1).state == ApplyState.QUEUED
    assert qa.drain(op, now=7.0, active_requests=0).state == ApplyState.APPLYING
    # drain is a no-op on non-queued states
    pending_op = base()
    assert qa.drain(pending_op, now=7.0, active_requests=0) is pending_op


def test_drain_expires_only_when_the_bounded_hold_expires():
    op = qa.request_apply(base(), 1.0, "tok", "fp")  # drain_deadline = 31.0
    assert qa.drain(op, now=30.0, active_requests=1).state == ApplyState.QUEUED
    expired = qa.drain(op, now=31.0, active_requests=1)
    assert expired.state == ApplyState.EXPIRED
    assert expired.desired_rev == "rev1"  # change retained
    assert expired.applied_rev == "rev0"
    assert qa.is_pending(expired) is True
    assert expired.error


# ---------------------------------------------------------------------------
# apply
# ---------------------------------------------------------------------------


def test_apply_success_applies_and_passes_validation():
    op = qa.request_apply(base(), 1.0, "tok", "fp")
    op = qa.drain(op, now=2.0, active_requests=0)
    op = qa.apply(op, restart_ok=True, now=3.0)
    assert op.state == ApplyState.APPLIED
    assert op.desired_rev == op.applied_rev == "rev1"
    assert op.rolled_back == ApplyState.ROLLODBACK_SUCCEEDED
    qa.validate_op(op)
    assert qa.is_pending(op) is False
    # applying twice is illegal, and so is applying out of state
    with pytest.raises(ValueError, match="only valid while the op is APPLYING"):
        qa.apply(op, restart_ok=True, now=4.0)
    with pytest.raises(ValueError, match="only valid while the op is APPLYING"):
        qa.apply(qa.request_apply(base(), 1.0, "tok", "fp"), restart_ok=True, now=5.0)


def test_apply_failure_retains_desired_and_reports_rollback():
    op = qa.request_apply(base(), 1.0, "tok", "fp")
    op = qa.drain(op, now=2.0, active_requests=0)
    op = qa.apply(op, restart_ok=False, now=3.0, error="runtime refused")
    assert op.state == ApplyState.FAILED
    assert op.desired_rev == "rev1"  # desired retained
    assert op.applied_rev == "rev0"  # applied untouched
    assert op.ended_at == 3.0
    assert op.rolled_back == ApplyState.ROLLODBACK_PENDING
    assert qa.is_pending(op) is True
    qa.validate_op(op)  # a valid FAILED record still carries the reviewed token
    # a default error text is reported when none is supplied
    op = qa.drain(
        qa.request_apply(base(), 1.0, "tok", "fp"), now=2.0, active_requests=0
    )
    failed = qa.apply(op, restart_ok=False, now=3.0)
    assert (
        failed.error == "Could not apply changes. Your saved changes are still pending."
    )


# ---------------------------------------------------------------------------
# cancellation
# ---------------------------------------------------------------------------


def test_cancel_allowed_before_application_but_not_after():
    cancelled = qa.cancel(base())
    assert cancelled.state == ApplyState.CANCELLED
    assert cancelled.desired_rev == "rev1"  # saved change retained
    assert qa.is_pending(cancelled) is True
    queued_op = qa.request_apply(base(), 1.0, "tok", "fp")
    assert qa.cancel(queued_op).state == ApplyState.CANCELLED
    applying_op = qa.drain(
        qa.request_apply(base(), 1.0, "tok", "fp"), now=2.0, active_requests=0
    )
    with pytest.raises(ValueError, match="only be cancelled"):
        qa.cancel(applying_op)
    for st in (
        ApplyState.APPLIED,
        ApplyState.FAILED,
        ApplyState.EXPIRED,
        ApplyState.INVALID,
    ):
        with pytest.raises(ValueError, match="only be cancelled"):
            qa.cancel(state_op(st))


# ---------------------------------------------------------------------------
# revalidation
# ---------------------------------------------------------------------------


def test_revalidate_invalidate_on_scope_or_token_change():
    op = qa.request_apply(base(), 1.0, "tok", "fp")
    unchanged = qa.revalidate(op, scope_changed=False, token_stale=False)
    assert unchanged is op
    invalid = qa.revalidate(op, scope_changed=True, token_stale=False)
    assert invalid.state == ApplyState.INVALID
    assert invalid.needs_revalidation is True
    assert invalid.desired_rev == "rev1"  # delta retained
    token_stale = qa.revalidate(
        qa.request_apply(base(), 1.0, "tok", "fp"),
        scope_changed=False,
        token_stale=True,
    )
    assert token_stale.state == ApplyState.INVALID
    # an already-invalid op is stable; terminals are ignored entirely
    invalid_op = state_op(ApplyState.INVALID)
    assert qa.revalidate(invalid_op, True, True) is invalid_op
    applied = state_op(ApplyState.APPLIED)
    assert qa.revalidate(applied, True, True) is applied


def test_revalidate_covers_inflight_apply_too():
    op = qa.drain(
        qa.request_apply(base(), 1.0, "tok", "fp"), now=2.0, active_requests=0
    )
    op = qa.revalidate(op, scope_changed=True, token_stale=False)
    assert op.state == ApplyState.INVALID
    # after invalidation the op can no longer be applied
    with pytest.raises(ValueError, match="only valid while the op is APPLYING"):
        qa.apply(op, restart_ok=True, now=3.0)


# ---------------------------------------------------------------------------
# reconcile: daemon restart recovery
# ---------------------------------------------------------------------------


def test_reconcile_queues_and_applying_to_failed_never_applied():
    # queued when the daemon restarts
    op = qa.request_apply(base(), 1.0, "tok", "fp")
    reconciled = qa.reconcile_op(op, now=60.0)
    assert reconciled.state == ApplyState.FAILED
    assert reconciled.needs_revalidation is True
    assert reconciled.rolled_back == ApplyState.ROLLODBACK_UNKNOWN
    assert reconciled.desired_rev == "rev1"  # change retained
    assert reconciled.applied_rev == "rev0"
    assert qa.is_pending(reconciled) is True
    # applying when the daemon restarts
    op = qa.drain(
        qa.request_apply(base(), 1.0, "tok", "fp"), now=2.0, active_requests=0
    )
    reconciled = qa.reconcile_op(op, now=60.0)
    assert reconciled.state == ApplyState.FAILED
    assert reconciled.needs_revalidation is True
    assert reconciled.rolled_back == ApplyState.ROLLODBACK_UNKNOWN
    # settled ops are untouched (identity preserved)
    for st in (
        ApplyState.PENDING,
        ApplyState.APPLIED,
        ApplyState.FAILED,
        ApplyState.CANCELLED,
        ApplyState.EXPIRED,
        ApplyState.INVALID,
    ):
        settled = state_op(st)
        assert qa.reconcile_op(settled, now=60.0) is settled


# ---------------------------------------------------------------------------
# retry is a fresh review
# ---------------------------------------------------------------------------


def test_retry_is_a_fresh_op_with_fresh_review_token():
    # fail, then retry via a brand-new operation (fresh review + token)
    op = qa.request_apply(base(), 1.0, "tok", "fp")
    op = qa.drain(op, now=2.0, active_requests=0)
    op = qa.apply(op, restart_ok=False, now=3.0)
    assert op.state == ApplyState.FAILED
    fresh = qa.save_op(qa.create_op("d1", "rev2", "rev0", 4.0), "rev2", 5.0)
    fresh = qa.request_apply(
        fresh, now=6.0, token="fresh-tok", scope_fingerprint="fp-2"
    )
    assert fresh.state == ApplyState.QUEUED
    assert fresh.token == "fresh-tok"
    # same path after a restart-reconciled failure
    op = qa.drain(
        qa.request_apply(base(), 1.0, "tok", "fp"), now=2.0, active_requests=0
    )
    crashed = qa.reconcile_op(op, now=10.0)
    assert crashed.state == ApplyState.FAILED
    fresh = qa.create_op("d1", "rev1", "rev0", now=50.0)
    assert (
        qa.request_apply(
            fresh, now=60.0, token="new-tok", scope_fingerprint="fp-3"
        ).state
        == ApplyState.QUEUED
    )


# ---------------------------------------------------------------------------
# is_pending: desired-vs-applied delta, not just operation state
# ---------------------------------------------------------------------------


def test_is_pending_tracks_delta_not_just_operation_state():
    assert qa.is_pending(base()) is True
    assert (
        qa.is_pending(state_op(ApplyState.QUEUED, token="tok", scope_fingerprint="fp"))
        is True
    )
    assert (
        qa.is_pending(
            state_op(ApplyState.APPLYING, token="tok", scope_fingerprint="fp")
        )
        is True
    )
    assert qa.is_pending(state_op(ApplyState.FAILED)) is True
    assert qa.is_pending(state_op(ApplyState.EXPIRED)) is True
    assert qa.is_pending(state_op(ApplyState.INVALID)) is True
    assert qa.is_pending(state_op(ApplyState.CANCELLED)) is True
    assert (
        qa.is_pending(state_op(ApplyState.APPLIED, desired="rev1", applied="rev1"))
        is False
    )
    assert (
        qa.is_pending(state_op(ApplyState.PENDING, desired="rev0", applied="rev0"))
        is False
    )
    # the method agrees with the module function
    applied = qa.drain(
        qa.request_apply(base(), 1.0, "tok", "fp"), now=2.0, active_requests=0
    )
    applied = qa.apply(applied, restart_ok=True, now=3.0)
    assert applied.is_pending() is False
    assert applied.is_pending() == qa.is_pending(applied)


# ---------------------------------------------------------------------------
# validate_op: store round-trip invariants
# ---------------------------------------------------------------------------


def test_validate_op_rejects_corrupt_records():
    with pytest.raises(ValueError, match="desired == applied"):
        qa.validate_op(state_op(ApplyState.APPLIED))  # APPLIED but delta !=
    with pytest.raises(ValueError, match="reviewed token"):
        qa.validate_op(state_op(ApplyState.QUEUED))  # in-flight, no token
    with pytest.raises(ValueError, match="reviewed token"):
        qa.validate_op(state_op(ApplyState.APPLYING))  # in-flight, no fingerprint


def test_validate_op_accepts_valid_lifecycle_records():
    qa.validate_op(base())
    op = qa.request_apply(base(), 1.0, "tok", "fp")
    qa.validate_op(op)
    op = qa.drain(op, now=2.0, active_requests=0)
    qa.validate_op(op)
    op = qa.apply(op, restart_ok=True, now=3.0)
    qa.validate_op(op)
    op = qa.drain(
        qa.request_apply(base(), 1.0, "tok", "fp"), now=2.0, active_requests=0
    )
    failed = qa.apply(op, restart_ok=False, now=3.0, error="boom")
    qa.validate_op(failed)


def test_apply_state_machine_is_consistent():
    # Every state is a legal value; terminals have no outgoing transitions
    assert ApplyState.ROLLODBACK_PENDING == "pending"
    assert ApplyState.ROLLODBACK_UNKNOWN == "unknown"
    assert ApplyState.ROLLODBACK_SUCCEEDED == "succeeded"
    assert set(ApplyState.LEGAL[ApplyState.APPLIED]) == set()
    assert ApplyState.PENDING in ApplyState.CANCELLABLE
    assert ApplyState.QUEUED in ApplyState.CANCELLABLE
    assert ApplyState.APPLYING not in ApplyState.CANCELLABLE
    assert ApplyState.QUEUED in ApplyState.IN_FLIGHT
    assert ApplyState.APPLYING in ApplyState.IN_FLIGHT
