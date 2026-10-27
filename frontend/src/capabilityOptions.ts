import type {Row} from './ui';

export const reasoningIds = ['default', 'instant', 'low', 'medium', 'high'];
export const reasoningLabel = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** Saved mappings win. Metadata can fill gaps, never replace a user's settings. */
export function reasoningOptions(catalog: Row, hints: Row = {}, runtime: Row = {}): Row[] {
  const saved = catalog.reasoning?.presets;
  const variants: Row[] = catalog.model?.variants || [];
  const templateEngine = ['llama.cpp', 'prism', 'vllm', 'sglang'].includes(runtime.engine);
  return reasoningIds.map(id => {
    const preset = saved?.find((p: Row) => p.id === id);
    if (preset && (id === 'default' || Object.keys(preset.body || {}).length)) return {...preset, source: 'Saved settings'};
    const variant = variants.find(v => v.id === id);
    if (variant) {
      const body = variant.body || (variant.settings?.reasoningEffort ? {reasoning_effort: variant.settings.reasoningEffort} : {});
      return {id, enabled: true, body, source: 'Saved variant'};
    }
    if (id === 'default') return {id, enabled: !saved, body: {}, source: 'Deployment default'};
    const effort = id === 'instant' ? 'none' : id;
    if (templateEngine && hints.reasoning_effort?.includes(effort)) return {id, enabled: false, body: {reasoning_effort: effort}, source: 'Detected in model template'};
    if (id === 'instant' && templateEngine && hints.thinking_toggle) return {id, enabled: false, body: {chat_template_kwargs: {enable_thinking: false}}, source: 'Detected thinking control'};
    return {id, enabled: false, body: {}, source: 'Needs a supported model and engine control'};
  });
}

export function setReasoningOptions(catalog: Row, options: Row[]): Row {
  const model = catalog.model || {};
  const caps = {tools: false, input: ['text'], output: ['text'], ...model.capabilities};
  const reasoning = caps.reasoning || {};
  return {...catalog, model: {...model, capabilities: {...caps, reasoning: {supported: !!reasoning.supported || options.some(p => p.id !== 'default' && p.enabled)}}},
    reasoning: {...catalog.reasoning, presets: options.map(({id, enabled, body}) => ({id, enabled, body}))}};
}

export function mappingKind(body: Row): string {
  const keys = Object.keys(body);
  if (!keys.length) return '';
  if (keys.length !== 1) return 'custom';
  if (typeof body.reasoning_effort === 'string') return 'effort';
  if (body.chat_template_kwargs?.enable_thinking === false && Object.keys(body.chat_template_kwargs).length === 1) return 'template';
  if (typeof body.reasoning_budget === 'number') return 'reasoning_budget';
  if (typeof body.thinking_budget === 'number') return 'thinking_budget';
  return 'custom';
}
