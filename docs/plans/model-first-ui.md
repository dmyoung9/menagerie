# Model-first UI: design and implementation plan

Status: product decisions resolved with the owner; implementation and technical
validation remain pending. No product changes implemented.

Date: 2026-11-11. Baseline: Menagerie 3.0.0, commit `6182e7e45`.
Working branch: `feat/model-first-ui`.

This is a contributor design document, not documentation of currently supported
behavior. Copy below is the proposed UI copy contract. Conditional copy must not
ship before its underlying behavior exists.

## 1. Motivation and outcome

The primary task is **set up a model and use it**. Users should not have to learn
pool architecture, reconstruct a filename from quantization chips, manage several
names for the same configuration, or tune unfamiliar engine flags first.

The current friction reported by the owner is:

- Hierarchical chips make quantizations hard to compare. Detection can exclude
  companions without offering another way to select them.
- Choosing files requires consulting the upstream README in another browser tab.
- Installed models do not provide a direct path back to available downloads;
  deployments do not provide a sufficient direct path to their model.
- Companions cannot conveniently be downloaded independently after the weights.
- Deployment creation presents configuration before establishing a useful sequence
  of decisions. Single/multi-model distinctions expose implementation structure.
- Names and API identifiers diverge after edits.
- Settings expose values without communicating their practical consequences.
- Navigation/saving feel slow, progress feedback is inconsistent, notifications
  overlap, and configuration layout/focus shifts make interaction unpredictable.

Success: a new user can browse a model card, select downloads, configure installed
weights with sensible engine-led behavior, and obtain a usable API identifier.
Adding the twentieth model follows the same mental model as adding the first.
Experienced users retain explicit overrides and advanced deployment controls.

## 2. Decisions and boundaries

### Agreed product direction

1. Replace the chip-led picker with a repository page containing the rendered
   README and a sortable/filterable inventory of **all** repository files.
2. Offer file checkboxes and expandable bundles. Detection supplies hints and
   grouping; unknown classification must not hide a file.
3. Download companions independently. Files from the same repository belong to
   a coherent inventory, with revision identity and upstream paths preserved.
4. Make configured models the primary entries on Deployments. Pool assignment,
   priority, pinning, and other lifecycle machinery are advanced concerns.
5. Prefer automatic compatible pooling, with appropriate supervised execution
   for configurations that cannot use a native pool. Do not force a universal pool.
6. Start creation from installed models. An empty library invites discovery or
   import, preserving the intent to continue setup after acquisition.
7. Use one editable name consistently. Automatically generated API identifiers
   follow that name rather than retaining an obsolete generated value.
8. Explain meaningful tradeoffs at the point of decision, without covering every
   input in prose. Preserve engine-led defaults and progressive disclosure.
9. Refresh automatically, preserve drafts/focus/scroll, and give each operation
   one coherent feedback lifecycle.

### Resolved interaction decisions

- Use Stepperize's headless React API with the existing TanStack Form and Base UI
  components. Verify API compatibility before integrating; do not adopt unrelated styling.
- Use a full-width file table with a toggleable model-card Drawer: a side panel on
  desktop and a bottom panel on mobile. Preserve file selection and reading position.
- Model bundles have one checkbox on their main row. Expanded constituent files are
  inspectable, not independently selectable. Selecting the bundle selects its required set.
- Support common safe model-card HTML, including collapsible sections and images,
  through an explicitly sanitized subset alongside Markdown.
- New on-demand setups load on request, allow switching by unloading eligible idle
  models to make room, and unload after five idle minutes where supported. State this
  policy in review. Preserve existing configurations' policies.
- Save shared-runtime changes as pending desired configuration, separate from applied
  configuration. Saving does not restart the runtime. Explicit Apply when idle queues a
  reviewed operation that drains active requests and briefly holds new ones during restart.
- Rename generated API identifiers outright: show old/new IDs and the client-impact
  confirmation. Do not retain compatibility aliases.
- Existing configurations retain their present IDs initially, in generated mode. Their
  next name change generates a new slug. Switching to custom initially retains the current
  ID; custom mode then holds the identifier stable across renames.
- Suggest the model name only. Show quantization separately and use a readable suffix
  where multiple configurations would otherwise share the same name.
- Show context capacity directly in Review setup, initially Engine default, with the
  memory tradeoff. Detailed tuning remains advanced.
- The primary final action is Make available and load, using required launch review.
  Save without loading is secondary. Successful completion requires the selected model
  to be loaded, not just the router started; sending a test prompt remains explicit.
- Editing uses stacked sections with prominent sticky section headers and constituent
  cards following each header. Show impact in a sidebar on wide screens and below the
  form on small screens.

### Technical validation still required

Determine executable-specific live-update support, compatible default-pool assignment,
and safe queued-apply admission/rollback behavior. Validate Stepperize integration and
TanStack Markdown syntax/HTML coverage. These are engineering investigations, not open
product preferences. Escalate a concrete incompatibility before changing these decisions.

### README renderer references

Use the [shadcn.io Markdown guide](https://www.shadcn.io/ui/markdown) and
[TanStack Markdown](https://tanstack.com/markdown) as the implementation references.
The shadcn.io guide is an independent composition reference, not an official
shadcn/ui Markdown component to install. Its Prose, code-block, and element-mapping
patterns should be adapted to Menagerie's existing Base UI components and tokens.

- Evaluate `@tanstack/markdown/parser` and `@tanstack/markdown/react` as the preferred
  parser/rendering approach. Parse/cache by repository, resolved revision, and README
  content so unrelated polling does not reparse or remount the article.
- Use the article composition for this non-streaming content; do not bring in chat
  streaming behavior. Handle Hugging Face frontmatter separately from visible prose.
- Map links, images, headings, tables, and fenced code to owned components. Resolve
  revision-relative links/assets and handle in-page heading anchors without colliding
  with Menagerie's hash-based routing. Preserve reading position and text selection.
- Treat upstream READMEs as untrusted even though the guide's article example assumes
  trusted content. Support the approved common HTML subset through explicit sanitization;
  escape unsupported HTML. TanStack Markdown is not a general HTML sanitizer. Do not
  enable its unrestricted raw-HTML rendering as a shortcut.
  Preserve safe URL handling after custom link/image resolution.
- Verify syntax coverage against representative synthetic model cards before committing
  to the renderer. The referenced guide documents gaps including setext headings,
  indented code blocks, and bare-URL autolinking; do not claim full CommonMark/GFM
  support. Validate how to handle these and the approved model-card HTML subset explicitly.
  Keep the upstream link available for content the embedded renderer cannot reproduce.
- Syntax highlighting is a separate choice; unknown languages must remain readable
  plain code. No dependencies or registry components are installed during planning.

### Scope limits and invariants

- No new model families or inference protocols are required by this work.
- Preserve existing 3.0.0 configurations, aliases, policies, history, and explicit
  tuning. Do not silently move existing configurations into new pools.
- Initialize existing identifiers in generated mode by the owner's explicit decision,
  without rewriting their current values. Do not infer mode from string similarity.
- Keep omitted settings, explicit automatic sentinels, concrete overrides, and
  observed runtime values distinct. A friendly default label must not insert flags.
- Manager owns lifecycle and locking; each instance has exactly one lifecycle owner.
  Changes to current unloaded-unit requirements require an explicit backend contract,
  not a UI workaround that edits registry rows behind Manager.
- Preserve optimistic revisions, request security, launch validation tokens, unload
  consent, measured pressure/temperature protection, and private gateway boundaries.
- Estimates remain advisory. Unknown fit is not a launch prohibition or proof of fit.
- Do not silently install an engine, download weights, run a test prompt, or load
  a model merely because a user visits a page.

## 3. Baseline and investigation map

The baseline must be the committed 3.0.0 source. Earlier discussion included older
working files; do not treat earlier layout/root-cause hypotheses as verified bugs.

| Area | Existing sources | Consequence for implementation |
| --- | --- | --- |
| Catalog selection | `frontend/src/ModelCatalog.tsx`, `VariantDialog.tsx`, `variants.ts` | Replace hierarchical selection; reuse shard knowledge without filtering the inventory |
| Acquisition | `controlplane/jobs.py`, catalog/download routes in `controlplane/api.py` | Current request selects one primary file/snapshot plus optional projector; introduce file selection and independent acquisition |
| Storage | `hf_hub_download` / `snapshot_download` in `jobs.py` | Existing shared HF cache already separates repository snapshots; avoid an unnecessary file migration |
| Model details | `frontend/src/Views.tsx`, `components/installed-variants.tsx` | Convert disconnected dialogs into linkable repository/installed-artifact destinations |
| Creation | `App.tsx`, `DeploymentWizard.tsx`, `ServingDeployments.tsx` | Reconcile existing paths into one creation flow; do not keep divergent draft/submit logic |
| Pool lifecycle | `controlplane/runtime_pool.py`, `runtime_protocol.py`, `manager.py`, `deployment_sets.py` | Native pool shares runtime/device visibility and on-demand policy; current edits/stops affect the entire unit |
| Configuration | `Editors.tsx`, `FormControls.tsx`, `CapabilityIntelligence.tsx`, `style.css` | Audit the actual 3.0.0 editor, its disclosures, focus targets, and reflow |
| Refresh and feedback | `App.tsx`, `hooks/use-resource-preview.ts`, operation/download components | Trace polling, event invalidation, mutation completion, rendering, and notification ownership |
| Naming/catalog | `schema.py`, `catalog.py`, `store.py`, gateway routing and OpenCode plugin | Name/alias changes must remain consistent across persistence, routing, history, and discovery |

Current native pools require one native router-capable runtime installation, shared
device visibility, on-demand policy, and named options rather than raw arguments.
Pinned/atomic workloads and other protocols still need supervised execution.
Standalone supported engines already have native idle sleep; pooling adds runtime-led
independent loading/routing and pool-local eviction, not the first form of switching.

## 4. Information architecture and behavior

### Repository and file inventory

- One addressable repository destination, reachable from discovery, installed weights,
  and deployment details. A deployment link selects its exact installed artifact and
  source revision; opening newer upstream content is explicit.
- Show repository identity, revision, upstream link, README, and all files. Read the
  README for the selected resolved revision. README failure does not block file access.
- Support GFM tables, code, images, and relative links. Render untrusted Markdown with
  sanitized supported HTML, no script execution, and safe URL schemes. Resolve relative
  assets against the pinned upstream location. Do not execute README commands.
- Default inventory shows all files. Filter by filename, type, quantization, and local
  status; sort by name and size, and supported metadata columns. Do not present lexical
  quantization sorting as a universal quality ordering.
- Keep selection keyed by repository, resolved revision, and path. Preserve it across
  sort/filter/view changes. Clearly count selected rows hidden by filters. Changing
  revisions reconciles explicitly; never silently applies old selections to new bytes.
- Group complete split GGUFs and identified Safetensors bundles into expandable rows.
  Bundle selection includes required shards/index/config/tokenizer assets. A repository
  can contain more than one bundle; never assume every Safetensors file belongs together.
- Only the main bundle row has a checkbox; its expanded files show the included set.
  Individual ungrouped files remain selectable. Interrupted/previous partial downloads
  show missing files and retry the required set; they are not ready-to-deploy artifacts.
  Incomplete upstream groups explain what is missing and cannot be selected as a usable
  bundle. Do not conceal the available files. Download completion and deployability are
  separate states.
- All-file access includes unclassified companions and non-weight assets. Role hints
  are overridable when configuring a companion; runtime errors remain authoritative.
- Header selection selects visible filtered rows, with indeterminate state and explicit
  scope. Never let a hidden selection become a surprise whole-repository download.
- Show missing-byte total separately from already present files. Unknown sizes remain
  unknown; perform server-side transfer/disk checks without inventing a numeric total.

### Independent downloads and installed inventory

- Introduce a download selection/manifest contract with resolved revision, paths,
  group membership, checksums where provided, and per-file acquisition status.
- Separate acquired file records from deployable artifact records and deployment
  configuration. A projector is reusable inventory, not a nested artifact owned by one
  primary download. Acquisition does not automatically enable it in a running model.
- Preserve upstream subdirectories and revision snapshots. Reuse valid existing cache
  content, verify checksums, and serialize/deduplicate overlapping downloads safely.
- A batch reports partial success and supports retrying failed/missing files without
  retransferring completed weights. Registration failure is distinct from transfer failure.
- When a companion is acquired, offer return to the originating model configuration.
  Same-repository origin is a pairing hint, not a compatibility guarantee.

### Configured models and pool ownership

- Deployments lists model-serving configurations: name, API identifier, linked weights,
  availability, residency, and actions. Reusing weights with another configuration
  produces another model entry without copying files.
- Keep availability separate from residency: available on demand, disabled, loading,
  loaded, unloaded, and failed are not interchangeable states.
- Assign new compatible configurations to an eligible default pool deterministically.
  Compatibility includes runtime installation/build, device visibility/environment,
  supported protocol, policy, and configuration constraints. Never silently change a
  user's requested engine or settings to fit a pool.
- Multiple compatible/incompatible pools are infrastructure; expose details and explicit
  assignment under Advanced. Existing supervised groups keep their atomic semantics.
- New default setups permit unloading eligible idle models to make room and use a
  five-minute idle timeout where supported. Display this policy in the final review;
  submitting the reviewed setup accepts it. Retain explicit choices, existing policies,
  and separate launch-review consent for proposed unloads.
- Disabling one model should remove that model's client availability without disabling
  neighbors. Current whole-unit behavior needs backend work before this action is shown.
- Model unload, pool stop, and client disable are separate actions. If the runtime cannot
  perform a requested member action independently, explain its actual scope; do not label
  a whole-pool stop as a per-model unload.
- Before default-pool rollout, prove the edit/add/remove strategy. Prefer safe independent
  updates where supported; otherwise persist desired changes as pending without replacing
  the applied runtime snapshot. Show affected models and offer Apply when idle or a restart
  review. Do not stop active neighbors as an incidental effect of saving.
- Apply when idle is an explicitly requested, reviewed operation, not a side effect of
  Save. Drain active requests and hold new requests for the affected runtime during the
  coordinated transition, with bounded waiting, cancellation before application begins,
  visible progress, and failure recovery. Unaffected runtimes keep serving.
- Revalidate revisions and launch plans immediately before application. If the reviewed
  scope or unload consequences change, request a fresh review rather than using stale
  consent. Bound request holds and surface timeout/retry behavior; do not drop active work.
- Persist desired/applied revision identity and operation state. Recovery after daemon
  restart must reconcile interrupted application safely, not falsely report Applied.
  A failed application keeps the desired change available and reports rollback status.

### One name and generated identifiers

- One authoritative editable name drives cards, headings, review, and discovery display
  names. Installed repository/model names remain source metadata, not competing editable
  deployment names.
- Suggest the model name only; show quantization separately. Provide understandable suffixes
  for additional configurations; do not make users resolve invisible identifier collisions.
- Generated IDs use a deterministic API-valid slug and follow name changes. Specify
  normalization, non-Latin/empty-slug fallback, length limits, and collision suffixing in
  shared contract tests before implementation. Never use a random changing identifier.
- Persist identifier mode: generated or custom. Custom IDs remain unchanged on rename.
  Returning to generated mode previews the resulting ID before saving.
- Initialize existing configurations in generated mode while preserving the current ID
  until the name changes. Switching to custom seeds the field with the current ID.
- A generated rename is atomic with canonical routing/catalog updates. Show the old/new
  identifier and client-impact confirmation. Old identifiers stop routing after the change
  is applied; no compatibility aliases are created. Pending runtime changes must not make
  discovery advertise an ID the applied routing cannot yet serve.

### Creation and editing

- Three numbered decision steps: **Choose model**, **Review setup**, **Make available**.
  A completion screen is an outcome, not another configuration step.
- Entering from installed weights preselects the artifact. An empty library shows
  discovery/import actions and preserves return intent. Engine installation, if required,
  is another explicit detour with the draft retained.
- Review setup defaults to inherited engine behavior. Show relevant companions and
  context capacity directly, with Engine default selected and an optional Custom choice.
  Keep the short memory tradeoff visible. Sampling, variants, raw arguments, placement,
  pool assignment, priority, and pinning are advanced, not required milestones.
- Use one shared draft/schema with the editor. Back/Next preserve values, text buffers,
  validation, and explicit/omitted distinctions. Step transitions focus the new heading;
  errors focus the first invalid control, not a label.
- Make available presents suggested name, generated ID preview, and a short behavior
  summary. Primary action Make available and load saves/enables and proceeds through
  required launch review to load the selected model. It does not send an inference test.
  Offer Make available without loading and Save disabled as secondary choices.
- Completion distinguishes availability from measured successful inference. Provide copy
  actions and an optional test action. A failed launch does not destroy the saved setup.
- Subsequent editing uses stacked sections with prominent sticky section headers and
  constituent cards after each header, plus a consistent save bar. Do not use masonry
  packing. Keep advanced disclosures in place. On wide screens show an impact sidebar;
  on smaller screens place impact below the form. Only the current section header should
  occupy the sticky header position. Account for app chrome, focused controls, anchors,
  and validation messages so sticky elements do not obscure them.

## 5. Guidance and impact design

Use a plain-language control title, one short visible consequence when useful, and
optional details. Do not attach boilerplate explanations to every field. Essential
information cannot depend on hover, color, or icons alone.

- Context is capacity for conversation, instructions, tools, documents, and output.
  Do not promise a fixed number of messages from a token count.
- Larger quantizations are not automatically the best choice: they can leave less
  memory for context and affect speed. Do not rank all formats by guessed quality.
- Use numeric comparisons only with evidence. Distinguish file size, estimated memory,
  prior measured peaks, runtime predictions, and observed settings.
- If only direction is known, display a directional statement rather than a fake gauge.
  Unknown estimates do not get green fit badges or block saving/launch review.
- Preserve valid previous preview geometry while recalculating; label old values as
  updating, and never present the previous configuration's estimate as current.
- Do not duplicate pool process memory as measured usage for each member.

## 6. Exact copy contract

Braced tokens are runtime substitutions, not literal UI text. Implement singular/plural
forms, localized number formatting, and truncation with access to the full value.
Descriptions are visible only in the stated context; do not render this whole inventory
as a wall of help. Existing unrelated advanced settings keep their current copy until
specifically reviewed. New/changed flow copy is defined here.

### Navigation, repository, and downloads

| Surface | Label or exact text | Display condition |
| --- | --- | --- |
| Primary navigation | Models; Deployments | Retain familiar destinations |
| Discovery action | Explore model | Opens repository page |
| Model-card trigger | Model card | Opens side Drawer on desktop, bottom Drawer on mobile |
| Drawer title/action | Model card; Close model card | Restore focus to trigger on close; preserve reading position |
| Upstream link | View on Hugging Face | External link |
| Revision control | Revision | Show resolved commit in details |
| Model card loading | Loading model card… | Independent loading state |
| Missing README | This repository has no README at this revision. | Confirmed absence |
| README error | Could not load the model card. You can still browse and download files. | Fetch/render failure |
| Retry action | Try again | Local to failed section |
| File search | Filter files… | Accessible name: Filter repository files |
| Filters | File type; Quantization; Local status | All is the default option |
| Filter reset | Clear filters | Preserve selection |
| Table columns | File; Type; Quantization; Size; Local status | Selection/expansion columns have accessible names |
| Type values | Model weights; Projector candidate; Drafting head candidate; Configuration; Tokenizer; Documentation; Other | Unknown stays Other |
| Unclassified quantization | Unknown | Never hides the row |
| Quantization guidance | Smaller quantizations use less memory but may reduce accuracy. Larger ones leave less room for context and may run more slowly. | One compact expandable explanation by quantization comparison |
| Guidance action | How to choose | Opens comparison guidance; not a prerequisite |
| Group label | {name} · {count} files | Expandable bundle |
| Group accessible action | Show files in {name} / Hide files in {name} | Reflect expanded state |
| Row checkbox name | Select {filename} | Ungrouped files only; includes full path where needed |
| Bundle checkbox name | Select {name} and all required files | Only checkbox for the grouped set |
| Header checkbox name | Select all visible files | Filtered scope only |
| Bundle helper | Downloaded together as one model. | At expanded bundle header; child rows have no checkboxes |
| Partial bundle | Incomplete model bundle | Inventory status |
| Partial bundle description | Download the missing files before setting up this model. | Known required files missing locally |
| Upstream missing files | This bundle is missing required files in the selected revision. | Do not claim usable bundle |
| Local statuses | Not downloaded; Downloading; Downloaded; Failed | File acquisition states |
| Selection summary | {count} files selected · {size} to download | Known remaining bytes |
| Unknown-byte summary | {count} files selected · download size partly unknown | At least one missing size |
| Hidden selections | {count} selected files hidden by filters | Nonzero count only |
| Selection action | Clear selection | Clears all selected rows |
| Download action | Download selected | Enabled for missing selected files |
| Nothing missing | All selected files are already downloaded. | Verified locally |
| Revision change prompt | Change revision? | Selection contains files from another revision |
| Revision change description | Your file selection belongs to {oldRevision}. Changing revision clears the selection; downloaded files are kept. | Explicit transition |
| Revision actions | Keep revision; Change revision | No silent byte substitution |
| Download queued | Download queued: {repository} | One operation notification |
| Download progress | Downloading {completed} of {total} files | Same notification/job |
| Download success | Download complete: {repository} | All selected transfers verified |
| Partial failure | {completed} files downloaded; {failed} failed. | Preserve successful files |
| Download failure action | Retry failed files | Only failed/missing files |
| Operation link | View downloads | Available throughout job lifecycle |
| Setup continuation | Set up model | Only for deployable installed artifacts |
| Companion continuation | Return to setup | Return intent exists |
| Installed source action | Browse repository files | Opens same repo/revision inventory |
| Deployment source link | View model | Selects exact installed weights |

### Wizard, naming, and completion

| Surface | Label or exact text | Display condition |
| --- | --- | --- |
| Create action/title | Set up model | Entry from Deployments or installed model |
| Steps | 1. Choose model; 2. Review setup; 3. Make available | Stepper labels |
| Empty title | Add your first model | No installed deployable weights |
| Empty description | Download a model or add files you already have, then continue setup. | Preserve setup intent |
| Empty actions | Discover models; Add from file | Explicit detours |
| Model field | Model | Installed artifact picker |
| Missing engine title | An engine is needed for this model | No compatible installation |
| Missing engine description | Choose a compatible engine to continue. Your setup will be kept. | Do not imply automatic install |
| Engine action | Choose engine | Explicit install/select flow |
| Setup summary | Engine settings will be used unless you customize them. | Omitted defaults |
| Context control | Context capacity | Directly visible in Review setup, initially Engine default |
| Secondary disclosure | Advanced | Technical tuning/lifecycle settings |
| Navigation | Back; Continue | Preserve draft |
| Final-step name | Name | One editable display name |
| Name helper | Used throughout Menagerie and in connected clients. | Under name |
| Generated preview | API model ID | Read-only with copy action |
| Generated helper | Generated from the name and updated when you rename it. | Generated mode |
| Advanced ID action | Customize API model ID | Switch to explicit mode |
| Custom helper | This ID stays the same when you rename the model. | Custom mode |
| Restore action | Generate from name | Preview before save |
| Collision message | This API model ID is already in use. Choose another. | Explicit custom collision |
| Automatic collision helper | Using {identifier} because {baseIdentifier} is already in use. | Generated suffix preview |
| Empty-name error | Enter a name for this model. | Validation |
| Canonical rename summary | API model ID: {oldIdentifier} → {newIdentifier} | Generated rename preview |
| Rename warning | Clients using {oldIdentifier} will need to switch to {newIdentifier}. | Any generated ID change |
| Rename confirmation | Rename and update API model ID | Old identifier is not retained |
| Default policy summary | Loads when requested. Idle models can unload to make room. Unloads after 5 minutes without requests. | New default setup, where idle timeout is supported |
| On-demand review | Available to clients. Loads when requested and unloads after {idleDuration} without requests. | Policy supports this exact behavior |
| No-idle review | Available to clients. Loads when requested; idle unloading is off. | Idle timeout disabled |
| Default submit | Make available and load | Saves/enables, then follows required launch review; no inference test |
| Submit progress | Saving setup… | Prevent duplicate submission |
| Secondary submit | Make available without loading | Enables on-demand use without an immediate load |
| Alternative submit | Save disabled | Advanced/secondary action |
| Explicit launch action | Review and load | Existing launch validation/consent path |
| Loading progress | Loading {name}… | Selected model loading; not merely router startup |
| Primary completion title | {name} is loaded and available | Selected model confirmed loaded and routable |
| On-demand completion title | {name} is available | Without-loading path, saved and client-routable |
| On-demand completion description | Loads on the first request. | On-demand, not loaded |
| Pending completion | Setup saved. Changes are waiting to be applied. | Shared-runtime application not completed |
| Disabled completion | {name} is saved and disabled | Not advertised as available |
| Completion actions | Copy API model ID; Connect a client; Test model | Test is explicit |
| Test explanation | Sends a request and may load this model. | Beside test action |
| Verified test result | Test response received | Only after actual successful request |
| Launch failure | Setup saved, but the model could not load. | Preserve config and show actual error separately |
| Failure actions | View error; Edit setup; Try again | Retry must preserve launch-review semantics |

### Setting consequences and evidence

| Control/location | Label | Visible description or cue | Details text |
| --- | --- | --- | --- |
| Context override | Context capacity | More context → more memory | Context includes conversation history, instructions, tool results, documents, and generated output. Tokens are pieces of text, not a fixed number of messages. |
| Context default mode | Engine default | The engine chooses the value. | No override is saved. The value may differ between loads. |
| Explicit engine sentinel | Automatic | Uses this engine's automatic mode. | This is an explicit setting, not the same as leaving the option unset. |
| Concrete value mode | Custom | Set a context limit. | Show engine-correct unit and scope; do not imply per-request capacity when only a shared pool is known. |
| Context unit | tokens | Shared context pool / Per-request context | Use the applicable scope. For a known positive slot count: Shared pool: {poolTokens} tokens across {slots} slots. |
| Concurrency | Concurrent requests | More simultaneous requests → more resource demand | Serving more requests together can reduce speed per request. Context sharing depends on the engine. |
| Projector | Image input file | Adds image input when paired with a compatible model and engine. | Projectors use additional memory. A matching repository or filename does not confirm compatibility. |
| Projector empty option | None | No image input file selected. | Show only where image input is relevant. |
| Companion selection escape hatch | Choose another file | Browse downloaded files. | Classification does not restrict this file picker; validate path and runtime option requirements. |
| Draft companion | Drafting head | May speed up generation; uses additional memory. | Speed gains depend on the model, engine, and workload. |
| Companion acquisition link | Download companion files | — | Opens this repository and retains the setup draft. |
| Capability unknown | Not confirmed | You can configure this manually. | Detection is incomplete; this is not a claim that the feature is unsupported. |
| Impact section | Expected impact | — | Show only evidence relevant to the current decision. |
| Evidence badge | Measured previously | From an earlier run of this configuration. | Actual usage can change with workload and automatic engine settings. |
| Evidence badge | Estimated | Approximate memory use; actual use may differ. | Identify included/excluded components and source in expanded details. |
| Evidence badge | Direction only | Increasing this generally uses more memory. | No numeric estimate is available for this configuration. |
| Evidence absent | Estimate unavailable | You can still save this setup and review a launch. | Never replace this state with zero or a fit verdict. |
| Runtime values | Observed settings | Reported by the currently loaded session. | These values do not change your saved overrides. |
| Preview progress | Updating estimate… | Previous estimate shown. | Only show previous values explicitly marked as belonging to the prior configuration. |
| Override reset | Use engine default | Removes your override. | Reset removes the option rather than saving a guessed default or sentinel. |

Show context consequences at the control, quantization consequences at download
comparison, and companion consequences at companion choice. Do not repeat all of
them in the final review. Do not expose temperature/top-p/batching as mandatory steps.

### Advanced availability, editing, and feedback

| Surface | Exact text | Display condition |
| --- | --- | --- |
| Advanced pool field | Runtime pool | Infrastructure detail only |
| Assignment mode | Automatic assignment | Default for new eligible configurations |
| Assignment helper | Uses a compatible shared runtime when available. | Do not promise one global process |
| Explicit isolation option | Dedicated runtime | Compatible supervised execution path |
| Pool scope helper | These settings affect {count} models in this pool. | Shared controls |
| Priority field/help | Priority / Used when deciding which eligible models can make room. | Advanced; retain actual scheduler semantics |
| Pinning field/help | Keep loaded / Prevents automatic unloading to make room for other models. | Only where supported; may require dedicated execution |
| Eviction field/help | Allow unloading to make room / Idle models may be unloaded so another model can load. | Explicit reviewable policy; never silently granted |
| Idle setting | Unload when idle | Options use time units and Never |
| Shared restart title | Restart shared runtime? | Only when operation actually requires it |
| Shared restart description | Applying this change requires restarting the runtime used by these models. | List affected models and active-request handling separately |
| Shared restart actions | Keep editing; Review restart | Review is not silent approval to interrupt requests |
| Pending status | Changes pending | Desired configuration differs from applied configuration |
| Pending description | Your changes are saved. The runtime is still using the previous configuration. | Existing serving model |
| Pending actions | Apply when idle; Review restart; Discard pending changes | Distinct from discarding unsaved form edits |
| Queued-apply review | Apply changes when idle? | List affected models and proposed unload consequences |
| Queued-apply description | Current requests will finish first. New requests will wait briefly while the shared runtime restarts. | Only if a restart is required |
| Queued-apply confirmation | Apply when idle | Explicitly authorizes the reviewed queued operation |
| Waiting status | Waiting for active requests to finish… | Application queued |
| Cancellation | Cancel scheduled apply | Before application begins; saved changes remain pending |
| Applying status | Applying changes… | Transition in progress |
| Applied status | Changes applied | Desired revision confirmed active |
| Apply failure | Could not apply changes. Your saved changes are still pending. | Show actual error and rollback outcome separately |
| Waiting expired | Changes are still pending. Applying them timed out while waiting for active requests. | Bounded drain deadline exceeded |
| Review invalidated | The affected configuration changed. Review the update again before applying it. | Saved consent no longer matches current scope |
| Availability states | Available; Disabled | Separate column/label from residency |
| Residency states | Not loaded; Loading; Loaded; Unloading; Failed | Pool router readiness is not per-model loaded state |
| Model availability actions | Disable; Make available | Per-model scope only when backend supports it |
| Residency actions | Review and load; Unload model | Do not disguise a pool-wide stop |
| Explicit pool action | Stop pool | Advanced shared-infrastructure action |
| Editor status | Unsaved changes; Saving…; Saved | One inline status area |
| Save actions | Save changes; Discard changes | Stable action bar |
| Save failure | Could not save changes. Your edits are still here. | Include actionable error detail |
| Revision conflict | This configuration changed elsewhere. Your edits have been kept. | Never silently overwrite draft |
| Conflict action | Review changes | Reconcile before retrying write |
| Route loading | Loading {section}… | Local skeleton/status, not blank whole app |
| Connection recovery | Reconnecting… Updates will resume automatically. | Background retry underway |
| Section fetch failure | Could not update {section}. Retrying automatically. | Keep last good data, with age if useful |
| Optional retry | Retry now | Supplemental, not required to recover |
| Stale telemetry | Waiting for fresh hardware data… | Refreshing HTTP is not proof the sampler recovered |

## 7. Example user flows and expected outcomes

### A. First installation, no models

1. Deployments → Set up model → Add your first model.
2. Discover models → Explore model → open the Model card Drawer beside the file table
   on desktop, or as a bottom panel on mobile.
3. Compare quantizations by actual rows, select a model bundle and optional projector.
4. Download selected; one notification tracks progress. Navigate elsewhere safely.
5. Completion → Set up model; choose/install engine explicitly if necessary, then return.
6. Review the directly visible context control, accept engine defaults and suggested
   name → Make available and load → complete required launch review.
7. Wait for the selected model to load, then Copy API model ID / Connect a client.
   The secondary without-loading path instead shows Available and Not loaded until used.

### B. Add another quantization or unknown file

1. Existing deployment → View model → Browse repository files.
2. Filter/search/sort while selected rows stay selected and hidden selections are counted.
3. Select another quantization, including one labeled Unknown, and download it.
4. Create another configuration from those weights. Existing deployment is untouched;
   generated naming resolves collisions visibly. No single/multi-model conversion step.

### C. Return for a companion

1. Edit setup → Download companion files.
2. Select only the desired projector or drafting head, even if classified Other.
3. Download missing bytes only; preserve main weights and original revision.
4. Return to setup, select the acquired file, review scope, save. Acquisition alone did
   not enable image input or speculative decoding in a running configuration.

### D. Increase context without knowing engine flags

1. Review setup → the directly visible Context capacity control.
2. Read More context → more memory, select Custom, change the token value.
3. Expected impact updates in place with estimated/measured/directional evidence.
4. Unsupported or unknown estimates do not block saving. Invalid engine values do.
5. Use engine default removes the override; it does not save an observed value.

### E. Add a model to a busy installation

1. Set up another installed model with default assignment.
2. Backend selects a compatible pool, or a suitable separate runtime without discarding
   requested settings. It does not move existing models or stop serving neighbors.
3. If joining requires a restart, save desired changes as pending and present affected
   models for explicit review. Apply when idle queues the reviewed transition. Cancelling
   before application starts leaves pending changes saved and existing serving state intact.

### F. Rename and customize

1. Rename Example 8B to Writing Assistant; all display surfaces agree. Quantization
   remains separate source metadata.
2. Generated mode previews writing-assistant; custom mode keeps its existing ID.
3. Confirm that clients using the old ID must be updated. Application atomically updates
   canonical discovery/routing; the old ID stops working. If a runtime update is pending,
   distinguish the desired ID from the currently active ID until application completes.
4. Existing configurations initially retain their current ID in generated mode. Their
   next rename follows this same flow; selecting custom seeds the current ID unchanged.

### G. Network/save failure while editing

1. Change settings while background requests fail or arrive out of order.
2. Focus, text buffers, expanded sections, scroll, and draft remain intact.
3. Save failure leaves edits available; retry succeeds without duplicate submission.
4. Recovery updates data automatically; stale server revisions produce a reconciliation
   flow rather than wiping the draft. One failed resource does not freeze all other data.

## 8. Implementation stages

Each stage is a bounded implementation/review unit. This document authorizes planning
only; implementation starts on a subsequent instruction.

### Stage 0 — Reproduce and measure the 3.0.0 flows

- Read the current frontend design-system and data-display standards before changes.
- Build synthetic desktop/mobile scenarios for discovery, downloads, standalone edits,
  and native-pool edits. Trace network latency versus render/validation latency.
- Record action-to-feedback and action-to-settled-state timings with an injected slow API.
- Identify actual unwanted tab stops and layout shifts; inspect grid row sizing, mounted
  components, revision-key remounts, preview replacement, and focus effects.
- Inventory the existing Stepperize/form dependency fit and reusable components.
- Exit: reproducible interaction failures and measurements, no speculative root-cause fixes.

### Stage 1 — Backend contracts and consequential decisions

- Specify file manifests, acquired-file versus deployable-artifact identity, additive
  schema changes, partial failure/retry, and revision/path validation.
- Specify generated/custom ID ownership, deterministic slug/collision rules, generated-mode
  initialization for existing IDs, and client-impact confirmation without compatibility
  aliases. Audit gateway, discovery/plugin, CLI, history, and restoration.
- Specify eligible default pools, eviction consent, member availability, per-model actions,
  affected-model review, runtime restart/rollback, and compatibility with supervised groups.
- Define persisted desired/applied revisions, queued-apply states, cancellation boundaries,
  bounded request draining/holding, revision revalidation, and interrupted-apply recovery.
- Preserve existing configurations through additive/recoverable changes; no fresh-state
  requirement is implicit in this UX plan.
- Exit: contract tests designed around user outcomes and validated rename, pending-change,
  and pool-edit behavior. Do not ship default pooling behind cosmetic per-model actions.

### Stage 2 — Interaction/data-state foundation

- Decouple resource queries so a failing unrelated endpoint cannot discard successful data.
  Use targeted mutation results/invalidation, event-driven updates, polling fallback,
  deduplicated refreshes, and cancellation/sequence protection against stale responses.
- Distinguish HTTP connectivity, event-stream state, and stale hardware samples.
- Keep last good data while refreshing and local loading indicators on new destinations.
- Establish one operation notification keyed by job ID; remove redundant queued messages
  and competing floating overlays. Job completion refreshes affected inventory.
- Make save state follow mutation acknowledgment; reconcile revisions without unnecessary
  form remounts. Preserve numeric buffers and explicit/omitted semantics.
- Stabilize editor layout with stacked sections, sticky section headers, and constituent
  cards; place impact beside the form on wide screens and below on small screens. Stabilize
  preview dimensions, repair keyboard order, and retain disclosures.
- Exit: navigation and controls respond before slow requests finish; failures preserve drafts.

### Stage 3 — Repository page and independent acquisition

- Add addressable repository/model destinations and deep links from installed models and
  deployments. Retain back-navigation, selected revision, filters, and setup return intent.
- Fetch/render README separately from file inventory; implement pinned relative resources
  and safe rendering using the README renderer references above. Validate TanStack syntax
  coverage, frontmatter, hash-route-safe heading links, and raw-HTML handling. Test absent
  cards, long tables, code blocks, and malicious Markdown fixtures.
- Build the full-width all-files table and responsive model-card Drawer, grouping/selection
  with bundle-only checkboxes, sort/filter, local statuses, and download summary.
- Implement independent download API/jobs and inventory registration on the stage-1 contract.
- Retire chip selection as the authoritative navigation path after parity is verified.
- Exit: flows A acquisition, B, and C work without classification-dependent file exclusion.

### Stage 4 — Model-first lifecycle and naming

- Implement stage-1 pool/member contracts through Manager, preserving load review and policy.
- Introduce configured-model projections without destroying internal lifecycle ownership.
- Implement name/identifier-mode behavior and outright rename with client-impact confirmation.
- Implement desired/applied state and explicit queued application before enabling shared
  pool changes through the model-first UI.
- Keep advanced infrastructure management and explicit dedicated-runtime paths available.
- Exit: mixed runtimes, shared pools, reused weights, and legacy supervised groups retain
  correct actions, routing, availability, policy, accounting, and history.

### Stage 5 — Wizard, impact guidance, and connected completion

- Build the three decision steps using shared draft/schema controls and Stepperize.
- Default to inherited engine behavior, preselect supplied artifacts, and retain drafts
  across acquisition/engine detours. Do not serialize recommendations as defaults.
- Add scoped tradeoff guidance and evidence-aware impact presentation from this copy contract.
- Show context directly and add final policy review, primary Make available and load,
  secondary without-loading/save-disabled actions, and completion with connection details.
  Loading follows the launch-review contract; optional inference tests remain user-triggered.
- Ensure normal configuration editing reuses the same data semantics and name behavior.
- Exit: all example flows pass with desktop/mobile, keyboard, slow/failing network fixtures.

### Stage 6 — Consolidate, verify, and document shipped behavior

- Remove obsolete creation/selection paths only after replacement coverage demonstrates parity.
- Update user guides to shipped behavior and contributor contracts to actual architecture.
- Inspect changed source and artifacts for private data and scratch output. Keep fixture
  screenshots/traces in ignored test output. Packaging checks only when preparing artifacts.
- Report remaining runtime/hardware unknowns honestly. Do not claim model fit, quantization
  quality, image compatibility, native hot-edit support, or inference acceptance from mocks.

## 9. Verification and acceptance criteria

Use the repository check contract in `docs/development.md` and isolation rules in
`docs/testing.md`. No live inference, downloads, installed-client checks, or personal
state is needed for ordinary verification. No tests are required merely to add this plan.

### Behavioral coverage for implementation

- File selection: unknown quantizations/companions, multiple Safetensors bundles, complete
  and incomplete split GGUFs, directories, unknown sizes, duplicate paths across revisions,
  filtered hidden selections, bundle-only checkbox behavior, selection accessibility, and
  already-downloaded bytes. Expanded child rows must not become independently selectable.
- Acquisition: checksum failure, partial success, retry, concurrent overlapping jobs,
  interrupted transfers, independent companion acquisition, and registration failures.
- README: relative links/images, table overflow, empty/missing cards, fetch failures,
  unsafe URLs/HTML, revision changes, and selection preservation across views.
- Names: Unicode and empty-slug fallbacks, length bounds, generated collisions, explicit
  custom IDs, existing-ID initialization, old-ID retirement, rename confirmation, plugin catalog
  consistency, history, restoration, and existing-client behavior.
- Pools: incompatible builds/devices/policies, supervised fallbacks, existing assignments,
  per-model disable, in-flight requests, failed shared restart and rollback, stop scope,
  launch-token invalidation, and no duplicated aggregate memory attribution.
- Pending changes: save versus apply distinction, desired/applied catalog consistency,
  queued apply, drain/hold bounds, cancellation, concurrent revision conflicts, process
  restart recovery, and no unattended application merely because Save succeeded.
- Forms: omitted versus automatic versus explicit settings, blank numeric text, dependent
  validation, unknown capability evidence, Back/Next, dirty navigation guards, stale saves,
  preserved drafts after reconnect, and no inference triggered by merely completing setup.
- Feedback: immediate local busy state, no duplicate submissions/toasts, successful update
  without waiting for the next whole-app poll, out-of-order response protection, and graceful
  partial API failure. Test artificial delays rather than assuming local requests are fast.
- Accessibility/layout: Tab visits interactive controls in logical order, labels are not
  accidental stops, sort/group state is announced, dialogs restore focus, step changes are
  announced, and focus/scroll stay stable during typing, polling, and advanced expansion.

### Definition of done

1. A first-time user completes the ordinary setup without choosing a pool, inventing an
   API identifier, or tuning generation flags.
2. Any listed upstream file remains accessible regardless of classification.
3. Downloading a companion later neither requires selecting weights nor transfers valid
   installed weights again.
4. Names agree across all user-facing deployment surfaces; identifier behavior is explicit
   and tested for connected clients.
5. Shared-runtime actions accurately disclose scope and preserve consent; no hidden neighbor
   restart or policy change is introduced by the friendly workflow.
6. Essential setting tradeoffs are visible without hovering, and uncertainty is honestly labeled.
7. Saving, background refresh, and previews preserve user edits, keyboard focus, and scroll.
8. One operation produces one evolving progress experience, with a durable route to details.
9. Existing 3.0.0 stored configurations and advanced execution workflows remain usable.
10. Scoped backend/frontend/plugin checks pass as applicable; hardware claims remain limited
    to separately authorized and recorded evidence.
