import type {
  ConfiguredModelCatalog,
  ModelCatalog,
  ReasoningPreset,
  UnknownRecord,
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

export const standardReasoningIds = ['instant', 'low', 'medium', 'high'];

/** Standard placeholders are UI choices only, never saved/exposed automatically. */
export function reasoningLevels(catalog: ModelCatalog): ReasoningPreset[] {
  const saved = reasoningOptions(catalog);
  return [
    ...saved.filter((mode) => mode.id === 'default'),
    ...standardReasoningIds.map(
      (id) =>
        saved.find((mode) => mode.id === id) || {
          id,
          enabled: false,
          body: {},
        },
    ),
    ...saved.filter(
      (mode) =>
        mode.id !== 'default' && !standardReasoningIds.includes(mode.id),
    ),
  ];
}

export function mappingKind(body: UnknownRecord): string {
  const keys = Object.keys(body);
  if (!keys.length) return '';
  if (keys.length !== 1) return 'custom';
  if (typeof body.reasoning_effort === 'string') return 'effort';
  const template = body.chat_template_kwargs;
  if (template && typeof template === 'object' && !Array.isArray(template)) {
    const kwargs = template as UnknownRecord;
    if (Object.keys(kwargs).length === 1) {
      if (typeof kwargs.enable_thinking === 'boolean') return 'template';
      if (typeof kwargs.reasoning_effort === 'string') return 'template-effort';
    }
  }
  if (typeof body.reasoning_budget === 'number') return 'reasoning_budget';
  if (typeof body.thinking_budget === 'number') return 'thinking_budget';
  return 'custom';
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
