# Form interaction audit

## Implemented

- Deployment creation uses one composer for one or more models; existing standalone records retain their API and identity.
- Multi-model editing shows one member at a time without losing other members' drafts. Saves remain atomic.
- Large editors use a full-screen workspace, flat fieldsets, and persistent actions. Native dialog focus management is retained.
- Runtime settings are grouped by purpose and shared between editor surfaces. Context has useful slider stops and exact entry; thread ranges use available CPU affinity; Flash Attention uses independent radio groups; GPU layers distinguish default, all, and custom counts.
- Placement uses detected GPU names and automatic/custom memory reservation. Idle durations use named presets or custom seconds.
- Duplicate API IDs are identified inline. Model removal consequences appear at removal rather than under every model.
- Forms warn before discarding changes. Multi-model drafts survive switching selected members. Engine changes explicitly confirm resetting engine-specific settings.
- Host policy separates capacity/request settings from telemetry/retention and displays memory in GiB without changing stored MiB.
- Source builds offer only supported engines and use a URL input. **+ Add from File** identifies paths as belonging to the Menagerie host.
- Client capabilities expose tool support, image input, and output limits without requiring JSON; expert JSON remains available.

## Reviewed, retained

- Catalog variant selection already provides constrained choices, a summary, and a bounded confirmation flow.
- Launch review keeps capacity uncertainty and proposed unloads at the point of consent.
- Recovery, backup, and telemetry deletion retain short consequence-focused dialogs.

## Remaining refinements

- Editors are full-screen dialog workspaces, not independently routed editor pages. Section navigation currently uses disclosures rather than desktop sidebar/mobile drill-down navigation.
- Drafts are not resumable after leaving an editor to configure a prerequisite engine, or after reloading. Unload/discard warnings prevent accidental loss but do not provide persistence.
- Existing standalone editing shares setting controls but retains its own composition; adding another model to an existing standalone record is not implemented here.
- GPU layer counts have no invented upper bound when model layer metadata is unavailable. Context slider bounds reflect engine support, not guaranteed memory capacity.
- Engine environment overrides and uncommon capabilities remain expert JSON controls.

## Verification

- `npm run build` in `frontend/`.
- `python -m pytest tests -q`: 52 passing tests.
- `smoke_forms.js`: isolated, fully mocked mobile/desktop form checks.
- `smoke_multi_configuration.js`: independent members, atomic writes, reusable weights, and mobile layout.
- `smoke_product.js`: navigation, single-model creation/retry, direct editing, invalid JSON, consent, five mobile views, and disconnection.
- Actual telemetry sampling exposes the available CPU count. The running backend needs a restart before live clients receive the new metadata; no restart or inference operation was performed for this audit.

Real mobile keyboard behavior and a real GPU launch were not tested in this pass.
