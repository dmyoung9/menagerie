# Editing deployments

Deployments are created and edited with the same data and naming semantics. In the
pool-first model every model is a **member of a serving pool**; there are no standalone
deployments. On the Deployments page the page head offers two page-level actions:

- **New pool** opens a pool wizard that creates an empty pool.
- **New deployment** opens the setup wizard for a member that joins an *existing* pool.

The wizard does **not** create pools inline — a pool must already exist, and **New
deployment** offers a **Pool** selector for the member to join. The old **Add model**
action is retired. In the zero-pool empty state, **Create a pool** appears as the
primary action. **Create deployment** on an installed model card opens the same
wizard directly, with that model preselected. Creating a deployment saves its
configuration; it does not load models until you choose a loading action.

## Creating a pool

**New pool** (from the Deployments page head, or from **Create a pool** in the zero-pool
empty state) opens a pool wizard. A pool is the serving unit: one installed native
runtime, one device, and one shared serving port. The wizard fields are:

- **Name** — the pool's display name.
- **Shared installed engine** — the runtime installation every member will route through.
  Only compatible pool-ready engines are offered.
- **Shared device** — the GPU (or CPU) placement every member uses.
- **Serving port** — the single private port the pool's router listens on. Menagerie
  reserves 8001 and 8017.

**Create pool** saves the empty pool. No members are created yet; models join through
**New deployment**.

## Setting up a model

The **New deployment** wizard runs three steps — **Choose model**, **Review setup**,
and **Make available**.

- **Choose model** selects an installed model. The engine is inherited from the pool,
  so there is no engine selection in this wizard. A note reads:
  "The selected pool's runtime, device and policy are inherited."
  If no models are installed, the step shows **Add your first model** with
  **Discover models** and **Add from file**; the setup draft is retained through those
  detours.
- **Review setup** shows the display name (helper: "Used throughout Menagerie and in
  connected clients.") and API model, plus a **Pool** selector whose options are
  "Join pool: {pool name}" and whose hint is "Joins the selected pool, including its
  runtime, device and policy." Joining inherits the pool's residency, priority, idle
  timeout, eviction consent, and queue timeout. There is no inline pool creation and no
  **Pool name** / **Serving port** field here.
- **Make available** offers:
  - **Make available and load** — saves, enables, and proceeds through the required
    launch review, which lists any deployments that would unload; it does not send an
    inference test.
  - **Make available without loading** — enables on-demand use without an immediate load.
  - **Save disabled** — saves the member disabled (advanced/secondary action).
- A load that requires unloading other work shows **Will unload** in the launch review
  before proceeding. A failed load keeps the saved configuration for review, with
  **View error**, **Edit setup**, and **Try again**.

Completion distinguishes availability from measured inference. Loading completion is
"{name} is loaded and available". The without-loading path shows "{name} is available"
and loads on the first request. A saved-but-not-applied shared change shows "Setup saved.
Changes are waiting to be applied." and a saved-disabled member shows "{name} is saved
and disabled".

## Member settings

Select a member to edit its context, concurrency, cache, GPU placement, and client
capabilities. A member's editor keeps the member's **own** settings — Identity, Model
& runtime, Resources & context, Generation, and Diagnostics & raw — and has **no**
pool-level **Availability** section; loading and client-exposure policy belongs to the
pool. Switching members keeps unsaved changes in the open editor. Context and memory
estimates are guidance, not guarantees that a workload will fit. CPU/RAM offload can
reduce GPU requirements at the cost of performance.

Changing the member's runtime can reset engine-specific settings; review the confirmation
before continuing. Uncommon runtime options and environment overrides are available in
Advanced settings. Only use options supported by the selected engine.

## Pool settings

**Edit pool** (from a pool's Actions menu, or the pool's **Configuration** tab) opens a
pool-settings-only editor. It shows only the settings shared by every member:

- **Name**, **Shared installed engine**, **Shared device**, **Serving port**.
- **Availability** — loading and client exposure, shared by all members:
  - **Mode** — On demand, Pinned, or Evictable.
  - **Priority** — used when deciding which eligible models can make room.
  - **Idle timeout** — for non-pinned on-demand modes.
  - **Can unload to make room for another deployment** — eviction consent.
  - **Enabled for clients** — whether the pool is advertised to clients.
  - **Advanced availability** — queue timeout and private port.
- **Lifecycle owner** and **Maximum resident models**.

Pool settings affect every pool member: "Shared engine, device visibility, loading
policy and resident-model limit affect every pool member. Resource estimates are
per-model advice, not individual shares of the pool process allocation. Unload the
entire pool before editing." Changing the shared engine resets engine-specific options
for every member and asks for confirmation.

## Per-member enable/disable

Each member row in a pool offers an **Enable** / **Disable** button that toggles that
member's client availability via the pool's member enable endpoint. The confirmation
dialog is titled **Enable {member}?** or **Disable {member}?** and explains the effect:
"Enable this deployment for clients? It will not load immediately." or "Remove this
deployment's models from client discovery? Their configuration will be kept."
Disabling a member keeps its configuration; it is not uninstalled and does not unload
the pool.

## Chat template override

In the deployment wizard and the member editor, the **Chat template** setting defaults to
**Inherit model default** (engine default if the model default is Automatic). Choose a
specific template to override it for that deployment only; the model default and every
other deployment are untouched. The **Effective:** line shows what will actually run,
and notes "not available" if the chosen file is missing or failed to download.

## Loading policy

Loading and client-exposure policy is owned by the pool and inherited by its members.
Native pools use on-demand residency: members load when a client requests them.
Allowing eviction permits an eligible member
to unload to make room for other work. Memory accounting is advisory for manual and
on-demand loading; there is no uncertainty permission or capacity acknowledgment. Manual
launch review asks for consent to proposed unloads.

## Saving and leaving

Model and shared-pool settings remain editable while running. Unloaded pools offer
**Apply**; loaded idle pools offer **Apply and Reload**. Busy pools offer
**Apply and Reload when Idle**, or **Apply and Reload Now** with explicit confirmation
of request interruption. The old configuration and API ID remain active until application.
Reload affects the whole pool and loses cached context; models load again on demand.
Membership changes require unloading first.
Invalid input prevents saving; a failed save leaves the draft open. A stale revision
offers **Review changes** without dropping edits.

Queued application waits up to 30 seconds for current requests. New requests for that
runtime wait within their request queue timeout; other runtimes keep serving. Timeout,
cancellation, changed consent, or startup failure retain pending edits. Startup failure
attempts to restore the prior runtime configuration and reports the restoration outcome.
After a daemon restart, interrupted operations require fresh review; they are not
silently replayed or reported as applied.

Editors warn before discarding changes. Drafts do not survive a page reload. The setup
wizard retains its draft during explicit engine and acquisition detours; other editor
navigation still requires saving or discarding unsaved edits.

Paths entered with **Add from File** refer to files on the Menagerie host, not files
uploaded from the browser's device. See [operations](operations.md) and [multi-model
deployments](multi-model-deployments.md).
