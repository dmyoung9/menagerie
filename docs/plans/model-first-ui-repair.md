# Model-first UI repair contract

Status: **Agreed design; implementation and acceptance pending.**

This document is the scope and acceptance reference for repairing PR #42. It
supersedes conflicting requirements and shipped-status claims in
[the original plan](model-first-ui.md). It describes the target, not a claim
that the current implementation already behaves this way.

## Product decisions

- A deployment is a model member of an explicitly selected native router pool.
  Standalone deployments and Menagerie-supervised groups are retired workflows.
- A pool owns its runtime installation, device visibility, serving port,
  membership, and shared policy. Members own their model configuration and API
  identifiers. Installed weights remain reusable independently of deployments.
- Adding or removing members requires the pool to be unloaded. There are no
  staged additions, ownerless placeholders, or automatic pool assignments.
- Settings remain visible and editable while the pool is loaded or serving
  requests. Runtime activity changes the available application actions; it does
  not hide the settings.
- Reload restarts the pool router with the applied configuration. It does not
  restore previously resident models; those load on demand. Cached context is
  lost during restart.
- Fresh state is acceptable. Incompatible old state must be explicitly rejected
  and preserved for rollback. A normal launch must not silently interpret old
  records as the new layout. Migrating old installations is outside this repair.

## Configuration application

An editor starts from the authoritative configuration and tracks a local draft.
Editing alone does not change the registry, routing, availability, or processes.
There is no separate generic “save pending changes” step.

| Actual pool state | Offered action | Outcome |
| --- | --- | --- |
| Unloaded | **Apply** | Validate and save atomically; leave the pool unloaded. |
| Loaded, no active requests | **Apply and Reload** | Validate and save through the lifecycle owner, then restart the router. |
| Serving requests | **Apply and Reload when Idle** | Persist the reviewed proposal, drain current requests, and restart. |
| Serving requests | **Apply and Reload Now** | Confirm interruption of active requests, then interrupt and restart. |

All loaded-pool actions identify the whole affected pool and its member models.
The review explains that restart loses cached context and models subsequently
load on demand. “Now” requires specific confirmation of request interruption;
ordinary Apply consent is not permission to cancel requests.

The server rechecks activity, expected revisions, affected scope, dependencies,
and launch validity under the Manager's lifecycle lock. A pool becoming busy
after an idle review must not turn that action into an implicit force restart.
Changed configuration or consequences require fresh review.

Shared pool settings follow the same application contract where supported;
membership is always unloaded-only. Independent client-availability controls
must retain their explicit behavior and cannot silently apply a configuration
draft.

### Scheduled application

- Hold new gateway requests while admitted requests finish. Waiting is bounded;
  sustained traffic must not postpone the reload indefinitely.
- Keep the currently applied configuration authoritative until application.
  A scheduled proposal is durable so interrupted work can be explained and
  recovered, but must not be reported as already applied.
- Permit cancellation before application begins. Cancellation releases held
  requests and preserves the proposed values for editing/retry; it does not
  mutate the running configuration.
- Refuse conflicting saves or membership changes during scheduled/application
  work. Re-review is required after changes invalidate consent.
- On timeout, failed launch, or daemon interruption, retain the proposal and
  report the actual runtime/configuration outcome. Restore the previous usable
  configuration when possible; distinguish successful restoration from a
  stopped or unknown runtime. Never infer success from job submission.
- Apply/reload is not inference. Do not send a test prompt or eagerly restore
  model residency.

## Editor presentation

Use one compact action/status bar attached to the editor, rather than a separate
generic “Changes pending” section with a second save/apply workflow.

- Local edits: **Unsaved changes**, **Discard**, and the state-appropriate Apply
  action(s).
- Scheduled work: **Reload scheduled — waiting for active requests**, an actual
  count when available, and **Cancel scheduled reload**.
- Applying: show progress and prevent conflicting submission. Cancellation must
  not be offered once application has begun.
- Failure: show the error and whether the previous router was restored, stopped,
  or could not be verified. Keep proposed values available for review and retry.
- Completion: refresh the authoritative baseline and clear the dirty state only
  after the operation actually succeeds.

Navigation/dismissal must protect unsaved drafts. Reload controls must describe
the pool scope even inside an individual model editor.

## Fresh-state boundary

Introduce an explicit persisted-layout compatibility check covering the profile
collapse and pool-only ownership model. Verify that a previous-layout registry
is rejected before mutation, with a clear explanation to use fresh state and
retain the old installation/state together for rollback.

Retire the one-off migration scripts and unattended migration/install runners
from the supported implementation. Do not run them against personal state.
Fresh-state acceptance does not excuse broken history created by this version:
current-format session/activation restoration must produce valid disabled pool
members without starting a runtime.

## Review disposition

| Review finding | Repair direction |
| --- | --- |
| Migration replaces frozen configuration | Retire migration; enforce the fresh-state boundary. |
| Migration failure starts new code on old data | Retire unattended migration runners. |
| Sole-pool selector cannot advance | Fix selection state; verify native keyboard interaction. |
| Legacy standalone deployments disappear | Reject incompatible state explicitly rather than partially rendering it. |
| Shared engine/device edits rejected | Validate and mirror the proposed pool settings atomically. |
| Discarded addition becomes ownerless | Remove staged additions; enforce unloaded-only membership. |
| Null does not clear template override | Preserve explicit clearing separately from omission. |
| Historical activation lacks identities | Old-layout history is outside compatibility scope; test this version's restores. |
| Runtime deletion leaves dangling pool reference | Check all pool and scheduled-proposal dependencies. |
| Interrupted download stays downloading | Reconcile acquisition ownership and retryable status. |
| Completed download does not refresh inventory | Refresh on terminal transition, not merely on submission. |

## Repair sequence and evidence

1. Establish the fresh-state boundary and remove retired paths.
2. Implement atomic configuration application and bounded scheduled/forced
   restart through Manager ownership and locking.
3. Connect the always-accessible editor and single action bar to that contract.
4. Repair pool selection, nullable settings, dependency protection, and download
   recovery/refresh.
5. Reconcile user guides, contributor references, PR title/body, and the original
   plan with the actual supported behavior and observed checks.

Required behavioral acceptance uses temporary state, fake runtimes, mocked
downloads, and fresh browser contexts:

- Empty registry → create pool → add member → validate/load router.
- Loaded/serving settings remain accessible and editing does not mutate them.
- Unloaded Apply stays stopped; idle Apply and Reload restarts only the router.
- An idle-to-busy race does not interrupt requests without explicit consent.
- When Idle drains, holds new work, completes, cancels, and times out correctly.
- Now explicitly confirms interruption and respects the reviewed pool scope.
- Failed reload and daemon interruption retain truthful state and recoverable
  proposals; unaffected pools remain usable.
- Add/remove while loaded is rejected without creating placeholders.
- Shared runtime/device changes, explicit template clearing, and dependency
  deletion checks cross the real API boundary.
- Current-format history restores into valid disabled pools.
- Old-layout state is rejected without modification.
- A sole pool is selectable with native keyboard input; download completion and
  retry refresh inventory, and interrupted acquisition becomes retryable.

Use the checks in `docs/development.md` and the isolation rules in
`docs/testing.md`. Passing fixtures do not establish live inference, hardware,
or installed-client acceptance. Do not broaden this repair into new deployment
types, automatic assignment, general draft management, or resident-model recovery.
