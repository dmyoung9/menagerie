import type {
  ConfiguredModelCatalog,
  ModelCatalog,
  ReasoningPreset,
  UnknownRecord,
} from './types';

export const reasoningLabel = (id: string) =>
  id === 'xhigh' ? 'XHigh' : id.charAt(0).toUpperCase() + id.slice(1);
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

export const standardReasoningIds = [
  'instant',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Seed only new builder drafts; saved catalogs remain authoritative. */
export function defaultReasoningOptions(): ReasoningPreset[] {
  return standardReasoningIds.map((id): ReasoningPreset => ({
    id,
    enabled: ['low', 'medium', 'high'].includes(id),
    body:
      id === 'instant'
        ? { chat_template_kwargs: { enable_thinking: false } }
        : { reasoning_effort: id },
  }));
}

export const configuredMode = (mode: ReasoningPreset) =>
  Object.entries(mode.body).some(
    ([key, value]) =>
      key !== 'chat_template_kwargs' ||
      (value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length > 0),
  ) || !!mode.prompt_prefix?.trim();

export function supportsReasoning(catalog: ModelCatalog): boolean {
  const value = catalog.model?.capabilities?.reasoning;
  return value === true || (typeof value === 'object' && value.supported);
}

export function newModeId(name: string, catalog: ModelCatalog): string {
  const used = new Set([
    ...standardReasoningIds,
    'default',
    'model-default',
    ...reasoningOptions(catalog).map((mode) => mode.id),
    ...(catalog.model?.variants || []).map((mode) => mode.id),
  ]);
  const base = modeSlug(name) || 'variant';
  let id = base;
  for (let n = 2; used.has(id); n++) {
    const suffix = `-${n}`;
    id = base.slice(0, 64 - suffix.length) + suffix;
  }
  return id;
}

/** Standard placeholders are UI choices only, never saved/exposed automatically. */
export function reasoningLevels(catalog: ModelCatalog): ReasoningPreset[] {
  const saved = reasoningOptions(catalog);
  const defaults = defaultReasoningOptions();
  return [
    // Fill legacy blank common choices in the editor only; never rewrite saved
    // mappings on read or change a configured mapping, saved name or exposure.
    ...saved.map((mode) => {
      const fallback = defaults.find((row) => row.id === mode.id);
      return fallback && !configuredMode(mode)
        ? { ...mode, body: fallback.body }
        : mode;
    }),
    ...defaults
      .filter((mode) => !saved.some((row) => row.id === mode.id))
      .slice(0, 64 - saved.length)
      .map((mode) => ({
        ...mode,
        enabled: false,
      })),
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
