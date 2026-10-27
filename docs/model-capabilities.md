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

The local Ollama inventory's **Inspect capabilities** uses `/api/show` declarations.
Those apply to Ollama's runtime, not automatically to another engine. Ollama still
owns its packages and dependency resolution; Menagerie does not reinterpret its
blobs or add an Ollama serving adapter.

GGUF `mmproj` files are shown as companion **candidates**, never automatically
paired. Select a compatible projector explicitly during download. It is pinned to
the same repository commit, checksummed, and compared to an upstream digest when
available. Deployment settings offer **Use downloaded projector** when the engine
advertises `--mmproj`; you must separately declare image input. The file's presence
does not establish model/engine compatibility. Other dependency relationships and
cross-repository projector resolution are not inferred.

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
