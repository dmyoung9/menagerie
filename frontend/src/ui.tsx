import {useEffect, useRef, useState} from 'react';
import {Textarea} from '@/components/ui/textarea';
export {Status, Empty, Tabs, CopyButton, Menu, Dialog, Field} from '@/components/workspace';

export type Row = Record<string, any>;
export type Registry = Record<string, Row[]>;
let token = '';
export async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-Menagerie-Token': token}, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const detail = data.detail || data.error;
    throw new Error(Array.isArray(detail) ? detail.map(d => `${d.loc?.slice(1).join('.')}: ${d.msg}`).join('\n') : typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  if (data.csrf_token) token = data.csrf_token;
  return data;
}
export const number = (v: any, digits = 1) => typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString(undefined, {maximumFractionDigits: digits}) : '—';
export const gib = (v: any) => typeof v === 'number' ? number(v / 1024) : '—';
export const date = (v: number) => v ? new Date(v * 1000).toLocaleString() : '—';
export const pretty = (v: unknown) => JSON.stringify(v, null, 2);
export const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export const active = (d: Row) => ['QUEUED', 'STARTING', 'LOADING', 'READY', 'DEGRADED', 'STOPPING'].includes(d.state);
export const visible = (d: Row) => Boolean(d.lifecycle?.serving);
export const mode = (d: Row) => ({pinned: 'Pinned', 'on-demand': 'On demand', evictable: 'Evictable'}[d.residency as string] || d.residency);
export function state(d: Row): string {
  if (!d.enabled) return 'Inactive';
  return ({READY: 'Ready', DEGRADED: 'Degraded', FAILED: 'Failed', ERROR: 'Failed', STOPPED: 'Unloaded', QUEUED: 'Queued', STARTING: 'Starting', VALIDATING: 'Validating', LOADING: 'Loading', STOPPING: 'Unloading'} as Row)[d.state] || d.state || 'Unknown';
}
export function Json({value}: {value: unknown}) { return <pre>{pretty(value)}</pre>; }
export function JsonEdit({label, value, onChange, onValid}: {label: string; value: any; onChange: (v: any) => void; onValid?: (valid: boolean) => void}) {
  const [text, setText] = useState(pretty(value)), [error, setError] = useState('');
  const serialized = pretty(value), lastEdited = useRef(serialized);
  useEffect(() => {if (serialized !== lastEdited.current) {setText(serialized); setError(''); onValid?.(true); lastEdited.current = serialized;}}, [serialized]);
  return <details><summary>{label}</summary><Textarea aria-label={label} aria-invalid={!!error} rows={8} value={text} spellCheck={false} onChange={e => {setText(e.target.value); try {const v = JSON.parse(e.target.value); lastEdited.current = pretty(v); onChange(v); setError(''); onValid?.(true);} catch {setError('Enter valid JSON before saving.'); onValid?.(false);}}}/>{error && <p className="error-text" role="alert">{error}</p>}</details>;
}
export function eventText(event: Row, deployments: Row[]): string {
  const name = deployments.find(d => d.id === event.deployment_id)?.name || 'Deployment';
  const data = event.data || {};
  if (event.kind === 'state') {
    const value = data.to || data.state;
    const verb: Row = {READY: 'is ready', LOADING: 'is loading', STARTING: 'is starting', QUEUED: 'is queued', VALIDATING: 'is validating', STOPPING: 'is unloading', STOPPED: 'unloaded', FAILED: 'failed', DEGRADED: 'needs attention'};
    return `${name} ${verb[value] || String(value || 'changed state').toLowerCase()}${data.reason ? ` · ${data.reason}` : ''}`;
  }
  if (event.kind === 'deployment' && typeof data.enabled === 'boolean') return `${name} ${data.enabled ? 'enabled' : 'disabled'} for clients`;
  return `${event.kind.replaceAll('_', ' ')}${data.error ? ': ' + data.error : data.message ? ': ' + data.message : ''}`;
}
