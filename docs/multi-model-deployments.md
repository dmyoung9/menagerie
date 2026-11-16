# Multi-model deployments

## Pools

Every model is a member of a serving pool; there are no standalone deployments. The
Deployment page lists pools as per-pool sections with their member models, and a model
is always created into a pool.

A pool delegates model routing and residency to one installed, compatible runtime and
owns the settings shared by all its members: runtime, device visibility, serving port,
loading policy, priority, idle timeout, client availability, eviction consent, queue
timeout, and resident-model limit. Members keep their own API alias, per-model
configuration, capabilities and variant catalog, raw arguments, process log, and session
history.

A runtime pool is on-demand: starting it starts a router, not every model. Each member
loads when requested. The router listens on the pool's single shared private port; members
do not have their own listeners. Stopping stops the whole pool.

Eviction consent enables pool-local LRU limits and supported device-memory margin
unloading. Without consent, those automatic eviction limits are disabled. Idle sleep
still follows the pool's configured timeout when the runtime supports it. Use coordinated
processes for pinned models or atomic model residency. Native pools currently support
native llama.cpp-compatible builds, not containers or other runtime protocols. See
[runtime behavior and limitations](releases/3.0.0.md).

## Creation and management

- **New pool** (deployments page) opens the pool editor to create a pool and, if desired,
  its members. Name the pool, pick a runtime and device visibility, add installed models,
  and configure each member's engine and inference settings. No prior pool or standalone
  deployment is needed; it works even when there are no existing deployments.
- **Add model** (a pool's Actions menu, or the deployments page head) runs the setup
  wizard: choose a model and engine, pick the runtime, then choose to **join** an
  existing runtime pool (including its runtime, port, and policy) or create a **new
  pool** (which shares one engine, device, and port). Review the member's settings and
  make it available. A model is always created into a pool; no placement leaves it
  standalone.
- The **Configuration** tab of a pool shows the member composer (pick an installed model
  and append it with common defaults) and, for the selected member, its Model & runtime
  and Variants settings. Appending a member updates the local draft only; nothing is
  written until the pool is saved.
- **Edit pool** (a pool's Actions menu, or its Configuration tab) reopens the pool editor
  for its members and shared policy. **Edit model** on a member exposes its engine and
  inference settings directly. Unload the pool before editing members or shared policy.
- **Delete pool** removes the pool and its members' deployment records.
- **Remove model** on a member takes it out of the pool; the member's deployment record
  is deleted after the pool save. Model files and installed weights stay on disk. A
  member is never orphaned into a standalone configuration.

The same installed weights can be used in any number of pools, with different context
sizes, engines, capabilities, names, and policies. Each occurrence gets its own serving
instance, configuration history, and unique API alias. Weights are referenced, not
copied. Concurrently loaded instances still consume their own runtime memory and pass
normal admission checks; they do not implicitly share a process or KV cache. Suggested
aliases include the pool name but remain explicit and stable when the display name is
later changed.

Creating a pool and its members saves them atomically without loading. A failed or stale
save rolls back all member changes.

## Coordinated-process operation

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
have compatible priorities, and not be pinned. Observed history or file-size/KV
accounting informs proposed switches, but never reserves memory or blocks a start.
Manual launch review preserves consent to proposed unloads. A start can
still fail if external memory use changes after admission, and that failure stays
visible. Group membership does not bypass these safeguards.

## History and recovery

Restoring launch history creates a pool with a single member (the restored model) with
new aliases and ports for review; it does not restart the historical workload
automatically. Backups retain configuration snapshots, not model weights. See
[installation and recovery](installation.md#restore-a-registry-backup).

Contributors: API and storage invariants are described in
[development](development.md#serving-deployment-contracts); test requirements are
in [testing](testing.md).
