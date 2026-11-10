# Model capabilities and reasoning options

Installed and downloadable models share cards and metadata chips. Installed
variants are grouped only when they share a known supplier repository. Use
**Details** to choose an installed variant, inspect its dependencies and deployments,
or **Refresh capability metadata** to inspect an older registration without moving
or redownloading its weights. Refresh is a visible Activity job and does not change
deployment declarations.

In deployment Configuration, detected statuses and **Capability evidence** separate
model findings from effective deployment findings. Advanced client declarations
change discovery/exposure metadata, not the engine's abilities. Variants and manual
template configuration remain available regardless of detection status.

## Discovery is evidence, not serving certification

Hugging Face inspection reads bounded configuration and chat-template files from
the selected, pinned commit. Local GGUF and safetensors inspection reads their
configuration/templates. These can identify modality configurations, tool-template
variables, reasoning markers, and `enable_thinking`. Missing metadata means
unknown, not an assertion that a feature is unsupported. Tags and descriptions in
search results remain weaker hints.

Structured findings distinguish **supported**, **unsupported**, and **unknown**
and retain source/confidence evidence. A reasoning marker alone does not establish
a toggle, effort levels, a budget, or separate reasoning output. Template controls
identify mechanisms, not successful inference. Conflicting collected findings are
retained rather than silently choosing one source.

Published `generation_config.json` sampling recommendations are collected during
explicit metadata inspection. They are advice, not engine defaults, and are never
automatically saved. Compatibility is checked against the selected runtime schema
before they can be offered for application. Free-form model-card prose is not yet
parsed into recommendations.

### Contributor reference: capability preview

`POST /api/capabilities/preview` accepts `configuration` (the existing profile
shape) and an optional `template_override`. It returns separate `model` and
`effective` finding maps, warnings, and schema-checked recommendations. It neither
executes an engine nor changes registry records. A llama.cpp image-capable model
without a configured projector/advertised projector flag has unavailable effective
image input; a configured projector remains unverified until runtime evidence or
inference acceptance establishes compatibility. Client declarations are retained
as user evidence, not used to certify serving support. Other runtime families do
not inherit llama.cpp's projector requirements.

An optional `deployment_id` permits current-session operational observations only
when artifact, runtime, requested options, raw arguments and template override still
match the saved deployment. A changed draft or a previous-session observation cannot
certify the new configuration. Observed modality booleans are whitelisted from
runtime properties; they do not advance configuration revisions.

GGUF `mmproj` files are shown as companion **candidates**, never automatically
paired. Select a compatible projector explicitly during download. It is pinned to
the same repository commit, checksummed, and compared to an upstream digest when
available. Deployment settings offer **Use downloaded projector** when the engine
advertises `--mmproj`; you must separately declare image input. The file's presence
does not establish model/engine compatibility. Other dependency relationships and
cross-repository projector resolution are not inferred.

## Chat templates

A chat template is the file that tells an engine how to format a conversation
before inference. Menagerie applies the chosen template with the flag that
matches the adapter: **`--chat-template-file`** for llama.cpp-compatible builds,
**`--chat-template`** for vLLM. Models registered before this feature, or any
selection that was never set, default to **Automatic (engine default)**, which
means no template file.

The available sources, each tagged in the UI:

- **Embedded** — the template inside the artifact (GGUF
  `tokenizer.chat_template`; safetensors `tokenizer_config.json`).
- **Published** — a template file in the pinned Hugging Face commit (a root
  `chat_template.jinja` or a file under a `chat_templates/` directory).
- **Custom** — a template you author and edit yourself.
- **Automatic** — no template file; the engine formats prompts itself.

Open the model's **Details** panel and use the **Chat templates** section to:

- set the **Model default** — Automatic or any discovered template; this is what
  deployments inherit when they do not override it;
- click **Refresh templates** to re-read and download the pinned commit's template
  files plus the artifact's embedded metadata. This is an Activity job that does
  not move or redownload weights and never overwrites a custom template or an
  existing selection;
- review the list, tagged by source and status;
- create, edit, or remove a **Custom template** via **New custom template**.

A deployment's **Chat template** setting defaults to **Inherit model default**
and may be changed to any template for that deployment alone. Precedence is the
deployment override, then the model default, then the engine default; there is
no silent fallback. The **Effective:** line beneath the selector names the source
and template file actually in effect, and notes "not available" if that file is
missing or failed to download. A profile that still sets a manual
`--chat-template-file` or `--chat-template` flag is rejected at save time rather
than silently shadowing the selection.

## Configure deployment-owned reasoning modes

The **Reasoning** declaration under **Modalities & capabilities** describes model
support; it does not force thinking on or off. The separate **Variants** card is
always available. Its settings, exposure and default selection work independently
of that declaration, including when Reasoning is disabled.

Use each row's **Enabled** switch to select variants exposed to clients.
Legacy **Default** entries remain editable but have no enablement switch: the
client's built-in Default/no-variant choice is not controlled by that row.
Common choices, in default order, are **Instant, Low, Medium, High, XHigh and Max**.
Merely opening the editor
does not save presets or change model behavior. Existing saved presets retain
their IDs, order, settings and exposure choices, including custom settings on a
mode named Default.

New configurations start with Low, Medium and High enabled using request-field
effort. XHigh and Max use their matching effort values but start disabled.
Instant starts disabled with `chat_template_kwargs.enable_thinking: false`.
These defaults do not certify runtime support. Existing configurations are not
reset or automatically enabled, and a saved Ultra variant remains a custom entry.
Previously blank common entries receive the sensible default in the editor,
without rewriting stored settings until a variant change is applied.

Click a variant's name or choose **Edit** from its actions menu to open the editor
Drawer. **Add variant** uses the same form and asks only for a name; Menagerie
generates a unique, stable client ID. Renaming does not change that ID. Each compact
row keeps its enablement switch and overflow menu together. Use **Move up / Move down**
in the menu to reorder variants, with the same actions available by keyboard.
The saved order is used for advertised variants;
clients may apply their own display order. Remove custom variants through their
actions menu.

The editor offers:

- **Effort:** a named value sent through the **Request field** (`reasoning_effort`)
  or **Chat template** (`chat_template_kwargs.reasoning_effort`).
- **Thinking toggle:** On or Off via `chat_template_kwargs.enable_thinking`.
- **Token budget:** a token count sent through `reasoning_budget` or
  `thinking_budget`, or `-1` for
  unlimited **only when the engine supports that field and sentinel**.
- **Custom:** combinations of these controls and additional bounded template
  arguments through **Request JSON**. Reserved conversation/tool/template-structure
  arguments cannot be replaced.

**Prompt prefix** and **Request JSON** are available with every control. The JSON
is the complete override object, synchronized with the guided fields, not an
additional override layer. A prompt prefix can also be used on its own. Invalid
JSON blocks applying changes; Cancel, Escape and outside dismissal protect
unapplied edits. **Apply changes** updates the builder draft; use the builder's
**Save** action to persist it.
New custom variants start with request-field effort `medium`. A variant cannot
be added or cleared to an empty request object without a nonblank prompt prefix;
legacy empty Default entries remain supported for client compatibility.

Do not assume these fields are interchangeable or supported by every engine.
Request-field effort and chat-template effort may be different bindings. The two
budget names are runtime-specific request keys, not a universal distinction
between reasoning and thinking. Budgets are separate
from the maximum output-token limit and from an engine's startup reasoning budget.
Zero tokens, hidden reasoning output and a mode named "Off" do not necessarily
disable thinking. Confirm the engine/template binding before exposing a level.
Nothing is executed to discover levels.

### Defaults and request precedence

- **Model default (no overrides)** leaves request reasoning controls unchanged.
  This can still mean the model thinks by default.
- Choosing a named **Default variant** applies it to requests without a
  selected mode. Explicit caller fields win over these default fields; template
  arguments merge by key. A default mode need not be exposed as a client choice.
- Explicitly selecting an exposed mode overrides only its mapped fields, preserving
  unrelated request fields and template arguments. It replaces, rather than stacks
  with, the deployment's default mode.

A prompt prefix is prepended to the **latest user message**, preserving image and
other content parts, prior messages, system instructions and tool messages. It is
request-local, not a persistent edit to the saved conversation. Existing tags in
chat history still follow the model template's own precedence rules; switching may
require a new chat. Returning to Model default does not erase past tags.

## Client exposure

Only enabled variants in the **Variants** list are emitted as catalog variants in `/v1/models`,
the OpenCode configuration export, and the existing OpenCode discovery plugin.
Their gateway selectors survive the plugin's SDK validation. Clients may display
the stable ID rather than the editable name. The metadata
does not ask clients to synthesize additional reasoning levels.

OpenCode/OpenChamber already provide a built-in Default (no variant). The plugin
maps a legacy empty Default preset to that choice, avoiding a duplicate.
Those clients retain their built-in Default even when the explicit Default preset
is not exposed in Menagerie; exposure cannot remove a client-owned base option.
That no-variant choice uses the deployment's configured default. When a named
deployment default exists, an additional `model-default` variant bypasses it.

Clients without a variant picker may send a selector to the chat endpoint:

```json
{
  "model": "my-model",
  "menagerie_variant": "high",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

The example requires a configured, exposed `high` level. Use
`"menagerie_variant": "model-default"` to bypass deployment-default overrides.
The gateway validates mode selection and required prompt content before loading
a model, removes the selector, and applies the selected mode before forwarding.
Unknown or unexposed selectors return HTTP 400.

Exposure is not access control: callers may still send native reasoning settings
directly. With no selected mode, deployment defaults fill only missing fields.
Runtime-specific reasoning behavior still needs a live serving check; metadata
inspection alone cannot prove that an engine honors a setting.
