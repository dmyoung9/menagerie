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

## Configure deployment-owned reasoning presets

Each model configuration has compact **Capabilities** and **Reasoning options**
controls. Selected chips are exposed to clients. Text is implicit; Tools, Images,
Audio, and Video describe additional input capabilities. Output formats are under
**Advanced capabilities**.

Reasoning controls are filled from detected template controls for supported
engines. Existing saved mappings and exposure choices take precedence. Unknown
options stay disabled until configured; a thinking model alone does not imply
an Instant switch or effort levels. Explicit comparisons to `reasoning_effort`
levels in a template are used as evidence, not just the presence of that variable.

If metadata is incomplete, open **Advanced capabilities** and choose a control
for each option. There is no need to edit JSON for the common mappings:

- **Native reasoning effort** maps Instant to `reasoning_effort: "none"` and
  Low/Medium/High to `"low"`, `"medium"`, and `"high"`.
- **Template enable_thinking** maps Instant to
  `chat_template_kwargs: {"enable_thinking": false}`. It does not invent effort
  levels. When this template variable is detected, a shortcut offers this mapping.
- **Default** sends no preset override; the deployment/engine default remains in
  effect. It is not another name for Medium.

The initial configuration exposes only Default. Select exactly the options you
want advertised. Token-budget controls offer numeric inputs; custom request
settings are an advanced escape hatch. A startup-only reasoning budget is not a
per-request control. Empty mappings cannot be exposed except for Default. Never
use an output formatting switch that merely hides reasoning to implement Instant.

Input and output modalities are declared separately. Image, audio, and video
declarations do not install processors, add gateway endpoints, or certify runtime
behavior; verify the complete request path before advertising them. The chat gateway
forwards message content without transforming multimodal data.

## Client exposure

Only checked presets are emitted as explicit catalog variants in `/v1/models`,
the OpenCode configuration export, and the existing OpenCode discovery plugin.
Their request `body` mappings survive the plugin's SDK validation. The metadata
does not ask clients to synthesize additional reasoning levels.

OpenCode/OpenChamber already provide a built-in Default (no variant). The plugin
maps Menagerie's empty Default preset to that choice, avoiding a duplicate.
Those clients retain their built-in Default even when the explicit Default preset
is unchecked in Menagerie; exposure cannot remove a client-owned base option.

Clients without a variant picker may send a selector to the chat endpoint:

```json
{
  "model": "my-model",
  "menagerie_variant": "instant",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

The gateway removes the selector and applies the exposed preset before forwarding.
An unknown or unchecked selector returns HTTP 400. Preset values take precedence
over conflicting request values; unrelated template arguments are preserved.

Exposure is not access control: callers may still send native reasoning settings
directly. Omitting `menagerie_variant` leaves the original request unchanged.
Runtime-specific reasoning behavior still needs a live serving check; metadata
inspection alone cannot prove that an engine honors a setting.
