import {useEffect, useState} from 'react';
import {api, CopyButton, Dialog, Field, gib, Json, message, Tabs, type Row} from './ui';

export function LaunchReview({modal, deployments, close, done, host}: {modal: Row; deployments: Row[]; close: () => void; done: () => void; host: Row}) {
  const [plan, setPlan] = useState<Row | null>(null), [error, setError] = useState(''), [accepted, setAccepted] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {let alive = true; api(`/api/${modal.kind}/${modal.row.id}/validate`, {}).then(p => {if (alive) setPlan(p);}).catch(e => {if (alive) setError(message(e));}); return () => {alive = false;};}, [modal.kind, modal.row.id]);
  const names = (ids: string[]) => ids.map(id => deployments.find(d => d.id === id)?.name || id);
  const needsAcceptance = Boolean(plan?.warnings?.length || plan?.stops?.length);
  return <Dialog title="Review launch" close={close} busy={busy} wide><h3>{modal.row.name}</h3>{error && <p className="alert error" role="alert">{error}</p>}{!plan && !error && <p className="muted">Checking capacity…</p>}{plan && <>
    <div className="table-wrap"><table><thead><tr><th>Model</th><th className="numeric">Estimated VRAM (GiB)</th><th>Confidence</th></tr></thead><tbody>{Object.entries(plan.estimates).map(([id, estimate]: [string, any]) => <tr key={id}><td>{deployments.find(d => d.id === id)?.name || modal.row.name}</td><td className="numeric">{gib(estimate.reservation_mib)}</td><td>{estimate.confidence}</td></tr>)}</tbody>{Object.keys(plan.estimates).length > 1 && <tfoot><tr><td>Total</td><td className="numeric">{gib(Object.values(plan.estimates).reduce((sum: number, e: any) => sum + e.reservation_mib, 0))}</td><td/></tr></tfoot>}</table></div>
    <dl className="properties">{(host.gpus || []).map((g: Row, index: number) => <div className="property-pair" key={g.index ?? index}><dt>GPU {g.index ?? index} free (GiB)</dt><dd>{gib(g.free_mib)}</dd></div>)}</dl>
    {plan.stops.length > 0 && <div className="warning"><h3>Will unload</h3><ul>{names(plan.stops).map(n => <li key={n}>{n}</li>)}</ul><p>KV caches will be lost. Failed launches attempt to restore these deployments.</p></div>}
    {plan.errors.map((e: string) => <p className="alert error" role="alert" key={e}>{e}</p>)}
    {plan.warnings.length > 0 && <details><summary>Memory uncertainty ({plan.warnings.length})</summary>{plan.warnings.map((w: string) => <p className="warning" key={w}>{w}</p>)}</details>}
    {needsAcceptance && <label className="check"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)}/>{plan.stops.length ? plan.warnings.length ? 'Approve these unloads and uncertain memory estimates' : 'Approve these unloads' : 'Allow loading with uncertain memory estimates'}</label>}
    <div className="dialog-actions"><button disabled={busy} onClick={close}>Cancel</button><button className="primary" disabled={busy || plan.errors.length > 0 || (needsAcceptance && !accepted)} onClick={async () => {setBusy(true); setError(''); try {await api(`/api/${modal.kind}/${modal.row.id}/start`, {override: accepted, plan_token: plan.plan_token}); done();} catch (e) {setError(message(e));} finally {setBusy(false);}}}>{busy ? 'Submitting…' : 'Load'}</button></div>
  </>}</Dialog>;
}

export function Connect({endpoint, deployments, close}: {endpoint: string; deployments: Row[]; close: () => void}) {
  const [tab, setTab] = useState('Example request'), [alias, setAlias] = useState(deployments.find(d => d.lifecycle?.serving)?.alias || ''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const available = deployments.filter(d => d.lifecycle?.serving);
  const request = [
    `curl ${endpoint}/chat/completions`,
    `  -H 'Content-Type: application/json'`,
    `  -d '${JSON.stringify({model: alias, messages: [{role: 'user', content: 'Hello'}], stream: true})}'`,
  ].join(' \\\n');
  return <Dialog title="Connect client" close={close} wide><div className="endpoint-field"><span>Base URL</span><code>{endpoint || 'Loading…'}</code>{endpoint && <CopyButton value={endpoint} label="Copy base URL"/>}</div><Field label="Model"><div className="copy-value"><select value={alias} onChange={e => setAlias(e.target.value)}>{available.map(d => <option key={d.id} value={d.alias}>{d.alias}</option>)}</select>{alias && <CopyButton value={alias} label="Copy model"/>}</div></Field>{!available.length && <p className="muted">No models are available to clients yet.</p>}<p className="muted">Use this endpoint on the machine running Menagerie. Inference is loopback-only.</p>
    <Tabs items={['Example request', 'OpenCode']} value={tab} onChange={setTab}/>
    {tab === 'Example request' && alias && <div className="code-block"><CopyButton value={request} label="Copy example request"/><pre>{request}</pre></div>}
    {tab === 'OpenCode' && <><p>Export a provider fragment to merge into your client configuration.</p><button onClick={async () => {try {const r = await api('/api/integration/opencode/export', {}); setNotice('Saved to ' + r.path); setError('');} catch (e) {setError(message(e));}}}>Export configuration</button><p className="muted">Clients using dynamic discovery do not need a static export.</p></>}
    {notice && <p role="status" className="muted path">{notice}</p>}{error && <p role="alert" className="error-text">{error}</p>}
  </Dialog>;
}

const policyFields: [string, string, number, number][] = [
  ['gpu_headroom_mib', 'GPU reserve (MiB)', 2048, 1048576], ['ram_headroom_mib', 'RAM reserve (MiB)', 4096, 1048576], ['temperature_limit', 'Temperature limit (°C)', 60, 85], ['max_queue', 'Queued requests', 1, 256], ['sample_seconds', 'Sample interval (seconds)', 1, 60], ['retention_days', 'Detailed history (days)', 1, 90], ['summary_days', 'Summary history (days)', 1, 365], ['history_quota_mib', 'History quota (MiB)', 16, 16384],
];
export function PolicyEditor({initial, save, busy, purge}: {initial: Row; save: (v: Row) => void; busy: boolean; purge: () => void}) {
  const [value, setValue] = useState<Row>(Object.fromEntries([...policyFields.map(([k]) => k), 'expose_on_demand'].map(k => [k, initial[k]])));
  return <form onSubmit={e => {e.preventDefault(); save(value);}}>{[['Capacity & requests', policyFields.slice(0, 4)], ['Telemetry & retention', policyFields.slice(4)]].map(([title, fields]) => <section key={String(title)}><h3>{String(title)}</h3><div className="form-grid">{(fields as typeof policyFields).map(([key, label, min, max]) => {const memory = key.endsWith('_mib'), scale = memory ? 1024 : 1; return <Field label={memory ? label.replace('MiB', 'GiB') : label} key={key}><input type="number" required min={min / scale} max={max / scale} step={memory ? 1 / 1024 : key === 'sample_seconds' ? 'any' : 1} value={value[key] / scale} onChange={e => setValue({...value, [key]: memory ? Math.round(Number(e.target.value) * scale) : Number(e.target.value)})}/></Field>;})}</div></section>)}<label className="check"><input type="checkbox" checked={value.expose_on_demand} onChange={e => setValue({...value, expose_on_demand: e.target.checked})}/>List unloaded on-demand models for clients</label><div className="dialog-actions"><button type="button" disabled={busy} className="danger subtle" onClick={purge}>Purge telemetry…</button><button className="primary" disabled={busy}>Save policy</button></div></form>;
}

export function SourceBuild({close, done}: {close: () => void; done: () => void}) {
  const [value, setValue] = useState<Row>({engine: 'llama.cpp', url: 'https://github.com/ggml-org/llama.cpp', commit: ''}), [plan, setPlan] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const preview = async () => {setBusy(true); setError(''); try {setPlan(await api('/api/runtimes/install/preview', value));} catch (e) {setError(message(e));} finally {setBusy(false);}};
  return <Dialog title="Build engine from source" close={close} busy={busy}><form onSubmit={e => {e.preventDefault(); void preview();}}><fieldset disabled={busy}>
    <Field label="Engine"><select value={value.engine} onChange={e => {setValue({...value, engine:e.target.value}); setPlan(null);}}>{['llama.cpp', 'prism'].map(v => <option key={v}>{v}</option>)}</select></Field>
    <Field label="Repository URL"><input type="url" required value={value.url} onChange={e => {setValue({...value, url:e.target.value}); setPlan(null);}}/></Field>
    <Field label="Commit"><input required spellCheck={false} autoCapitalize="none" value={value.commit} onChange={e => {setValue({...value, commit:e.target.value}); setPlan(null);}}/></Field>
    </fieldset><button disabled={busy}>Preview commands</button></form>{error && <p role="alert" className="error-text">{error}</p>}{plan && <><p className="warning">{plan.warning}</p><Json value={plan.commands}/><div className="dialog-actions"><button className="danger" disabled={busy} onClick={async () => {setBusy(true); setError(''); try {await api('/api/runtimes/install', {...value, token: plan.token, trust: true}); done();} catch (e) {setError(message(e));} finally {setBusy(false);}}}>Trust source & build</button></div></>}</Dialog>;
}
