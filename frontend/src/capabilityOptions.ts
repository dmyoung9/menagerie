import type {
  ConfiguredModelCatalog,
  DiscoveredCapabilities,
  ModelCatalog,
  ReasoningPreset,
  Runtime,
} from './types';

export const reasoningLabel = (id: string) =>
  id.charAt(0).toUpperCase() + id.slice(1);
export const modeLabel = (mode: ReasoningPreset) =>
  mode.name || reasoningLabel(mode.id);
export const validModeId = (id: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id) && id !== 'model-default';
export const modeSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

/** Saved modes are authoritative: never pad them with invented levels or overwrite empty mappings. */
export function reasoningOptions(catalog: ModelCatalog): ReasoningPreset[] {
  if (catalog.reasoning?.presets) return catalog.reasoning.presets;
  return (catalog.model?.variants || []).flatMap((variant) => {
    const effort = variant.settings?.reasoningEffort;
    const body =
      variant.body ||
      (typeof effort === 'string' ? { reasoning_effort: effort } : {});
    if (
      Object.keys(body).some(
        (key) =>
          ![
            'reasoning_effort',
            'chat_template_kwargs',
            'reasoning_budget',
            'thinking_budget',
          ].includes(key),
      )
    )
      return [];
    if (!Object.keys(body).length && variant.id !== 'default') return [];
    return [{ id: variant.id, enabled: true, body, source: 'Saved variant' }];
  });
}

/** Suggestions require explicit evidence and are never exposed or selected automatically. */
export function reasoningSuggestions(
  hints: DiscoveredCapabilities = {},
  runtime: Partial<Runtime> = {},
): ReasoningPreset[] {
  if (!['llama.cpp', 'prism', 'vllm', 'sglang'].includes(runtime.engine || ''))
    return [];
  const modes: ReasoningPreset[] = (hints.reasoning_effort || [])
    .filter(validModeId)
    .map((id) => ({
      id,
      name: reasoningLabel(id),
      enabled: false,
      body: { chat_template_kwargs: { reasoning_effort: id } },
      source: 'Model template hint; confirm engine support',
    }));
  if (hints.thinking_toggle)
    for (const enabled of [true, false])
      modes.push({
        id: enabled ? 'thinking-on' : 'thinking-off',
        name: enabled ? 'Thinking on' : 'Thinking off',
        enabled: false,
        body: { chat_template_kwargs: { enable_thinking: enabled } },
        source: 'Model template hint; confirm engine support',
      });
  return modes.filter(
    (mode, index) => modes.findIndex((other) => other.id === mode.id) === index,
  );
}

export function setReasoningOptions(
  catalog: ModelCatalog,
  options: ReasoningPreset[],
): ConfiguredModelCatalog {
  const model = catalog.model || {};
  const caps = {
    tools: false,
    input: ['text'],
    output: ['text'],
    ...model.capabilities,
  };
  return {
    ...catalog,
    model: { ...model, capabilities: caps },
    reasoning: {
      ...catalog.reasoning,
      presets: options.map(({ source: _source, ...mode }) => {
        void _source;
        return mode;
      }),
    },
  };
}
