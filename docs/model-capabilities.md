# Model capabilities and reasoning options

Installed and downloadable models share cards and metadata chips. Installed
variants are grouped only when they share a known supplier repository. Use
**Details** to choose an installed variant, inspect its dependencies and deployments,
or **Refresh capability metadata** to inspect an older registration without moving
or redownloading its weights. Refresh is a visible Activity job and does not change
deployment declarations.

## Discovery is evidence, not serving certification

Hugging Face inspection reads bounded configuration and chat-template files from
the selected, pinned commit. Local GGUF and safetensors inspection reads their
configuration/templates. These can identify modality configurations, tool-template
variables, reasoning markers, and `enable_thinking`. Missing metadata means
unknown, not an assertion that a feature is unsupported. Tags and descriptions in
search results remain weaker hints.

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
matches the engine: **`--chat-template-file`** for llama.cpp and Prism,
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

Under **Modalities & capabilities**, enable the Reasoning declaration to show
the separate **Variants** card. This declares support and enables your configured levels; it
does not force the model to think or stop thinking. Turning it off hides and
deactivates the modes without deleting them. Input/output modalities remain separate.

Use each row's **Enabled** switch to select variants exposed to clients. Common
choices are **Instant, Low, Medium, High, XHigh, Max and Ultra**. A variant stays
unavailable until its request control is configured; merely opening the editor
does not save presets or change model behavior. Existing saved presets retain
their IDs, order, settings and exposure choices, including custom settings on a
mode named Default.

New configurations start with Low, Medium and High enabled using request-field
effort. XHigh, Max and Ultra use their matching effort values but start disabled;
Instant starts disabled and unconfigured. These defaults do not certify runtime
support. Existing configurations are not reset or automatically enabled.

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

Do not assume these fields are interchangeable or supported by every engine.
Request-field effort and chat-template effort may be different bindings. The two
budget names are runtime-specific request keys, not a universal distinction
between reasoning and thinking. Budgets are separate
from the maximum output-token limit and from an engine's startup reasoning budget.
Zero tokens, hidden reasoning output and a mode named "Off" do not necessarily
disable thinking. Confirm the engine/template binding before exposing a level.
Selecting **Not configured** removes that level's body mapping, not its saved
prompt prefix; clear both to remove all effects. Nothing is executed to discover levels.

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
