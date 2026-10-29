# Multi-model deployments

A serving deployment owns one or more models. Each member keeps its own API alias,
runtime, configuration snapshot, port, process log, and session history. Loading mode,
priority, idle timeout, client availability, and eviction
permission belong to the deployment.

## Operation

- A request to either alias in an on-demand deployment loads all its members before
  admitting the request. Concurrent cold requests are serialized through admission;
  they do not launch duplicate processes.
- Idle time starts when the last request across all members finishes. A busy member
  protects every member from unloading and automatic eviction.
- Making room for another deployment unloads the entire victim deployment. Only
  explicitly evictable, non-pinned deployments of equal or lower priority qualify.
  Victims are selected against per-GPU requirements, not summed free memory across GPUs.
- Busy eligible victims are allowed to finish within the requesting deployment's
  switch timeout. Waiting releases the admission lock so existing nested requests
  can finish. New incoming traffic can delay the switch until its bounded timeout.
- Manual unloading also waits for active requests. It does not disable on-demand
  aliases; a later request can load the deployment again.
- Admission reserves the complete launch before starting any process. Starts remain
  ordered, not simultaneous. A failure rolls back newly started members and attempts
  to restore any stopped predecessors. Restoration failures remain visible.
- A deployment is Ready only when all members are Ready. A member failure while
  another remains running makes it Degraded. Pinned deployments are not advertised
  as ready with only part of the configuration healthy.
- Pinned deployments restore their complete membership after a daemon restart when
  they were running at shutdown. A manual unload clears that restart intent.

For automatic switching in both directions, both deployments must permit eviction,
have compatible priorities, and not be pinned. On-demand starts are admitted against
the reviewed memory estimate; uncertain estimates require the saved on-demand
permission. Manual launch review supplies an explicit override. A start can
still fail if external memory use changes after admission, and that failure stays
visible. Group membership does not bypass these safeguards.

## Creation

**New deployment → Multiple models** adds models from the installed weights library.
Name the deployment, add models, configure each engine and its inference settings,
and choose the shared loading policy. No profile or standalone deployment is needed
first. This works even when there are no existing deployments.

The same installed weights can be used in any number of deployments, with different
context sizes, engines, capabilities, names and policies. Each occurrence gets its
own serving instance, configuration history, unique API alias and private port.
Weights are referenced, not copied. Concurrently loaded instances still consume
their own runtime memory and pass normal admission checks; they do not implicitly
share a process or KV cache. Suggested aliases include the deployment name, but
remain explicit and stable when the display name is later changed.

Creation saves the complete deployment and its members atomically without loading.
**Edit** configures all members and shared policy together; **Edit model** on a member
also exposes its engine and inference settings directly. Unload the complete
deployment before editing. A failed or stale save rolls back all member changes.
Removing an existing member preserves it as an inactive standalone configuration.

**Edit → Separate models** makes each member a standalone deployment again, retaining
the current shared policies. It also requires an unloaded deployment. Membership
cannot overlap or nest at the runtime-instance level: an instance has one lifecycle
owner, but its installed model artifact is reusable across deployments.

## History and recovery

Restoring launch history creates an inactive deployment with new aliases and ports
for review; it does not restart the historical workload automatically. Backups
retain configuration snapshots, not model weights. See
[installation and recovery](installation.md#restore-a-registry-backup).

Contributors: API and storage invariants are described in
[development](development.md#serving-deployment-contracts); test requirements are
in [testing](testing.md).
