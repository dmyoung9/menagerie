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

Under **Capabilities & reasoning**, enable the Reasoning declaration to show
**Reasoning modes**. This declares support and enables your configured modes; it
does not force the model to think or stop thinking. Turning it off hides and
deactivates the modes without deleting them. Input/output modalities remain separate.

Fresh configurations have no invented Instant or Low/Medium/High modes. **Add mode**
with a name and stable client ID. Names are editable; duplicate a mode to give a
copy its own ID. Reorder or remove modes with the row actions. Existing saved
presets retain their IDs, order, settings and exposure choices, including custom
settings on a mode named Default.

Each mode can combine:

- **Thinking:** Inherit, On or Off, using the template's `enable_thinking` argument.
- **Native effort:** a model-specific `reasoning_effort` string.
- **Template effort:** a model-specific `chat_template_kwargs.reasoning_effort` string.
- **Reasoning/thinking budgets:** inherit, a custom token count, or `-1` for
  unlimited **only when the engine supports that field and sentinel**.
- **Template arguments (JSON):** bounded additional template controls. Reserved
  conversation/tool/template-structure arguments cannot be replaced.
- **Prompt prefix:** an explicit fallback for models that use prompt tags.

Do not assume these fields are interchangeable or supported by every engine.
Native effort and template effort may be different bindings. Budgets are separate
from the maximum output-token limit and from an engine's startup reasoning budget.
Zero tokens, hidden reasoning output and a mode named "Off" do not necessarily
disable thinking. **Resolved request changes** shows exactly what the mode adds.

Suggestions come from explicit controls in the installed artifact's recorded
template, or the selected template override/model-default template. They do not
come from a repository name, model-card prose, or a different quantization.
**Add** a suggestion to review it; it is not selected or exposed automatically.
Missing metadata or unavailable template content means no suggestion, not proof
that the model lacks support. Nothing is executed to discover modes.

### Defaults and request precedence

- **Model default (no overrides)** leaves request reasoning controls unchanged.
  This can still mean the model thinks by default.
- Choosing a named **Default reasoning mode** applies it to requests without a
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

Only modes with **Expose to clients** selected are emitted as catalog variants in `/v1/models`,
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
  "menagerie_variant": "research-8k",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

The example requires a saved, exposed `research-8k` mode. Use
`"menagerie_variant": "model-default"` to bypass deployment-default overrides.
The gateway validates mode selection and required prompt content before loading
a model, removes the selector, and applies the selected mode before forwarding.
Unknown or unexposed selectors return HTTP 400.

Exposure is not access control: callers may still send native reasoning settings
directly. With no selected mode, deployment defaults fill only missing fields.
Runtime-specific reasoning behavior still needs a live serving check; metadata
inspection alone cannot prove that an engine honors a setting.
