# Multi-model deployments

## Pools

Every model is a member of a serving pool; there are no standalone deployments. The
Deployments page lists pools as per-pool cards with their member models, and a model is
always created into a pool.

A pool delegates model routing and residency to one installed, compatible runtime and
owns the settings shared by all its members: runtime, device visibility, serving port,
loading policy, priority, idle timeout, client availability, eviction consent, queue
timeout, and resident-model limit. Members keep their own API alias, per-model
configuration, capabilities and variant catalog, process log, and session
history.

A runtime pool is on-demand: starting it starts a router, not every model. Each member
loads when requested. The router listens on the pool's single shared private port;
members do not have their own listeners. Stopping stops the whole pool.

Eviction consent enables pool-local LRU limits and supported device-memory margin
unloading. Without consent, those automatic eviction limits are disabled. Idle sleep
still follows the pool's configured timeout when the runtime supports it. Pinned and
atomic residency are not supported. Native pools currently support
native llama.cpp-compatible builds, not containers or other runtime protocols. See
[runtime behavior and limitations](releases/3.0.0.md).

## Creation and management

The Deployments page head offers two page-level actions. There is no **Add model**
button and no inline pool creation in the model wizard.

- **New pool** (Deployments page head, or **Create a pool** in the zero-pool empty
  state) opens the pool wizard to create an *empty* pool: name it, pick a shared
  installed engine, a shared device, and a serving port. **Create pool** saves it. No
  members are created; they are added separately through **New deployment**. It works
  even when there are no existing deployments.
- **New deployment** (Deployments page head) opens the setup wizard that *joins an
  existing pool*. Choose a model, review the member's settings (inheriting the pool's
  runtime, device, and policy), pick the pool from the **Pool** selector, then make it
  available with **Make available and load**, **Make available without loading**, or
  **Save disabled**. The wizard offers no **Pool name** or **Serving port** fields and
  cannot create a pool inline; a pool must exist first.
- A pool's card shows the pool's status, shared metadata, and a member table. The
  pool's **Actions** menu offers **Edit pool** (reopens the pool editor for its shared
  settings) and **Delete pool** (removes the pool and its members' deployment records).
  **Edit model** on a member exposes its engine and inference settings directly.
   Settings remain editable while loaded; applying them restarts the whole pool.
- **Remove model** on a member takes it out of the pool; the member's deployment record
  is deleted after the pool save. Model files and installed weights stay on disk. A
  member is never orphaned into a standalone configuration.
- Each member row in the pool's card table has an **Enable** / **Disable** button that
  toggles that member's client availability without changing the pool's shared policy.
  Disabling keeps the member's configuration and does not unload the pool.

The pool editor is **pool settings only**: it edits the shared settings (name, engine,
device, port, loading/availability policy) but not member settings. Members are
configured through their own editor, which has no pool-level **Availability** section.

The same installed weights can be used in any number of pools, with different context
sizes, engines, capabilities, names, and policies. Each occurrence gets its own serving
instance, configuration history, and unique API alias. Weights are referenced, not
copied. Concurrently loaded instances still consume their own runtime memory and pass
normal admission checks; they do not implicitly share a process or KV cache. Suggested
aliases include the pool name but remain explicit and stable when the display name is
later changed.

Creating a member saves it without loading; it joins the chosen pool and inherits that
pool's shared policy. Saving a pool's shared policy preserves its existing members —
member changes are not lost or cleared by a pool save.

## Applying configuration

- An unloaded pool offers **Apply** and stays unloaded.
- A loaded, idle pool offers **Apply and Reload**.
- A busy pool offers **Apply and Reload when Idle**, which holds new gateway
  requests while existing requests finish within a bounded wait. **Cancel scheduled
  reload** cancels before application begins and retains the proposal for retry.
- **Apply and Reload Now** requires confirmation that active requests will be
  interrupted. Becoming busy after an idle review never silently authorizes this.
- Reload affects every member of the pool and loses cached context. It restarts
  the router; models load on demand instead of restoring previous residency.
- A failed reload retains the proposal and reports whether the previous runtime
  was restored or remains stopped. Review the error before retrying or discarding.
- Adding or removing members always requires unloading first.

## History and recovery

Restoring model history creates a disabled native pool with one restored member;
restoring a pool activation restores its members together. New aliases and a new
pool port keep restoration independent; it does not restart the historical workload
automatically. Backups retain configuration snapshots, not model weights. See
[installation and recovery](installation.md#restore-a-registry-backup).

Contributors: API and storage invariants are described in
[development](development.md#serving-deployment-contracts); test requirements are
in [testing](testing.md).
