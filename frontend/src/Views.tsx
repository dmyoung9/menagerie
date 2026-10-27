import {useEffect, useRef, useState} from 'react';
import {ArrowLeft, ArrowUpRight, Plus} from 'lucide-react';
import {active, api, CopyButton, date, Dialog, Empty, eventText, gib, Json, Menu, message, mode, number, state, Status, Tabs, visible, type Registry, type Row} from './ui';
import {ModelCard} from './ModelCard';
import {EngineCatalog} from './EngineCatalog';
import {byteSize, parameterSize, quantization} from './variants';

export const go = (path: string) => {window.location.hash = '/' + path;};
function InspectModel({id}: {id: string}) {
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  return <><button disabled={busy} onClick={async () => {setBusy(true); try {await api(`/api/models/${id}/inspect`, {}); setNotice('Inspection queued. Results refresh automatically; see Activity for progress.');} catch (e) {setNotice(message(e));} finally {setBusy(false);}}}>Refresh capability metadata</button>{notice && <p role="status">{notice}</p>}</>;
}
type Actions = {edit: (kind: string, row?: Row, clone?: boolean) => void; load: (kind: string, row: Row) => void; stop: (kind: string, row: Row) => void; enable: (d: Row, enabled: boolean) => void; inspect: (title: string, value: any) => void; revisions: (row: Row) => void};
export function ActivityFeed({events, deployments}: {events: Row[]; deployments: Row[]}) {
  return events.length ? <ol className="activity-feed">{events.map(e => <li key={e.seq}><span className={'event-dot ' + ((e.data?.to === 'FAILED' || e.data?.error) ? 'failed' : '')}/><span>{eventText(e, deployments)}</span><time dateTime={new Date(e.ts * 1000).toISOString()} title={date(e.ts)}>{new Date(e.ts * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</time></li>)}</ol> : <p className="muted padded">No recent activity.</p>;
}
export function MemoryChart({samples}: {samples: Row[]}) {
  const [gpuIndex, setGpuIndex] = useState(0);
  const container = useRef<HTMLElement>(null), [width, setWidth] = useState(920);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(280, Math.min(920, entries[0].contentRect.width - 32))));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const gpus = samples.at(-1)?.gpus || [];
  const values = samples.filter(s => typeof s.gpus?.[gpuIndex]?.used_mib === 'number');
  const max = values.at(-1)?.gpus?.[gpuIndex]?.total_mib;
  const start = values[0]?.ts, end = values.at(-1)?.ts;
  const points = values.map((s, i) => `${50 + (end > start ? (s.ts - start) / (end - start) : i / Math.max(1, values.length - 1)) * (width - 80)},${160 - s.gpus[gpuIndex].used_mib / max * 140}`).join(' ');
  return <section className="panel" ref={container}><div className="panel-head"><h2>GPU memory</h2>{gpus.length > 1 && <select aria-label="Chart GPU" value={gpuIndex} onChange={e => setGpuIndex(Number(e.target.value))}>{gpus.map((g: Row, i: number) => <option key={i} value={i}>{g.name} · GPU {g.index ?? i}</option>)}</select>}</div>{values.length < 2 || !max ? <p className="muted padded">Collecting memory history…</p> : <>
    <svg className="chart" viewBox={`0 0 ${width} 205`} role="img" aria-label={'GPU ' + gpuIndex + ' memory history in GiB'}>{[0, .5, 1].map(f => <g key={f}><line x1="50" x2={width - 30} y1={160 - f * 140} y2={160 - f * 140}/><text x="38" y={164 - f * 140} textAnchor="end">{number(max * f / 1024)}</text></g>)}<text x="50" y="12">GiB</text><polyline points={points}/><text x="50" y="190">{start ? new Date(start * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : 'Earlier'}</text><text x={width - 30} y="190" textAnchor="end">{end ? new Date(end * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : 'Now'}</text></svg>
  </>}</section>;
}
export function DeploymentDetail({d, tab, data, host, inflight, actions, events}: {d: Row; tab: string; data: Registry; host: Row; inflight: number; actions: Actions; events: Row[]}) {
  const profile = d.profile_snapshot || {};
  const [logs, setLogs] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    if (tab !== 'Logs') return;
    let alive = true;
    const load = () => api(`/api/deployments/${d.id}/logs`).then(r => {if (alive) {setLogs(r.text || 'No logs yet.'); setError('');}}).catch(e => {if (alive) setError(message(e));});
    void load(); const timer = setInterval(load, 2000);
    return () => {alive = false; clearInterval(timer);};
  }, [tab, d.id]);
  const metrics = host.runtime_metrics?.[d.id] || {}, process = host.deployments?.[d.id] || {};
  const rate = (tokens: string, seconds: string) => {const sum = (name: string) => Object.entries(metrics).filter(([k]) => k.split('{')[0].replace(/^llamacpp:/, '') === name).reduce((n, [, v]) => n + Number(v), 0); return sum(seconds) > 0 ? sum(tokens) / sum(seconds) : null;};
  return <>
    <a className="back-link" href="#/deployments"><ArrowLeft size={16}/>Deployments</a>
    <div className="page-head"><div><h1>{d.name}</h1><Status value={state(d)}/></div><div className="actions">{d.enabled && !active(d) && <button className="primary" onClick={() => actions.load('deployments', d)}>Load now</button>}{['READY', 'DEGRADED', 'LOADING', 'STARTING', 'QUEUED'].includes(d.state) && <button onClick={() => actions.stop('deployments', d)}>Unload</button>}<button disabled={active(d)} onClick={() => actions.edit('deployments', d)}>Edit</button>{!d.enabled && <button className="primary" onClick={() => actions.enable(d, true)}>Enable for clients</button>}</div></div>
    {d.lifecycle?.failure && <p className="alert error" role="alert">{d.lifecycle.failure}</p>}
    <Tabs items={['Overview', 'Configuration', 'Activity', 'Logs']} value={tab} onChange={t => go('deployments/' + d.id + (t === 'Overview' ? '' : '/' + t.toLowerCase()))}/>
    {tab === 'Overview' && <><div className="stats"><div className="stat"><span>VRAM</span><strong>{gib(process.gpu_mib)} <small>GiB</small></strong></div><div className="stat"><span>Context / request</span><strong>{number(profile.catalog?.model?.limit?.context, 0)}</strong></div><div className="stat"><span>Active requests</span><strong>{inflight}</strong></div></div>
      <div className="detail-grid"><section className="panel padded"><h2>Serving</h2><dl className="properties"><dt>API model</dt><dd className="copy-value"><code>{d.alias}</code><CopyButton value={d.alias} label="Copy API model"/></dd><dt>Client discovery</dt><dd>{visible(d) ? 'Available' : 'Not listed'}</dd><dt>Mode</dt><dd>{mode(d)}</dd>{d.residency === 'on-demand' && <><dt>Unload after idle</dt><dd>{d.idle_timeout ? d.idle_timeout + ' seconds' : 'Never'}</dd></>}<dt>Automatic eviction</dt><dd>{d.residency !== 'pinned' && d.allow_eviction ? 'Allowed when idle' : 'Not allowed'}</dd>{d.lifecycle?.last_stop_reason && <><dt>Last unload</dt><dd>{d.lifecycle.last_stop_reason}</dd></>}</dl></section>
      <section className="panel padded"><h2>Performance</h2><dl className="properties"><dt>Prefill (tok/s)</dt><dd>{number(rate('prompt_tokens_total', 'prompt_seconds_total'))}</dd><dt>Generation (tok/s)</dt><dd>{number(rate('tokens_predicted_total', 'tokens_predicted_seconds_total'))}</dd><dt>Process RAM (GiB)</dt><dd>{gib(process.rss_mib)}</dd><dt>CPU (%)</dt><dd>{number(process.cpu_percent)}</dd></dl><small className="muted">Runtime averages since loading.</small></section></div></>}
    {tab === 'Configuration' && <section className="panel padded"><button disabled={active(d)} onClick={() => actions.edit('deployments', d)}>Edit configuration</button>
      <dl className="properties"><dt>Model</dt><dd>{data.models?.find(m => m.id === profile.artifact_id)?.name || profile.artifact_id}</dd><dt>Engine</dt><dd>{data.runtimes?.find(r => r.id === profile.runtime_id)?.name || profile.runtime_id}</dd>{Object.entries(profile.config || {}).map(([k, v]) => <div className="property-pair" key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}</dl>
      <details><summary>Advanced</summary><dl className="properties"><dt>Private port</dt><dd>{d.port}</dd><dt>GPU</dt><dd>{d.gpu}</dd><dt>Priority</dt><dd>{d.priority}</dd><dt>VRAM reservation (MiB)</dt><dd>{d.reservation_mib || 'Estimated'}</dd><dt>Queue timeout (s)</dt><dd>{d.queue_timeout}</dd></dl><Json value={{arguments: profile.raw_args, capabilities: profile.catalog}}/></details>
    </section>}
    {tab === 'Activity' && <section className="panel"><ActivityFeed events={events.filter(e => e.deployment_id === d.id)} deployments={data.deployments || []}/></section>}
    {tab === 'Logs' && <section className="panel padded">{error && <p className="error-text" role="alert">{error}</p>}<pre className="logs" tabIndex={0}>{logs || 'Loading logs…'}</pre></section>}
  </>;
}

export function ModelLibrary({data, query, setQuery, create, inspect, addFromFile, discover}: {data: Registry; query: string; setQuery: (q: string) => void; create: (id: string) => void; inspect: (title: string, value: any) => void; addFromFile: () => void; discover: () => void}) {
  const [format, setFormat] = useState(''), [capability, setCapability] = useState(''), [selected, setSelected] = useState('');
  function chips(m: Row): string[] {
    const hints = m.discovered_capabilities || {};
    const params = parameterSize(m.repo || m.name);
    const quant = quantization(m.name);
    const quantLabel = quant.quant !== 'Other / default' ? quant.quant + (quant.suffix !== 'None' ? '_' + quant.suffix : '') : m.quantization;
    return [m.source === 'huggingface' ? 'Hugging Face' : 'Local file', m.format.toUpperCase(), params !== 'Unspecified' && params, quantLabel && `Quantization: ${quantLabel}`, m.architecture, byteSize(m.size_bytes), hints.reasoning && 'reasoning', hints.tools && 'tools', ...(hints.input || []).filter((v: string) => v !== 'text')].filter(Boolean);
  }
  const rows = (data.models || []).filter(m => [m.name, m.repo, m.architecture].filter(Boolean).join(' ').toLowerCase().includes(query.toLowerCase()) && (!format || m.format === format) && (!capability || chips(m).includes(capability)));
  const groups = new Map<string, Row[]>();
  for (const row of rows) {const key = row.repo ? `${row.source}:${row.repo}` : row.id; groups.set(key, [...(groups.get(key) || []), row]);}
  const current = data.models?.find(m => m.id === selected);
  const siblings = current ? (data.models || []).filter(m => current.repo ? m.repo === current.repo && m.source === current.source : m.id === current.id) : [];
  if (!data.models?.length) return <Empty title="No models yet"><div className="actions"><button className="primary" onClick={discover}>Discover models</button><button onClick={addFromFile}><Plus size={16}/>Add from File</button></div></Empty>;
  return <>
    <div className="toolbar"><input className="search" type="search" aria-label="Search installed models" placeholder="Search models…" value={query} onChange={e => setQuery(e.target.value)}/><select aria-label="Filter model format" value={format} onChange={e => setFormat(e.target.value)}><option value="">All formats</option>{[...new Set((data.models || []).map(m => m.format))].map(f => <option key={f}>{f}</option>)}</select><select aria-label="Filter model capability" value={capability} onChange={e => setCapability(e.target.value)}><option value="">All capabilities</option>{['reasoning', 'tools', 'image', 'audio', 'video'].map(c => <option key={c}>{c}</option>)}</select></div>
    <p className="muted">Capability badges are detected hints. Deployment settings control what clients see.</p>
    <div className="catalog-grid">{[...groups].map(([key, models]) => {
      const m = models[0];
      return <ModelCard key={key} name={m.repo || m.name} url={m.source === 'huggingface' && m.repo ? `https://huggingface.co/${m.repo}` : undefined} chips={models.length === 1 ? chips(m) : [...new Set(models.flatMap(chips))]} footer={`${models.length} installed variant${models.length === 1 ? '' : 's'}`}><div className="actions"><button onClick={() => models.length === 1 ? create(m.id) : setSelected(m.id)}>{models.length === 1 ? 'Create deployment' : 'Choose variant'}</button><button onClick={() => setSelected(m.id)}>Details</button></div></ModelCard>;
    })}</div>
    {!rows.length && <Empty title="No matching models"/>}
    {current && <Dialog title={current.repo || current.name} close={() => setSelected('')} wide>
      <label>Installed variant<select value={selected} onChange={e => setSelected(e.target.value)}>{siblings.map(m => <option key={m.id} value={m.id}>{m.name} · {byteSize(m.size_bytes)}</option>)}</select></label>
      <div className="catalog-chips">{chips(current).map(c => <span className="catalog-chip" key={c}>{c}</span>)}</div>
      <h3>Capabilities & dependencies</h3>
      <p>{current.discovered_capabilities?.evidence?.join('; ') || 'No conclusive capability metadata. Configure declarations in the deployment.'}</p><p>{current.discovered_capabilities?.note}</p>
      {current.discovered_capabilities?.dependencies?.map((d: Row) => <p key={d.name}>{d.name} — {current.metadata?.projector?.name === d.name ? 'Downloaded; confirm compatibility' : 'Candidate; compatibility unverified'}</p>)}
      <InspectModel key={current.id} id={current.id}/>
      <h3>Deployments</h3>{(data.deployments || []).filter(d => d.profile_snapshot?.artifact_id === current.id).map(d => <p key={d.id}><a href={`#/deployments/${d.id}`} onClick={() => setSelected('')}>{d.name}</a> · {d.state}</p>)}
      <details><summary>Local file</summary><code>{current.local_path}</code></details>
      <div className="dialog-actions"><button onClick={() => inspect(current.name, current)}>Inspect metadata</button><button className="primary" onClick={() => {setSelected(''); create(current.id);}}>Create deployment</button></div>
    </Dialog>}
  </>;
}

export function ActivityPage({tab, jobs, events, deployments, inspect, restore}: {tab: string; jobs: Row[]; events: Row[]; deployments: Row[]; inspect: (title: string, value: any) => void; restore: (path: string, notice: string) => void}) {
  const [sessions, setSessions] = useState<Row[]>([]), [requests, setRequests] = useState<Row[]>([]), [activations, setActivations] = useState<Row[]>([]), [selected, setSelected] = useState<string[]>([]), [error, setError] = useState('');
  useEffect(() => {let alive = true; const load = async () => {try {const path = tab === 'Sessions' ? 'sessions' : tab === 'Requests' ? 'requests' : tab === 'Launches' ? 'activations' : null; if (!path) return; const rows = await api('/api/history/' + path); if (alive) {({sessions: setSessions, requests: setRequests, activations: setActivations}[path]!)(rows); setError('');}} catch (e) {if (alive) setError(message(e));}}; void load(); const timer = setInterval(load, 5000); return () => {alive = false; clearInterval(timer);};}, [tab]);
  return <><Tabs items={['Events', 'Operations', 'Requests', 'Sessions', 'Launches']} value={tab} onChange={t => go('activity/' + t.toLowerCase())}/>{error && <p className="alert error" role="alert">{error}</p>}
    {tab === 'Events' && <section className="panel"><ActivityFeed events={events} deployments={deployments}/></section>}
    {tab === 'Operations' && <section className="panel">{jobs.length ? [...jobs].sort((a, b) => b.created_at - a.created_at).map(j => <div className="operation" key={j.id}><Status value={j.state.charAt(0) + j.state.slice(1).toLowerCase()}/><div><strong>{j.name}</strong><p className={j.error ? 'error-text' : 'muted'}>{j.error || j.progress}</p></div></div>) : <Empty title="No operations yet"/>}</section>}
    {tab === 'Requests' && <section className="panel table-wrap"><table><thead><tr><th>Model</th><th className="numeric">Latency (s)</th><th className="numeric">First token (s)</th><th className="numeric">Output tokens</th><th>Outcome</th></tr></thead><tbody>{requests.map(r => <tr key={r.id}><td>{r.data.model_alias}</td><td className="numeric">{number(r.data.latency, 2)}</td><td className="numeric">{number(r.data.ttft, 2)}</td><td className="numeric">{number(r.data.output_tokens, 0)}</td><td><button className="quiet" onClick={() => inspect('Request', r)}>{r.data.error ? 'Failed' : 'Complete'}</button></td></tr>)}</tbody></table>{!requests.length && <Empty title="No requests yet"/>}</section>}
    {tab === 'Sessions' && <><div className="toolbar"><button disabled={selected.length !== 2} onClick={() => inspect('Session comparison', sessions.filter(s => selected.includes(s.id)).map(s => ({deployment: s.deployment_snapshot.name, started: date(s.started_at), peak_gpu_mib: s.peak_gpu_mib, peak_ram_mib: s.peak_ram_mib, config: s.deployment_snapshot.profile_snapshot.config, outcome: s.outcome})))}>Compare {selected.length ? `(${selected.length}/2)` : ''}</button></div><section className="panel table-wrap"><table><thead><tr><th><span className="sr-only">Compare</span></th><th>Started</th><th>Deployment</th><th>Outcome</th><th className="numeric">Peak VRAM (GiB)</th><th/></tr></thead><tbody>{sessions.map(s => <tr key={s.id}><td><input type="checkbox" aria-label={'Compare ' + s.deployment_snapshot.name + ' ' + s.id} checked={selected.includes(s.id)} disabled={selected.length >= 2 && !selected.includes(s.id)} onChange={e => setSelected(e.target.checked ? [...selected, s.id] : selected.filter(id => id !== s.id))}/></td><td>{date(s.started_at)}</td><td>{s.deployment_snapshot.name}</td><td>{s.outcome}</td><td className="numeric">{gib(s.peak_gpu_mib)}</td><td><Menu label={'Session actions for ' + s.deployment_snapshot.name}><button onClick={() => inspect('Session', s)}>Details</button><button onClick={() => restore(`/api/history/sessions/${s.id}/restore`, 'Restore as an inactive deployment. Review it in Deployments → Inactive.')}>Restore deployment</button></Menu></td></tr>)}</tbody></table>{!sessions.length && <Empty title="No sessions yet"/>}</section></>}
    {tab === 'Launches' && <section className="panel">{activations.map(a => <div className="operation" key={a.id}><Status value={a.state}/><div><strong>{a.deployment_name || 'Deployment launch'}</strong><p className="muted">{date(a.started_at)}</p></div><button onClick={() => restore(`/api/history/activations/${a.id}/restore`, 'Restore as an inactive deployment. Review it in Deployments → Inactive.')}>Restore deployment</button></div>)}{!activations.length && <Empty title="No launches yet"/>}</section>}
  </>;
}

export function SettingsPage({tab, data, status, actions, policy, backup, install, pull}: {tab: string; data: Registry; status: Row; actions: Actions; policy: () => void; backup: () => void; install: () => void; pull: () => void}) {
  const [notice, setNotice] = useState('');
  async function removeEngine(runtime: Row) {
    if (!window.confirm(`Remove ${runtime.name} and its installed files? Referenced engines cannot be removed.`)) return;
    try {await api(`/api/registry/runtimes/${runtime.id}/delete?remove_files=true`, {}); setNotice('Engine removed.');}
    catch (e) {setNotice(message(e));}
  }
  return <><Tabs items={['Engines', 'Host', 'Recovery']} value={tab} onChange={t => go('settings/' + t.toLowerCase())}/>
    {tab === 'Engines' && <><EngineCatalog runtimes={data.runtimes || []}/><h2>Installed engines</h2>{notice && <p role="status">{notice}</p>}<div className="model-grid">{(data.runtimes || []).map(r => <section className="panel library-card" key={r.id}><span className="format-label">{r.managed ? 'Managed' : r.execution_kind}</span><h2>{r.name}</h2><p className="muted">{r.engine}</p><div className="card-actions"><button onClick={() => actions.inspect(r.name, r)}>Details</button><Menu label={'Actions for ' + r.name}><button onClick={() => actions.edit('runtimes', r)}>Edit</button>{r.managed ? <button onClick={() => removeEngine(r)}>Remove engine files</button> : <button onClick={() => actions.edit('runtimes', r, true)}>Duplicate</button>}</Menu></div></section>)}</div>{!data.runtimes?.length && <Empty title="No engines installed"/>}<details><summary>Advanced engine sources</summary><div className="toolbar"><button onClick={() => actions.edit('runtimes')}><Plus size={16}/>Register existing engine</button><button onClick={install}>Build from source</button><button onClick={pull}>Pull image</button></div></details></>}
    {tab === 'Host' && <section className="panel padded"><div className="section-heading"><h2>Capacity & history</h2><button onClick={policy}>Edit policy</button></div><dl className="properties"><dt>GPU reserve</dt><dd>{gib(status.settings?.gpu_headroom_mib)} GiB</dd><dt>RAM reserve</dt><dd>{gib(status.settings?.ram_headroom_mib)} GiB</dd><dt>Temperature limit</dt><dd>{status.settings?.temperature_limit} °C</dd><dt>Sampling</dt><dd>{status.settings?.sample_seconds} seconds</dd><dt>Detailed history</dt><dd>{status.settings?.retention_days} days</dd><dt>Summary history</dt><dd>{status.settings?.summary_days} days</dd></dl><a className="button" href="/metrics" target="_blank" rel="noreferrer">Prometheus metrics <ArrowUpRight size={14}/></a></section>}
    {tab === 'Recovery' && <section className="panel padded"><h2>Registry backup</h2><p className="muted">Includes configuration and history, not model files.</p><button onClick={backup}>Create backup</button><details><summary>Storage</summary><code className="path">{status.state_path}</code></details></section>}
  </>;
}
