import {Model, Provider} from '@opencode/plugin';
import type {Context} from '@opencode/plugin/promise/plugin';

const providerID = Provider.ID.make('menagerie');
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Strict Menagerie v2 catalog; no inferred capabilities or stale local policy. */
export function inventory(payload: unknown): Model.Info[] {
  if (!object(payload) || !Array.isArray(payload.data)) throw new Error('Invalid model list');
  const ids = new Set<string>();
  return payload.data.map((item: unknown) => {
    if (!object(item) || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id))
      throw new Error('Invalid or duplicate model identity');
    ids.add(item.id);
    const contract = item.menagerie?.catalog;
    const model = contract?.model;
    if (!object(contract) || contract.version !== 2 || contract.catalog_id !== item.id || !object(model) ||
        typeof model.name !== 'string' || typeof model.enabled !== 'boolean' ||
        !object(model.capabilities) || typeof model.capabilities.tools !== 'boolean' ||
        !['input', 'output'].every(key => Array.isArray(model.capabilities[key]) && model.capabilities[key].length > 0 &&
          model.capabilities[key].every((v: unknown) => typeof v === 'string' && ['text', 'image', 'audio', 'video'].includes(v))) ||
        !object(model.limit) || !positive(model.limit.context) || !positive(model.limit.output) || model.limit.output > model.limit.context ||
        !Array.isArray(model.variants) || model.variants.some((v: unknown) => !object(v) || typeof v.id !== 'string' || !v.id) ||
        new Set(model.variants.map((v: any) => v.id)).size !== model.variants.length ||
        !Array.isArray(model.cost) || !model.cost.length) throw new Error('Invalid capability contract');
    let threshold = 0;
    for (const [index, cost] of model.cost.entries()) {
      if (!object(cost) || !object(cost.cache) || ![cost.input, cost.output, cost.cache.read, cost.cache.write].every(rate =>
        typeof rate === 'number' && Number.isFinite(rate) && rate >= 0)) throw new Error('Invalid pricing');
      if (index === 0 ? cost.tier !== undefined : !object(cost.tier) || cost.tier.type !== 'context' || !positive(cost.tier.size) || cost.tier.size <= threshold)
        throw new Error('Invalid pricing tier');
      if (index) threshold = cost.tier.size;
    }
    // The SDK validates optional reasoning, variants, compatibility, and overlays.
    // Identity is always owned by the endpoint, never by metadata overlays.
    const resolved = Model.Info.make({...Model.Info.default(providerID, Model.ID.make(item.id)),
      ...structuredClone(model), id: Model.ID.make(item.id), providerID, modelID: Model.ID.make(item.id)});
    // OpenCode/OpenChamber already expose a no-variant Default choice. An empty
    // catalog Default maps to it; keep a legacy named default with real overrides.
    return {...resolved, variants: resolved.variants.filter(v => v.id !== 'default' ||
      [v.body, v.settings, v.headers].some(value => Object.keys(value || {}).length > 0))};
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function localEndpoint(baseURL: unknown): URL {
  if (typeof baseURL !== 'string') throw new Error('Menagerie needs settings.baseURL');
  const url = new URL(baseURL);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/v1')
    throw new Error('Menagerie discovery requires a loopback HTTP /v1 endpoint');
  url.pathname = '/v1/models';
  return url;
}

export async function startDiscovery(ctx: Context, options: {
  baseURL?: string; interval?: number; fetch?: typeof fetch; log?: (message: string) => void;
} = {}) {
  const baseURL = options.baseURL ?? 'http://127.0.0.1:8001/v1';
  localEndpoint(baseURL);
  const request = options.fetch ?? fetch;
  const log = options.log ?? ((message: string) => console.warn(`[menagerie-discovery] ${message}`));
  let models: readonly Model.Info[] | undefined;
  let endpoint = '';
  let hash = '';
  let stopped = false;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let lastError = '';
  const registration = await ctx.provider.transform(editor => {
    if (!editor.get(providerID)) {
      editor.add({info: {...Provider.Info.empty(providerID), name: 'Menagerie', activation: 'enabled',
        package: '@opencode/ai/providers/openai-compatible', settings: {baseURL}}, models: models ?? []});
    } else if (models !== undefined) {
      editor.models.set(providerID, models);
    }
  });

  const perform = async () => {
    try {
      const {data: provider} = await ctx.provider.get({providerID});
      if (stopped) return;
      const url = localEndpoint(provider?.settings?.baseURL);
      const nextEndpoint = url.toString();
      if (endpoint && endpoint !== nextEndpoint) {
        models = undefined;
        hash = '';
        await ctx.provider.reload();
      }
      endpoint = nextEndpoint;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 3000);
      let next: Model.Info[];
      try {
        const headers = new Headers(provider?.headers);
        headers.set('Accept', 'application/json');
        const response = await request(url, {headers, signal: controller.signal, redirect: 'error'});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        next = inventory(await response.json());
      } finally {
        clearTimeout(timeout);
      }
      if (stopped) return;
      const nextHash = JSON.stringify(next);
      if (nextHash !== hash) {
        models = next;
        await ctx.provider.reload();
        hash = nextHash;
      }
      lastError = '';
    } catch (error) {
      if (stopped) return;
      // No raw errors, response bodies, URLs, headers, or paths in logs.
      const message = error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : 'Unavailable or invalid catalog';
      if (message !== lastError) log(`${message}; retaining last successful inventory for this endpoint`);
      lastError = message;
    }
  };
  const refresh = () => {
    if (stopped) return Promise.resolve();
    pending ??= perform().finally(() => {pending = undefined;});
    return pending;
  };
  // Make the first inventory available before setup completes. Standalone CLI
  // requests can resolve their model immediately after plugin initialization.
  await refresh();
  const timer = setInterval(() => {void refresh();}, options.interval ?? 30_000);
  return {refresh, async dispose() {
    stopped = true;
    clearInterval(timer);
    controller?.abort();
    await pending;
    await registration.dispose();
  }};
}
