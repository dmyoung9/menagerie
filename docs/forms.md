# Editing deployments

Use **New deployment** to configure one or more installed models. Give the
deployment a name, add models, select their engines, and choose a loading policy.
Creating a deployment saves its configuration; it does not load models unless
you subsequently request loading.

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
eligible deployment to unload to make room for other work. On-demand loading with
uncertain estimates requires its separate permission; manual launch review shows
warnings and asks for consent to proposed unloads.

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
