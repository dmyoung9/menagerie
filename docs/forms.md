# Editing deployments

Deployments are created and edited with the same data and naming semantics.
From the Deployments page, **Set up model** opens the model setup wizard.
Explicit supervised groups and runtime pools are under **Advanced**. **Create
deployment** on an installed model card opens the same wizard directly, with
that model preselected. Creating a deployment saves its configuration; it
does not load models until you choose a loading action.

## Setting up a model

The **Set up model** wizard runs three steps — **Choose model**, **Review
setup**, and **Make available**.

- **Choose model** selects installed weights and their engine. When no
  compatible engine is installed, **Choose engine** opens the engines page;
  **Return to setup** restores the open draft. An empty library offers discovery
  or local-file import with the same return action. Reloading the page loses this draft.
- **Review setup** shows the display name and API model (generated from the
  name by default; **Customize API model ID** switches to a user-specified
  value that stays stable when the display name changes), the **Context
  capacity** choice, residency mode, and client capabilities.
- **Make available** offers **Make available and load** (saves, enables, and
  proceeds through the launch review, which lists any deployments that would
  unload; it does not send an inference test), **Make available without
  loading** (loads on the first request), and **Save disabled**.
- A load that requires unloading other work shows **Will unload** in the
  launch review before proceeding. A failed load keeps the saved configuration
  for review, with **View error**, **Edit setup**, and **Try again**.
- Compatible new setups join an automatically managed native runtime pool;
  incompatible setups use a separate supervised runtime. Existing assignments
  are preserved. **Advanced → Dedicated runtime** opts out for a new setup.
- Saving an edit to a running model, or adding to a running pool, leaves changes
  pending without interrupting serving models. **Review restart** lists affected
  models and other proposed unloads. **Apply when idle** explicitly schedules the
  reviewed transition. **Cancel scheduled apply** is available before application
  starts; **Discard pending changes** keeps the live configuration. Discarding a
  pending addition retains that setup as a disabled standalone model.
- Loading completion waits for the selected model, rather than only router
  startup. It is not a successful-inference claim.
- **Test model** is a separate, user-triggered action that sends a request and
  may load the model; it is not part of saving or loading. **Connect a
  client** opens the local gateway connection details.

## Model settings

Select a member to edit its context, concurrency, cache, GPU placement, and client
capabilities. Switching members keeps unsaved changes in the open editor. Context
and memory estimates are guidance, not guarantees that a workload will fit.
CPU/RAM offload can reduce GPU requirements at the cost of performance.

Changing engines can reset engine-specific settings; review the confirmation
before continuing. Uncommon runtime options and environment overrides are
available in Advanced settings. Only use options supported by the selected engine.

## Chat template override

In the deployment wizard and the member editor, the **Chat template** setting
defaults to **Inherit model default** (engine default if the model default is
Automatic). Choose a specific template to override it for that deployment only;
the model default and every other deployment are untouched. The **Effective:**
line shows what will actually run, and notes "not available" if the chosen file
is missing or failed to download.

## Loading policy

Pinned models remain loaded until explicitly stopped or a failure occurs.
On-demand models load when a client requests them. Allowing eviction permits an
eligible deployment to unload to make room for other work. Memory accounting is
advisory for manual and on-demand loading; there is no uncertainty permission or
capacity acknowledgment. Manual launch review asks for consent to proposed unloads.

## Saving and leaving

Model configuration can be saved while running; the old configuration and API ID
remain active until reviewed application. Shared infrastructure controls still
require unloading the group. Invalid input prevents saving; a failed save leaves
the draft open. A stale revision offers **Review changes** without dropping edits.

Queued application waits up to 30 seconds for current requests. New requests for
that runtime wait within their request queue timeout; other runtimes keep serving.
Timeout, cancellation, changed consent, or startup failure retain pending edits.
Startup failure attempts to restore the prior runtime configuration and reports
the restoration outcome. After a daemon restart, interrupted operations require
fresh review; they are not silently replayed or reported as applied.

Editors warn before discarding changes. Drafts do not survive a page reload.
The setup wizard retains its draft during explicit engine and acquisition detours;
other editor navigation still requires saving or discarding unsaved edits.

Paths entered with **Add from File** refer to files on the Menagerie host,
not files uploaded from the browser's device. See [operations](operations.md)
and [multi-model deployments](multi-model-deployments.md).
