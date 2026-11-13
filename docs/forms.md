# Editing deployments

Deployments are created and edited with the same data and naming semantics.
From the Deployments page, **New deployment** opens the creation choices:
**Single model** opens the **Set up model** wizard for one installed model;
**Multiple models** opens the shared deployment set editor. **Create
deployment** on an installed model card opens the same wizard directly, with
that model preselected. Creating a deployment saves its configuration; it
does not load models until you choose a loading action.

## Creating a single model

The **Set up model** wizard runs three steps — **Choose model**, **Review
setup**, and **Make available**.

- **Choose model** selects installed weights and their engine. When no
  compatible engine is installed, **Choose engine** opens the engines page;
  when the wizard is reopened, the chosen model is preselected (**Create
  deployment** carries the specific model; **New deployment → Single model**
  starts from the first installed model), while the other fields start from
  defaults.
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
- A change that cannot apply immediately is queued instead of applied on save.
  The completion screen then offers **Apply when idle** and **Cancel**; a
  queued change is never applied merely because Save succeeded.
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

Unload a deployment before changing its configuration. Invalid input prevents
saving; a failed save leaves the draft open for correction. A stale revision
requires refreshing before saving again.

Editors warn before discarding changes, but drafts do not survive a page reload
or leaving the editor to install a prerequisite engine. Save or deliberately
discard your draft before navigating away.

Paths entered with **Add from File** refer to files on the Menagerie host,
not files uploaded from the browser's device. See [operations](operations.md)
and [multi-model deployments](multi-model-deployments.md).
