# Configure a deployment

Unload a deployment before changing its configuration. For a native pool, unload
the entire pool. Changes are drafts until **Save**; **Discard** restores the saved
configuration, including omitted settings.

## Configuration cards

Configuration is one surface. Each card keeps less common settings in its own
advanced disclosure; there is no separate Advanced tab. Old `/advanced` links
redirect to Configuration.

- **Model & runtime:** installed model, installed engine, template selection and
  compatible projectors and MTP heads. Its disclosure contains capability evidence,
  manual client declarations, MTP token tuning and read-only model details.
  Detected capability status is evidence, not a switch that enables a modality.
- **Resources & context:** context, concurrency, engine fitting and device choices
  where the selected engine advertises them. vLLM controls retain their own engine
  semantics rather than pretending to be llama.cpp slots or native fitting.
  Advanced placement & memory groups device splits, MoE offload, flash attention,
  cache precision, CPU threads and batching.
- **Generation:** output-limit catalog metadata, temperature and the default
  reasoning level. Advanced sampling contains other supported sampling overrides
  and optional published recommendations. There is no separate sampling-preset
  selector; **Greedy (0)** explicitly sets temperature to zero.
- **Variants:** a collapsed editor for named reasoning levels, with a default-level
  summary. Different quantizations are separate installed models, not variants.
- **Availability:** loading policy, idle timeout, eviction eligibility and client
  availability. Native pools retain shared policy and pool-local residency.

The collapsed, full-width **Identity** strip contains the display name and API
model ID. Private ports and queue timeout live in **Availability → Advanced**.
The full-width **Diagnostics & raw** card contains requested options, last observed
runtime settings, unsupported saved overrides with reset actions, other advertised
engine controls, and JSON/raw arguments. JSON is an escape hatch, not another
curated home for each parameter. Native pools require named options, not raw arguments.

Filter configuration matches parameter names, labels, descriptions and domains.
Matching advanced sections open; hidden cards stay mounted, preserving drafts.
Closed disclosures containing explicit overrides show a count. Opening a card
does not create an override. Startup-option changes take effect on the next load.
The usual primary-control budget is 16; a deployment with both projector and MTP
head selectors may show up to 18 so those file choices stay with the model.

## Unspecified is not an explicit automatic value

An empty numeric input means **engine default**; its placeholder is informational.
**Reset** removes the override. No value is sent for that parameter. Merely viewing
an engine default must not save it as an override.

Choosing **Automatic** or entering a known sentinel saves an explicit engine mode.
For llama.cpp this includes context `0` (model-derived context), parallel slots `-1`
and automatic GPU offloading. These are different from omission and do not guarantee
fit or performance. **Explicit override** saves a concrete value. Removing an override
returns control to the engine, rather than sending a disabled value.

Reported runtime settings are labeled **observed** and remain separate from the
draft. They describe the loaded session, not what a future load must choose.
Resource estimates are advisory, not allocations or launch reservations. Native
pool process peaks are aggregate observations, not measurements for each member.

## Generation and recommendations

Temperature presets are explicit choices; resetting returns control to the engine.
Published recommendations
are inspectable advice, not runtime defaults. **Apply compatible recommendations**
changes only supported sampling values in the draft; Save is still required.

Maximum output tokens is client catalog metadata, not a promised engine-enforced
ceiling. Clients may override request sampling/defaults. Engine startup defaults
require reload to change; variants remain request-level transformations and can be
configured manually even when reasoning detection is unknown.

## Native-pool ownership and recovery

Native pool members share the installed engine, process device visibility, loading
policy and residency limits. Shared controls affect all members; child presets
retain model-server options. Router settings cannot be independently inserted into
member JSON. Changing engines resets engine-specific options only after the existing
engine-change confirmation; no capability acknowledgment gate is added.

If capability preview is unavailable, manual configuration remains available.
Inspect evidence and engine errors rather than treating unknown as unsupported.
A projector candidate or an advertised executable flag alone does not certify
image inference. A replaced executable must be registered as an updated installation
before its options can be probed. See [capabilities](model-capabilities.md) and
[multi-model deployments](multi-model-deployments.md) for related limitations.
