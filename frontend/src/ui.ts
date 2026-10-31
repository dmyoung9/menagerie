import type { Deployment, OperationEvent, ServingDeployment } from './types';
import type { Decoder } from './decode';
import { eventPayload } from './contracts';
export type { Registry } from './types';

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
export function telemetryStale(
  host: { stale?: boolean; ts?: number },
  sampleSeconds?: number,
  now = Date.now(),
): boolean {
  // The server always provides `stale` (covering both a missing/old timestamp
  // and a collector that is alive but failing); the fallback below only guards
  // against an incompatible server and derives the threshold from the
  // configured sample interval instead of a hard-coded constant.
  if (typeof host.stale === 'boolean') return host.stale;
  if (typeof host.ts !== 'number') return true;
  const threshold =
    typeof sampleSeconds === 'number' && sampleSeconds > 0
      ? Math.max(10, 2 * sampleSeconds)
      : 15;
  return now / 1000 - host.ts > threshold;
}
export const mode = (d: Pick<Deployment, 'residency'>): string =>
  ({ pinned: 'Pinned', 'on-demand': 'On demand', evictable: 'Evictable' })[
    d.residency || ''
  ] ||
  d.residency ||
  'Unknown';
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
