import {Fragment, useEffect, useState} from 'react';
import {ArrowLeft, ChevronDown, ChevronRight} from 'lucide-react';
import {active, api, Dialog, Empty, Field, gib, Menu, message, mode, number, state, Status, Tabs, type Row, type Registry} from './ui';
import {ActivityFeed, go} from './Views';
import {ConfigurationFields, defaults, editable} from './Editors';
import {Duration, Placement} from './FormControls';
import {DraftResources, useResourcePreview} from './Resources';

export function unitVram(d: Row, host: Row): number | undefined {
  const members = (d.members || [d]).filter(active);
  const values = members.map((m: Row) => host.deployments?.[m.id]?.gpu_mib);
  return values.length && values.every((v: any) => typeof v === 'number') ? values.reduce((a: number, b: number) => a + b, 0) : undefined;
}
export function ServingTable({rows, host, actions, compact = false}: {rows: Row[]; host: Row; actions: any; compact?: boolean}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  function primary(d: Row) {
    if (!d.enabled) return <button onClick={() => actions.enable(d, true)}>Enable</button>;
    if (active(d) && d.state !== 'STOPPING') return <button onClick={() => actions.stop('serving-deployments', d)}>Unload</button>;
    return d.state !== 'STOPPING' ? <button onClick={() => actions.load('serving-deployments', d)}>Load</button> : null;
  }
  return <div className="table-wrap"><table className={'deployment-table ' + (compact ? 'compact' : '')}><thead><tr><th>Deployment</th><th>State</th><th>Mode</th><th className="numeric">VRAM (GiB)</th><th className="numeric">Requests</th>{!compact && <th><span className="sr-only">Actions</span></th>}</tr></thead><tbody>{rows.map(d => <Fragment key={d.id}><tr>
    <td><div className="deployment-name">{d.members?.length > 1 && <button className="expand-button" aria-label={(expanded.includes(d.id) ? 'Collapse ' : 'Expand ') + d.name} aria-expanded={expanded.includes(d.id)} onClick={() => setExpanded(s => s.includes(d.id) ? s.filter(id => id !== d.id) : [...s, d.id])}>{expanded.includes(d.id) ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</button>}<div><a className="row-link" href={'#/deployments/' + d.id}>{d.name}</a>{d.members?.length > 1 && <small className="muted">{d.members.length} models</small>}</div></div>{d.lifecycle?.failure && <small className="error-text">{d.lifecycle.failure}</small>}</td>
    <td><Status value={state(d)}/></td><td>{mode(d)}</td><td className="numeric">{gib(unitVram(d, host))}</td><td className="numeric">{d.inflight || 0}</td>
    {!compact && <td><div className="actions">{primary(d)}<Menu label={'Actions for ' + d.name}><button onClick={() => go('deployments/' + d.id)}>Details</button><div className="mobile-only">{primary(d)}</div><button disabled={active(d)} onClick={() => actions.edit(d.multi_model ? 'deployment_sets' : 'deployments', d)}>Edit</button>{!d.multi_model && <button onClick={() => actions.edit('deployments', d, true)}>Duplicate</button>}<button onClick={() => go('deployments/' + d.id + '/logs')}>Logs</button>{d.enabled && <button disabled={active(d)} onClick={() => actions.enable(d, false)}>Disable for clients</button>}</Menu></div></td>}
  </tr>{expanded.includes(d.id) && d.members?.map((member: Row) => <tr className="member-row" key={member.id}><td><a href={'#/deployments/' + d.id + '/models'}>{member.name}</a></td><td><Status value={state(member)}/></td><td/>
    <td className="numeric">{gib(host.deployments?.[member.id]?.gpu_mib)}</td><td className="numeric">{member.inflight || 0}</td>{!compact && <td/>}</tr>)}</Fragment>)}</tbody></table>{!rows.length && <Empty title="No matching deployments"/>}</div>;
}

const sharedKeys = ['residency', 'priority', 'idle_timeout', 'allow_eviction', 'allow_uncertain', 'enabled', 'queue_timeout'];
export function DeploymentSetEditor({initial, modelId, data, close, saved}: {initial?: Row; modelId?: string; data: Registry; close: () => void; saved: (id: string) => void}) {
  const [value, setValue] = useState<Row>({name: 'New deployment', residency: 'on-demand', priority: 50, idle_timeout: 300, allow_eviction: false, allow_uncertain: false, enabled: true, queue_timeout: 300, ...(initial ? Object.fromEntries(['id', 'name', ...sharedKeys].map(k => [k, initial[k]])) : {}), members: (initial?.members || []).map((m: Row) => editable('deployments', m))});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [separate, setSeparate] = useState(false);
  const [artifactId, setArtifactId] = useState(modelId || data.models?.[0]?.id || ''), [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState(0);
  const preview = useResourcePreview(value.members, data.host?.[0]?.ts);
  const [original] = useState(() => JSON.stringify(value));
  const changed = JSON.stringify(value) !== original || Object.values(invalid).some(Boolean);
  const leave = () => {if (busy) return; if (!changed || window.confirm('Discard unsaved changes?')) close();};
  useEffect(() => {const warn = (e: BeforeUnloadEvent) => {if (changed) {e.preventDefault(); e.returnValue = '';}}; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);}, [changed]);
  const aliasError = (m: Row) => value.members.some((other: Row) => other !== m && other.alias === m.alias) || (data.deployments || []).some(other => other.alias === m.alias && !value.members.some((member: Row) => member.id === other.id));
  const set = (key: string, v: any) => setValue(s => ({...s, [key]: v}));
  const updateMember = (index: number, change: Row) => setValue(v => ({...v, members: v.members.map((m: Row, i: number) => i === index ? {...m, ...change} : m)}));
  async function addModel() {
    const model = data.models?.find(m => m.id === artifactId);
    const runtime = data.runtimes?.find(r => r.capabilities?.formats?.includes(model?.format));
    if (!model || !runtime) {setError('Register a compatible engine for this model first.'); return;}
    const used = [...(data.deployments || []), ...value.members];
    const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'model';
    const base = slug(value.name) + '-' + slug(model.name).slice(0, 40);
    let alias = base, suffix = 2;
    while (used.some(m => m.alias === alias)) alias = base + '-' + suffix++;
    const port = Array.from({length: 50000}, (_, i) => 8120 + i).find(p => !used.some(m => m.port === p));
    const schema = runtime.capabilities?.schema || {};
    const config = Object.fromEntries(Object.entries(schema).filter(([, f]: [string, any]) => f.default !== undefined).map(([k, f]: [string, any]) => [k, ['threads', 'threads-batch'].includes(k) && data.host?.[0]?.cpu_count ? Math.min(f.default, data.host[0].cpu_count) : f.default]));
    const gpus = data.host?.[0]?.gpus || [];
    const gpu = [...gpus].sort((a: Row, b: Row) => (b.free_mib - (preview.data?.gpus?.find((g: Row) => g.index === b.index)?.draft_mib || 0)) - (a.free_mib - (preview.data?.gpus?.find((g: Row) => g.index === a.index)?.draft_mib || 0)))[0]?.index ?? 0;
    const member = {...defaults.deployments, name: model.name, alias, port, gpu, configuration: {name: model.name, artifact_id: model.id, runtime_id: runtime.id, config, raw_args: [], catalog: {}}};
    set('members', [...value.members, member]);
    setSelected(value.members.length);
    setError('');
    setBusy(true);
    try {
      const budget = await api('/api/resources/preview', {members: [...value.members, member]});
      const rec = budget.members.at(-1)?.recommendation;
      if (rec?.context_default != null) setValue(v => ({...v, members: v.members.map((m: Row) => m.port === port && JSON.stringify(m.configuration.config) === JSON.stringify(config) ? {...m, configuration: {...m.configuration, config: {...config, [rec.context_key]: rec.context_default}}} : m)}));
    } catch { /* Keep engine defaults when telemetry/preview is unavailable; the preview explains the gap. */ }
    finally {setBusy(false);}
  }
  const submit = async () => {setBusy(true); setError(''); try {
    const single = !initial && value.members.length === 1;
    const path = (single ? '/api/deployments' : '/api/deployment-sets') + (initial ? '?expected=' + initial.revision : '');
    const payload = single ? {...value.members[0], name:value.name, ...Object.fromEntries(sharedKeys.map(k => [k, value[k]]))} : value;
    const result = await api(path, payload); saved(result.id);
  } catch (e) {setError(message(e));} finally {setBusy(false);}};
  return <Dialog title={initial ? initial.name : 'New deployment'} close={leave} busy={busy} wide editor guardChanges={false}>
    {error && <p className="alert error" role="alert">{error}</p>}
    <form className="resource-editor" onInvalidCapture={e => {const target = e.target as HTMLElement; const section = target.closest<HTMLElement>('[data-model-index]'); if (section) setSelected(Number(section.dataset.modelIndex)); target.closest('details')?.setAttribute('open', '');}} onSubmit={e => {e.preventDefault(); void submit();}}><fieldset disabled={busy}>
      <Field label="Name"><input required value={value.name} onChange={e => set('name', e.target.value)}/></Field>
      <fieldset className="model-composer"><legend>Models</legend>
        <Field label="Add installed model"><select value={artifactId} onChange={e => setArtifactId(e.target.value)}>{(data.models || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field><button type="button" disabled={!artifactId} onClick={addModel}>Add model</button>
        <div className="model-switcher" role="group" aria-label="Models">{value.members.map((m: Row, index: number) => <button key={m.id || m.port} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}>{m.name || `Model ${index + 1}`}{invalid[m.id || m.port] || aliasError(m) ? ' · Check settings' : ''}</button>)}</div>
        {value.members.map((m: Row, index: number) => <section hidden={selected !== index} data-model-index={index} className="model-edit-section" key={m.id || m.port}>
          <h3>{m.name}</h3><Field label="Model display name"><input required value={m.name} onChange={e => updateMember(index, {name: e.target.value})}/></Field>
          <Field label="API model ID"><input required aria-label="API model ID" aria-invalid={aliasError(m)} pattern="[a-zA-Z0-9][a-zA-Z0-9_.\/\-]{0,159}" value={m.alias} onChange={e => updateMember(index, {alias: e.target.value})}/>{aliasError(m) && <small className="error-text" role="alert">This API model ID is already in use.</small>}</Field>
          <ConfigurationFields value={m.configuration} data={data} set={configuration => updateMember(index, {configuration})} onValid={valid => setInvalid(v => ({...v, [m.id || m.port]: !valid}))} recommendation={preview.data?.members?.[index]?.recommendation}/>
          <details><summary>Placement</summary><Placement value={m} change={v => updateMember(index, v)} host={data.host?.[0]}/></details>
          <button type="button" className="danger subtle" onClick={() => {if (m.id && !window.confirm('Remove this model from the deployment? It will be kept as an inactive standalone configuration.')) return; set('members', value.members.filter((_: Row, i: number) => i !== index)); setSelected(Math.max(0, selected - 1)); setInvalid(v => ({...v, [m.id || m.port]: false}));}}>Remove model</button>
        </section>)}
      </fieldset>
      <Field label="Mode"><select value={value.residency} onChange={e => set('residency', e.target.value)}><option value="on-demand">On demand</option><option value="pinned">Pinned</option><option value="evictable">Evictable</option></select></Field>
      {value.residency === 'on-demand' && <Duration value={value.idle_timeout} change={v => set('idle_timeout', v)}/>}
      {value.residency !== 'pinned' && <label className="check"><input type="checkbox" checked={value.allow_eviction} onChange={e => set('allow_eviction', e.target.checked)}/>Can unload to make room for another deployment</label>}
      {value.residency === 'on-demand' && <label className="check"><input type="checkbox" checked={value.allow_uncertain} onChange={e => set('allow_uncertain', e.target.checked)}/>Allow on-demand loading with uncertain memory estimates</label>}
      <details><summary>Advanced</summary><div className="form-grid"><Field label="Priority"><input required type="number" min={0} max={100} value={value.priority} onChange={e => set('priority', Number(e.target.value))}/></Field><Field label="Switch timeout (seconds)"><input required type="number" min={1} max={1800} value={value.queue_timeout} onChange={e => set('queue_timeout', Number(e.target.value))}/></Field></div><label className="check"><input type="checkbox" checked={value.enabled} onChange={e => set('enabled', e.target.checked)}/>Enabled for clients</label></details>
    </fieldset>{value.members.length > 0 && <DraftResources preview={preview.data} error={preview.error}/>}<div className="dialog-actions">{initial && value.members.length > 1 && <button type="button" className="danger subtle" disabled={busy} onClick={() => setSeparate(true)}>Separate models…</button>}<button className="primary" disabled={busy || value.members.length < 1 || value.members.some(aliasError) || Object.values(invalid).some(Boolean)}>{busy ? 'Saving…' : 'Save deployment'}</button></div></form>
    {separate && <section className="warning"><p>Make each model a standalone deployment? Current shared policies will be kept.</p><button className="danger" disabled={busy} onClick={async () => {setBusy(true); try {await api(`/api/deployment-sets/${initial!.id}/dissolve?expected=${initial!.revision}`, {}); saved('');} catch (e) {setError(message(e));} finally {setBusy(false);}}}>Separate models</button></section>}
  </Dialog>;
}

export function MultiDeploymentDetail({d, tab, data, host, actions, events}: {d: Row; tab: string; data: Registry; host: Row; actions: any; events: Row[]}) {
  const [logMember, setLogMember] = useState(d.member_ids[0]), [logs, setLogs] = useState(''), [error, setError] = useState('');
  useEffect(() => {if (tab !== 'Logs') return; let alive = true; const load = () => api(`/api/deployments/${logMember}/logs`).then(r => {if (alive) {setLogs(r.text); setError('');}}).catch(e => {if (alive) setError(message(e));}); setLogs(''); void load(); const timer = setInterval(load, 2000); return () => {alive = false; clearInterval(timer);};}, [logMember, tab]);
  return <><a className="back-link" href="#/deployments"><ArrowLeft size={16}/>Deployments</a><div className="page-head"><div><h1>{d.name}</h1><Status value={state(d)}/></div><div className="actions">{!active(d) && d.enabled && <button className="primary" onClick={() => actions.load('serving-deployments', d)}>Load</button>}{active(d) && d.state !== 'STOPPING' && <button onClick={() => actions.stop('serving-deployments', d)}>Unload</button>}<button disabled={active(d)} onClick={() => actions.edit('deployment_sets', d)}>Edit</button></div></div>
    {d.lifecycle?.failure && <p role="alert" className="alert error">{d.lifecycle.failure}</p>}
    <Tabs items={['Models', 'Policy', 'Activity', 'Logs']} value={tab} onChange={t => go(`deployments/${d.id}/${t.toLowerCase()}`)}/>
    {tab === 'Models' && <><div className="stats"><div className="stat"><span>Models ready</span><strong>{d.members.filter((m: Row) => m.state === 'READY').length} <small>/ {d.members.length}</small></strong></div><div className="stat"><span>VRAM</span><strong>{gib(unitVram(d, host))} <small>GiB</small></strong></div><div className="stat"><span>Active requests</span><strong>{d.inflight || 0}</strong></div></div><div className="model-grid">{d.members.map((m: Row) => <section className="panel library-card" key={m.id}><Status value={state(m)}/><h2>{m.name}</h2><dl className="properties"><dt>API model</dt><dd><code>{m.alias}</code></dd><dt>Context / request</dt><dd>{number(m.profile_snapshot?.catalog?.model?.limit?.context, 0)}</dd><dt>VRAM (GiB)</dt><dd>{gib(host.deployments?.[m.id]?.gpu_mib)}</dd></dl><div className="card-actions"><button disabled={active(d)} onClick={() => actions.edit('deployments', {...m, unit_id: d.id, member_only: true})}>Edit model</button><button onClick={() => {setLogMember(m.id); go(`deployments/${d.id}/logs`);}}>Logs</button></div></section>)}</div></>}
    {tab === 'Policy' && <section className="panel padded"><dl className="properties"><dt>Mode</dt><dd>{mode(d)}</dd>{d.residency === 'on-demand' && <><dt>Unload after idle</dt><dd>{d.idle_timeout ? `${d.idle_timeout} seconds` : 'Never'}</dd></>}<dt>Automatic eviction</dt><dd>{d.residency !== 'pinned' && d.allow_eviction ? 'Allowed' : 'Not allowed'}</dd><dt>Priority</dt><dd>{d.priority}</dd><dt>Client discovery</dt><dd>{d.lifecycle?.serving ? 'Available' : 'Not listed'}</dd><dt>Switch timeout</dt><dd>{d.queue_timeout} seconds</dd></dl></section>}
    {tab === 'Activity' && <section className="panel"><ActivityFeed events={events.filter(e => e.deployment_id === d.id || d.member_ids.includes(e.deployment_id))} deployments={[...data.deployments || [], d]}/></section>}
    {tab === 'Logs' && <section className="panel padded"><Field label="Model"><select value={logMember} onChange={e => setLogMember(e.target.value)}>{d.members.map((m: Row) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>{error && <p role="alert" className="error-text">{error}</p>}<pre tabIndex={0}>{logs || 'Loading logs…'}</pre></section>}
  </>;
}
