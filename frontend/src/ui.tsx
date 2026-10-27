import {useEffect, useId, useRef, useState, type ReactNode} from 'react';
import {Check, Copy, MoreHorizontal, X} from 'lucide-react';

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
export function Status({value}: {value: string}) { return <span className={'status status-' + value.toLowerCase().replaceAll(' ', '-')}><i/>{value}</span>; }
export function Empty({title, children}: {title: string; children?: ReactNode}) { return <div className="empty"><h2>{title}</h2>{children}</div>; }
export function Json({value}: {value: unknown}) { return <pre>{pretty(value)}</pre>; }
export function Tabs({items, value, onChange, label = 'Views'}: {items: string[]; value: string; onChange: (value: string) => void; label?: string}) {
  return <div className="tabs" role="group" aria-label={label}>{items.map(item => <button key={item} aria-pressed={item === value} className={item === value ? 'selected' : ''} onClick={() => onChange(item)}>{item}</button>)}</div>;
}
export function CopyButton({value, label = 'Copy'}: {value: string; label?: string}) {
  const [copied, setCopied] = useState(false), [error, setError] = useState(false);
  useEffect(() => {if (copied) {const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer);}}, [copied]);
  return <button className="icon-button" aria-label={error ? 'Copy failed; select and copy the text' : copied ? 'Copied' : label} title={error ? 'Copy failed; select and copy the text' : label} onClick={async () => {try {await navigator.clipboard.writeText(value); setCopied(true); setError(false);} catch {setError(true);}}}>{copied ? <Check size={16}/> : <Copy size={16}/>}<span className="sr-only" role="status">{copied ? 'Copied' : error ? 'Copy failed' : ''}</span></button>;
}
export function Menu({label, children}: {label: string; children: ReactNode}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [position, setPosition] = useState({top: 0, left: 0});
  useEffect(() => {
    const outside = (e: PointerEvent) => {if (!ref.current?.contains(e.target as Node)) ref.current?.removeAttribute('open');};
    const escape = (e: KeyboardEvent) => {if (e.key === 'Escape' && ref.current?.open) {ref.current.removeAttribute('open'); ref.current.querySelector('summary')?.focus();}};
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => {document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape);};
  }, []);
  return <details className="action-menu" ref={ref} onToggle={() => {if (ref.current?.open) {const rect = ref.current.getBoundingClientRect(); setPosition({top: Math.min(rect.bottom + 4, window.innerHeight - 250), left: Math.max(8, rect.right - 190)});}}}><summary aria-label={label} title={label}><MoreHorizontal size={18}/></summary><div className="menu-items" style={position} onClick={e => {if ((e.target as HTMLElement).closest('button:not(:disabled)')) ref.current?.removeAttribute('open');}}>{children}</div></details>;
}
export function Dialog({title, close, children, busy = false, wide = false, editor = false, guardChanges = true}: {title: string; close: () => void; children: ReactNode; busy?: boolean; wide?: boolean; editor?: boolean; guardChanges?: boolean}) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  const dirty = useRef(false);
  const dismiss = () => {if (!busy && (!guardChanges || !dirty.current || window.confirm('Discard unsaved changes?'))) close();};
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    const warn = (e: BeforeUnloadEvent) => {if (dirty.current) {e.preventDefault(); e.returnValue = '';}};
    window.addEventListener('beforeunload', warn);
    return () => {ref.current?.close(); previous?.focus(); window.removeEventListener('beforeunload', warn);};
  }, []);
  return <dialog ref={ref} onChangeCapture={e => {if ((e.target as HTMLElement).closest('form')) dirty.current = true;}} onClickCapture={e => {if ((e.target as HTMLElement).closest('form button[aria-pressed]')) dirty.current = true;}} className={'dialog ' + (wide ? 'wide ' : '') + (editor ? 'editor-page' : '')} aria-labelledby={id} onCancel={e => {e.preventDefault(); dismiss();}}>
    <div className="dialog-head"><h2 id={id}>{title}</h2><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={dismiss}><X size={18}/></button></div>
    <div className="dialog-body">{children}</div>
  </dialog>;
}
export function Field({label, children, hint}: {label: string; children: ReactNode; hint?: string}) {return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;}
export function JsonEdit({label, value, onChange, onValid}: {label: string; value: any; onChange: (v: any) => void; onValid?: (valid: boolean) => void}) {
  const [text, setText] = useState(pretty(value)), [error, setError] = useState('');
  const serialized = pretty(value), lastEdited = useRef(serialized);
  useEffect(() => {if (serialized !== lastEdited.current) {setText(serialized); setError(''); onValid?.(true); lastEdited.current = serialized;}}, [serialized]);
  return <details><summary>{label}</summary><textarea aria-label={label} rows={8} value={text} spellCheck={false} onChange={e => {setText(e.target.value); try {const v = JSON.parse(e.target.value); lastEdited.current = pretty(v); onChange(v); setError(''); onValid?.(true);} catch {setError('Enter valid JSON before saving.'); onValid?.(false);}}}/>{error && <p className="error-text" role="alert">{error}</p>}</details>;
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
