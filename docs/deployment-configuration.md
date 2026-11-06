# Configure a deployment

Unload a deployment before changing its configuration. For a native pool, unload
the entire pool. Changes are drafts until **Save**; **Discard** restores the saved
configuration, including omitted settings.

## Essential settings

The Configuration editor groups common settings into:

- **Model & runtime:** installed model, installed engine, template selection and
  compatible auxiliary-component candidates. Detected capability status is evidence,
  not a switch that enables a modality.
- **Resources & context:** context, concurrency, engine fitting and device choices
  where the selected engine advertises them. vLLM controls retain their own engine
  semantics rather than pretending to be llama.cpp slots or native fitting.
- **Generation:** output-limit catalog metadata, sampling preset, temperature
  overrides, optional published sampling recommendations, and the existing Variants
  editor/default selector. Advanced sampling exposes the remaining supported flags.
- **Availability:** loading policy, idle timeout, eviction eligibility and client
  availability. Native pools retain shared policy and pool-local residency.

The compact **Identity** editor contains the display name and API model ID.
Private ports, queue timeouts, MTP tuning and detailed placement remain behind
advanced disclosures. The standalone deployment's Advanced tab also provides the
schema-driven editor, identity and raw JSON/arguments. Search matches parameter
names, descriptions and categories. Unknown engine-specific values remain accessible
through JSON and raw arguments; native pools require named options, not raw arguments.

## Unspecified is not an explicit automatic value

**Unspecified · engine default** removes the override. No value is sent for that
parameter. Merely viewing an engine default must not save it as an override.

**Automatic · explicit engine mode** saves a known engine sentinel, where supported.
For llama.cpp this includes context `0` (model-derived context), parallel slots `-1`
and automatic GPU offloading. These are different from omission and do not guarantee
fit or performance. **Explicit override** saves a concrete value. Removing an override
returns control to the engine, rather than sending a disabled value.

Reported runtime settings are labeled **observed** and remain separate from the
draft. They describe the loaded session, not what a future load must choose.
Resource estimates are advisory, not allocations or launch reservations. Native
pool process peaks are aggregate observations, not measurements for each member.

## Generation and recommendations

Sampling presets are explicit choices: engine defaults remove sampling overrides;
greedy decoding requests temperature zero where supported. Published recommendations
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
