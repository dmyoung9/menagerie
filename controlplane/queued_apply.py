"""Desired-versus-applied configuration and the queued-apply contract
(Stage 1 of the model-first UI plan).

Saving a shared-runtime change and applying it are distinct operations. A
*save* moves the deployment's **desired** configuration; the **applied**
configuration (what the runtime is actually executing) is untouched until an
explicit, reviewed *apply* runs. This module specifies that split and the
state machine for the explicit "Apply when idle" operation, together with the
cancellation, draining/holding, revalidation, and restart-recovery boundaries
the plan requires:

- Save does not restart the runtime; it only enqueues desired changes as
  pending.
- Apply when idle is an explicitly requested, reviewed operation. It drains
  active requests and holds new ones for the affected runtime, with a *bounded*
  waiting deadline, and revalidates the revision and launch plan immediately
  before application.
- Cancellation is only valid *before* the application begins; saved changes
  remain pending either way.
- A failed application keeps the desired change available and reports rollback
  status; it never rolls the user back to the previous configuration.
- Recovery after a daemon restart must reconcile an interrupted application
  safely and must not falsely report an in-flight change as Applied.
- Unaffected runtimes keep serving.

The state machine here is the contract; Stage 4 wires it to the Manager's
``validate``/``activate``/``wait_for_requests`` surfaces. State names and the
operation record shape are what the API serialises.

The operation record is a serialise-ready dataclass (strs, floats, bools and
None), so it can be persisted through the store as a plain dict and validated
round-trip, matching the rest of the registry.
"""

from __future__ import annotations

from dataclasses import dataclass, field


class ApplyState:
    """The queued-apply state machine, in order of the operation's lifecycle."""

    PENDING = "pending"
    QUEUED = "queued"
    APPLYING = "applying"
    APPLIED = "applied"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    INVALID = "invalid"

    # A terminal state is one no further operation can move from.
    TERMINAL = {APPLIED, FAILED, CANCELLED, EXPIRED}
    # States from which a cancellation is still allowed: the user can still
    # back out before the restart has begun. Once the unit is restarting
    # (APPLYING) or already finished, the change is committed in flight.
    CANCELLABLE = {PENDING, QUEUED}
    # States in which the runtime is actually being restarted.
    IN_FLIGHT = {QUEUED, APPLYING}
    # A legal transition must move *forward* in the lifecycle, not rewind it
    # to a state that would drop an already-committed result. A pending or
    # queued op may be cancelled before the restart is reviewed; restart
    # recovery (reconcile_op) may take an in-flight op straight to FAILED.
    LEGAL = {
        PENDING: {QUEUED, CANCELLED, INVALID},
        QUEUED: {APPLYING, CANCELLED, EXPIRED, INVALID, FAILED},
        APPLYING: {APPLIED, FAILED, INVALID},
        INVALID: {PENDING, CANCELLED},
        APPLIED: set(),
        FAILED: set(),
        CANCELLED: set(),
        EXPIRED: set(),
    }

    # Default bounded holding window for new requests during a restart, in
    # seconds. Long enough that in-flight work is drained and a client's follow-
    # up is not lost, short enough that a hung drain surfaces rather than
    # silently waiting forever.
    DRAIN_HOLD_SECONDS = 30

    # Where the rollback state of the *applied* configuration can be reported.
    ROLLODBACK_PENDING = "pending"
    ROLLODBACK_UNKNOWN = "unknown"
    ROLLODBACK_SUCCEEDED = "succeeded"


@dataclass
class QueuedApplyOp:
    deployment_id: str
    desired_rev: str
    applied_rev: str
    state: ApplyState = ApplyState.PENDING
    token: str | None = None
    scope_fingerprint: str | None = None
    drain_deadline: float | None = None
    created_at: float = field(default_factory=float)
    ended_at: float | None = None
    error: str | None = None
    rolled_back: ApplyState.ROLLODBACK_PENDING | None = ApplyState.ROLLODBACK_PENDING
    needs_revalidation: bool = False

    def __post_init__(self):
        # Permissive construction: the public API functions are the only state
        # mutators, and each enforces the invariants relevant to its transition.
        # ``validate_op`` is the separate check the API applies to a record read
        # back from the store.
        pass

    def is_pending(self) -> bool:
        """Whether a desired-vs-applied delta still needs user resolution
        (save it, apply it, or discard it) - the user-visible "pending change".

        Only an *applied* operation is fully resolved; every other state still
        carries the delta (a failed, expired, or cancelled apply leaves the
        saved change pending).
        """
        return is_pending(self)

    def _move_to(self, new_state: ApplyState) -> "QueuedApplyOp":
        if self.state in ApplyState.TERMINAL:
            raise ValueError(f"Cannot transition from terminal state {self.state!r}")
        if new_state not in ApplyState.LEGAL.get(self.state, set()):
            raise ValueError(
                f"Illegal queued-apply transition {self.state!r} -> {new_state!r}"
            )
        return QueuedApplyOp(
            deployment_id=self.deployment_id,
            desired_rev=self.desired_rev,
            applied_rev=self.applied_rev,
            state=new_state,
            token=self.token,
            scope_fingerprint=self.scope_fingerprint,
            drain_deadline=self.drain_deadline,
            created_at=self.created_at,
            ended_at=self.ended_at,
            error=self.error,
            rolled_back=self.rolled_back,
            needs_revalidation=self.needs_revalidation,
        )

    def _with(self, **kw) -> "QueuedApplyOp":
        """Return an immutable copy with the given fields replaced."""
        return QueuedApplyOp(
            deployment_id=self.deployment_id,
            desired_rev=kw.get("desired_rev", self.desired_rev),
            applied_rev=kw.get("applied_rev", self.applied_rev),
            state=kw.get("state", self.state),
            token=kw.get("token", self.token),
            scope_fingerprint=kw.get("scope_fingerprint", self.scope_fingerprint),
            drain_deadline=kw.get("drain_deadline", self.drain_deadline),
            created_at=kw.get("created_at", self.created_at),
            ended_at=kw.get("ended_at", self.ended_at),
            error=kw.get("error", self.error),
            rolled_back=kw.get("rolled_back", self.rolled_back),
            needs_revalidation=kw.get("needs_revalidation", self.needs_revalidation),
        )


# --- validation ---------------------------------------------------------------


def validate_op(op: QueuedApplyOp) -> None:
    """Assert a queued-apply record is internally consistent. This is the
    contract check the API applies to a record read back from the store (the
    invariants the public transition functions maintain). Raises ``ValueError``
    on a corrupt or impossible record rather than trusting it.

    (The public functions enforce the same invariants on every transition they
    make; this exists so a persisted record can be re-validated after a store
    read or a daemon restart without the caller re-walking the history.)"""
    if op.state == ApplyState.APPLIED and op.desired_rev != op.applied_rev:
        raise ValueError(
            "An Applied operation must have desired == applied; this record is "
            "corrupt and must not be trusted."
        )
    if op.state in ApplyState.IN_FLIGHT and (
        op.token is None or op.scope_fingerprint is None
    ):
        raise ValueError(
            "An in-flight apply must carry a reviewed token; a persisted in-flight "
            "record without one is corrupt."
        )


def create_op(
    deployment_id: str,
    desired_rev: str,
    applied_rev: str,
    now: float,
) -> QueuedApplyOp:
    """Start a queued-apply operation for a saved change.

    The operation starts PENDING with the desired revision moved and the applied
    revision untouched. (If the two are equal there is simply no delta;
    ``is_pending`` reports it as not pending.)
    """
    return QueuedApplyOp(
        deployment_id=deployment_id,
        desired_rev=desired_rev,
        applied_rev=applied_rev,
        state=ApplyState.PENDING,
        created_at=now,
    )


def save_op(op: QueuedApplyOp, desired_rev: str, now: float) -> QueuedApplyOp:
    """Move the *desired* configuration. The applied configuration is left
    untouched: saving is not applying, so it must not restart the runtime or
    move ``applied_rev``. The change is (re)pending whenever desired differs
    from applied. A save is only accepted while the deployment's previous apply
    is settled (PENDING); a change made while an apply is in flight is a
    concurrent-conflict case the UI must reconcile, not a silent overwrite of
    the in-flight operation."""
    if op.state is not ApplyState.PENDING:
        raise ValueError(
            "A deployment can only accept a new desired configuration while its "
            "previous apply is settled. Resolve or cancel the in-flight apply "
            "before saving another change."
        )
    return op._with(desired_rev=desired_rev)


def request_apply(
    op: QueuedApplyOp,
    now: float,
    token: str,
    scope_fingerprint: str,
) -> QueuedApplyOp:
    """Queue a reviewed apply. Only a *reviewed* operation may begin: it
    must carry a fresh ``token`` and the ``scope_fingerprint`` of the unit
    whose scope was reviewed. The op enters QUEUED and starts a bounded
    drain/hold window. Calling this while the op is already queued/applying
    (or terminal) is rejected so duplicate submissions cannot race.
    """
    if not token or not scope_fingerprint:
        raise ValueError(
            "Queuing an apply requires a reviewed token and scope fingerprint."
        )
    if op.state is not ApplyState.PENDING:
        raise ValueError(
            "An apply can only be requested from a pending operation that has "
            "not yet been queued."
        )
    return op._move_to(ApplyState.QUEUED)._with(
        token=token,
        scope_fingerprint=scope_fingerprint,
        drain_deadline=now + ApplyState.DRAIN_HOLD_SECONDS,
    )


def drain(op: QueuedApplyOp, now: float, active_requests: int) -> QueuedApplyOp:
    """Advance the drain/hold. While active requests remain (or the unit is
    not idle), the op holds new requests and waits. When there are no active
    requests it moves to APPLYING. If the bounded deadline is exceeded it
    expires rather than blocking indefinitely: the change stays pending.
    """
    if op.state is not ApplyState.QUEUED:
        return op
    if active_requests > 0:
        if now >= (op.drain_deadline or 0):
            return op._move_to(ApplyState.EXPIRED)._with(
                error=(
                    "Timed out waiting for the unit to go idle; the "
                    "change remains pending."
                )
            )
        return op
    return op._move_to(ApplyState.APPLYING)


def apply(
    op: QueuedApplyOp, restart_ok: bool, now: float, error: str | None = None
) -> QueuedApplyOp:
    """Perform the restart. On success the desired revision becomes the applied
    one (and only then may the op be reported as Applied). On failure the
    desired change is retained and rollback status is reported; the user's
    saved changes are never discarded. A failed or interrupted apply is a new
    operation only via a *fresh* review (a new op with a fresh token), never by
    rewinding this one."""
    if op.state is not ApplyState.APPLYING:
        raise ValueError("apply() is only valid while the op is APPLYING")
    if restart_ok:
        return op._move_to(ApplyState.APPLIED)._with(
            applied_rev=op.desired_rev,
            rolled_back=ApplyState.ROLLODBACK_SUCCEEDED,
            error=None,
            ended_at=now,
        )
    return op._move_to(ApplyState.FAILED)._with(
        error=error or "Could not apply changes. Your saved changes are still pending.",
        rolled_back=ApplyState.ROLLODBACK_PENDING,
        ended_at=now,
    )


def cancel(op: QueuedApplyOp) -> QueuedApplyOp:
    """Cancel the queued operation. Only allowed while the restart has not
    begun (PENDING/QUEUED). Once applying, the change is already in flight and
    cannot be safely cancelled; the saved changes remain pending either way.
    """
    if op.state not in ApplyState.CANCELLABLE:
        raise ValueError(
            "A queued apply can only be cancelled before application begins."
        )
    return op._move_to(ApplyState.CANCELLED)._with(
        error="Cancelled scheduled apply. Saved changes remain pending.",
    )


def revalidate(
    op: QueuedApplyOp, scope_changed: bool, token_stale: bool
) -> QueuedApplyOp:
    """Revalidate the review immediately before application. If the reviewed
    scope (unit membership / unloads) or the token has changed since the
    review, the old consent no longer applies and a fresh review is required;
    the op becomes INVALID and may only be re-queued after re-reviewing.
    """
    if op.state in ApplyState.TERMINAL or op.state == ApplyState.INVALID:
        return op
    if scope_changed or token_stale:
        return op._with(
            state=ApplyState.INVALID,
            needs_revalidation=True,
        )
    return op


def reconcile_op(op: QueuedApplyOp, now: float) -> QueuedApplyOp:
    """Reconcile an in-flight operation after a daemon restart.

    The daemon cannot trust its own memory across a restart: any op that was
    QUEUED or APPLYING when it died must *not* be reported as Applied. The
    change is retained (still pending) and flagged for revalidation/retry.
    Everything not in flight (PENDING, APPLIED, FAILED, CANCELLED, EXPIRED, or
    INVALID) is left as-is.
    """
    if op.state == ApplyState.QUEUED:
        return op._move_to(ApplyState.FAILED)._with(
            error="Daemon restarted before the queued apply completed.",
            needs_revalidation=True,
            rolled_back=ApplyState.ROLLODBACK_UNKNOWN,
        )
    if op.state == ApplyState.APPLYING:
        # The restart happened mid-apply. We cannot verify the new config is
        # active, so we must not claim success; retain the desired change and
        # require a fresh review.
        return op._move_to(ApplyState.FAILED)._with(
            error="Daemon restarted while the apply was in progress.",
            needs_revalidation=True,
            rolled_back=ApplyState.ROLLODBACK_UNKNOWN,
        )
    return op


def is_pending(op: QueuedApplyOp) -> bool:
    """True while there is a desired-vs-applied delta the user must resolve
    (save it, apply it, or discard it) - the user-visible "pending change".

    Only an *applied* operation is fully resolved; a cancelled, expired, or
    failed apply still leaves the saved change pending for the user to resolve
    again (apply it with a fresh review, or discard it).
    """
    return op.state != ApplyState.APPLIED and op.desired_rev != op.applied_rev
