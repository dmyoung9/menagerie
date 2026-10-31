import type {
  Deployment,
  EffectiveTemplate,
  OperationEvent,
  ServingDeployment,
  TemplateAssetPublic,
  TemplateSelection,
  TemplateSource,
} from './types';
import type { Decoder } from './decode';
import { eventPayload } from './contracts';
export type { EffectiveTemplate, Registry } from './types';

export { Json, JsonEdit } from './Json';
export {
  Status,
  Empty,
  Tabs,
  CopyButton,
  Menu,
  Dialog,
  Field,
} from '@/components/workspace';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
let token = '';
export async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Menagerie-Token': token,
          },
          body: JSON.stringify(body),
        },
  );
  const data: unknown = await response.json();
  if (!response.ok) {
    const detail = isRecord(data) ? data.detail || data.error : data;
    throw new Error(
      Array.isArray(detail)
        ? detail
            .map((item: unknown) =>
              isRecord(item)
                ? `${Array.isArray(item.loc) ? item.loc.slice(1).join('.') : ''}: ${String(item.msg ?? '')}`
                : String(item),
            )
            .join('\n')
        : typeof detail === 'string'
          ? detail
          : JSON.stringify(detail),
    );
  }
  if (isRecord(data) && typeof data.csrf_token === 'string')
    token = data.csrf_token;
  return data;
}
export async function readApi<T>(
  path: string,
  decode: Decoder<T>,
  body?: unknown,
  transport = api,
): Promise<T> {
  return decode(await transport(path, body), path);
}
export const number = (v: unknown, digits = 1) =>
  typeof v === 'number' && Number.isFinite(v)
    ? v.toLocaleString(undefined, { maximumFractionDigits: digits })
    : '—';
export const gib = (v: unknown) =>
  typeof v === 'number' ? number(v / 1024) : '—';
export const date = (v: number) =>
  v ? new Date(v * 1000).toLocaleString() : '—';
export const pretty = (v: unknown) => JSON.stringify(v, null, 2);
export const message = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
export const active = (d: Deployment | ServingDeployment) =>
  ['QUEUED', 'STARTING', 'LOADING', 'READY', 'DEGRADED', 'STOPPING'].includes(
    d.state,
  );
export const visible = (d: Pick<Deployment, 'lifecycle'>) =>
  Boolean(d.lifecycle?.serving);
export const mode = (d: Pick<Deployment, 'residency'>): string =>
  ({ pinned: 'Pinned', 'on-demand': 'On demand', evictable: 'Evictable' })[
    d.residency || ''
  ] ||
  d.residency ||
  'Unknown';
export const templateKindLabel = (kind: TemplateAssetPublic['kind']): string =>
  ({ published: 'Published', embedded: 'Embedded', custom: 'Custom' })[kind];
export const templateSourceLabel = (source: TemplateSource): string =>
  (
    ({
      automatic: 'Automatic (engine default)',
      embedded: 'Embedded',
      published: 'Published',
      custom: 'Custom',
    }) satisfies Record<TemplateSource, string>
  )[source] || source;
export function effectiveTemplate(
  override: TemplateSelection | null | undefined,
  modelDefault: TemplateSelection | null | undefined,
  templates: TemplateAssetPublic[] | undefined,
): EffectiveTemplate {
  const list = templates || [];
  const first = (
    selection: TemplateSelection | null | undefined,
  ): EffectiveTemplate => {
    if (selection?.source && selection.source !== 'automatic') {
      const asset = selection.asset_id
        ? (list.find((t) => t.id === selection.asset_id) ?? null)
        : null;
      return {
        source: selection.source,
        asset,
        description: asset
          ? asset.name
          : `${selection.source} template missing`,
      };
    }
    return {
      source: 'automatic',
      asset: null,
      description: 'No template (engine default)',
    };
  };
  if (override) return first(override);
  return first(modelDefault);
}
export function state(d: Pick<Deployment, 'enabled' | 'state'>): string {
  if (!d.enabled) return 'Inactive';
  return (
    (
      {
        READY: 'Ready',
        DEGRADED: 'Degraded',
        FAILED: 'Failed',
        ERROR: 'Failed',
        STOPPED: 'Unloaded',
        QUEUED: 'Queued',
        STARTING: 'Starting',
        VALIDATING: 'Validating',
        LOADING: 'Loading',
        STOPPING: 'Unloading',
      } satisfies Record<string, string>
    )[d.state] ||
    d.state ||
    'Unknown'
  );
}
export function eventText(
  event: OperationEvent,
  deployments: Pick<Deployment, 'id' | 'name'>[],
): string {
  const name =
    deployments.find((d) => d.id === event.deployment_id)?.name || 'Deployment';
  const payload = eventPayload(event);
  const data = event.data || {};
  if (payload.kind === 'state') {
    const value = payload.to || payload.state;
    const verb: Record<string, string> = {
      READY: 'is ready',
      LOADING: 'is loading',
      STARTING: 'is starting',
      QUEUED: 'is queued',
      VALIDATING: 'is validating',
      STOPPING: 'is unloading',
      STOPPED: 'unloaded',
      FAILED: 'failed',
      DEGRADED: 'needs attention',
    };
    const stateValue = typeof value === 'string' ? value : undefined;
    const reason = payload.reason;
    return `${name} ${verb[stateValue || ''] || String(value || 'changed state').toLowerCase()}${reason ? ` · ${reason}` : ''}`;
  }
  if (payload.kind === 'deployment')
    return `${name} ${payload.enabled ? 'enabled' : 'disabled'} for clients`;
  const detail =
    typeof data.error === 'string'
      ? data.error
      : typeof data.message === 'string'
        ? data.message
        : '';
  return `${event.kind.replaceAll('_', ' ')}${detail ? ': ' + detail : ''}`;
}
