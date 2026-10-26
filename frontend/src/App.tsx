import {useCallback, useEffect, useState} from 'react';
import {Activity, ArrowUpRight, Boxes, Check, Database, Layers, Plus, RefreshCw, Settings, X} from 'lucide-react';
import {ModelCatalog} from './ModelCatalog';
import {DeploymentWizard} from './DeploymentWizard';
import {editable, Editor} from './Editors';
import {Connect, LaunchReview, PolicyEditor, SourceBuild} from './Operations';
import {DeploymentSetEditor, MultiDeploymentDetail, ServingTable} from './ServingDeployments';
import {ActivityFeed, ActivityPage, DeploymentDetail, go, MemoryChart, ModelLibrary, SettingsPage} from './Views';
import {active, api, Dialog, Empty, Field, gib, Json, message, number, Tabs, type Registry, type Row} from './ui';

const navigation = [{id: 'overview', label: 'Overview', icon: Activity}, {id: 'models', label: 'Models', icon: Database}, {id: 'deployments', label: 'Deployments', icon: Layers}, {id: 'activity', label: 'Activity', icon: RefreshCw}, {id: 'settings', label: 'Settings', icon: Settings}];
const titleCase = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
function useRoute() {
  const [route, setRoute] = useState(() => window.location.hash.slice(2).split('/'));
  useEffect(() => {const change = () => setRoute(window.location.hash.slice(2).split('/')); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change);}, []);
  return route;
}
export default function App() {
  const route = useRoute(), page = route[0] || 'overview';
  const [status, setStatus] = useState<Row>({}), [data, setData] = useState<Registry>({}), [samples, setSamples] = useState<Row[]>([]), [events, setEvents] = useState<Row[]>([]);
  const [connection, setConnection] = useState(false), [loading, setLoading] = useState(true), [fetchError, setFetchError] = useState('');
  const [modal, setModal] = useState<Row | null>(null), [modalError, setModalError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''), [endpoint, setEndpoint] = useState('');
  const refresh = useCallback(async () => {
    const [s, ...rows] = await Promise.all([api('/api/status'), ...['models', 'runtimes', 'profiles', 'deployments', 'jobs'].map(n => api('/api/registry/' + n))]);
    setStatus(s); setData({...Object.fromEntries(['models', 'runtimes', 'profiles', 'deployments', 'jobs'].map((n, i) => [n, rows[i]])), host: [s.host || {}], ...(s.serving_deployments ? {serving: s.serving_deployments} : {})}); if (s.gateway_url) setEndpoint(s.gateway_url); setFetchError(''); setLoading(false);
  }, []);
  useEffect(() => {
    let alive = true, pending = false;
    const poll = async () => {if (pending) return; pending = true; try {await refresh();} catch {if (alive) {setFetchError('Connection lost. Displayed data may be out of date.'); setLoading(false);}} finally {pending = false;}};
    void poll(); const timer = setInterval(poll, 5000);
    api('/api/integration/opencode').then(r => {if (alive) setEndpoint(r.endpoint);}).catch(() => {});
    api('/api/history/metrics?hours=1').then(r => {if (alive) setSamples(r);}).catch(() => {});
    const stream = new EventSource('/api/events/stream'); stream.onopen = () => setConnection(true); stream.onerror = () => setConnection(false);
    stream.addEventListener('telemetry', e => {const host = JSON.parse((e as MessageEvent).data); setStatus(s => ({...s, host})); setSamples(s => [...s.slice(-499), host]);});
    stream.addEventListener('operation', e => {const event = JSON.parse((e as MessageEvent).data); setEvents(s => s.some(old => old.seq === event.seq) ? s : [event, ...s].slice(0, 200));});
    return () => {alive = false; clearInterval(timer); stream.close();};
  }, [refresh]);
  useEffect(() => {setQuery(''); document.title = (navigation.find(n => n.id === page)?.label || 'Menagerie') + ' · Menagerie';}, [page]);
  useEffect(() => {if (!notice) return; const timer = setTimeout(() => setNotice(''), 7000); return () => clearTimeout(timer);}, [notice]);
  useEffect(() => {
    if (modal?.type !== 'revisions') return;
    let alive = true;
    api(`/api/profiles/${modal.row.id}/revisions`).then(value => {if (alive) setModal(m => m ? {...m, value} : m);}).catch(e => {if (alive) setModalError(message(e));});
    return () => {alive = false;};
  }, [modal?.type, modal?.row?.id]);
  const open = (value: Row | null) => {setModalError(''); setModal(value);};
  const close = () => {if (!busy) open(null);};
  const reload = () => refresh().catch(() => setFetchError('Could not refresh. Displayed data may be out of date.'));
  const completed = (text = '') => {open(null); if (text) setNotice(text); void reload();};
  async function perform(action: () => Promise<any>, text = '', dismiss = true) {
    setBusy(true); setModalError('');
    try {const result = await action(); if (dismiss) completed(text); else {if (text) setNotice(text); void reload();} return result;}
    catch (e) {setModalError(message(e)); return null;} finally {setBusy(false);}
  }
  const deployments = data.deployments || [], jobs = data.jobs || [], host = status.host || {};
  const serving = data.serving || deployments.map(d => ({...d, members: [d], member_ids: [d.id], inflight: status.deployments?.find((m: Row) => m.id === d.id)?.inflight || 0}));
  const enabled = serving.filter(d => d.enabled), inactive = serving.filter(d => !d.enabled), running = deployments.filter(d => d.state === 'READY');
  const edit = (kind: string, row?: Row, clone = false) => {
    if (kind === 'deployment_sets') {open({type: 'deployment-set', row}); return;}
    const value = editable(kind, row, clone);
    if (kind === 'deployments' && clone) {
      const ports = new Set(deployments.map(d => d.port));
      value.port = Array.from({length: 50000}, (_, i) => 8120 + i).find(p => !ports.has(p));
      value.enabled = false;
    }
    if (!row && kind === 'profiles') {
      value.artifact_id = data.models?.[0]?.id || ''; value.runtime_id = data.runtimes?.[0]?.id || '';
      const schema = data.runtimes?.[0]?.capabilities?.schema || {};
      value.config = Object.fromEntries(Object.entries(schema).filter(([, field]: [string, any]) => field.default !== undefined).map(([key, field]: [string, any]) => [key, field.default]));
    }
    open({type: 'edit', kind, value, memberOnly: row?.member_only, expected: clone ? undefined : row?.revision});
  };
  const inspect = (title: string, value: any) => open({type: 'inspect', title, value});
  const actions = {
    edit, inspect,
    revisions: (row: Row) => open({type: 'revisions', title: row.name + ' revisions', row}),
    load: (kind: string, row: Row) => open({type: 'launch', kind: kind === 'deployments' && data.serving ? 'serving-deployments' : kind === 'serving-deployments' && !data.serving ? 'deployments' : kind, row}),
    stop: (kind: string, row: Row) => open({type: 'stop', kind: kind === 'deployments' && data.serving ? 'serving-deployments' : kind === 'serving-deployments' && !data.serving ? 'deployments' : kind, row}),
    enable: (row: Row, enabled: boolean) => open({type: 'enable', row, enabled}),
  };
  const newDeployment = (modelId?: string) => {if (!data.models?.length) {go('models'); return;} open({type: 'deployment-set', modelId});};
  const depView = route[1] || 'enabled', detail = page === 'deployments' && !['enabled', 'inactive'].includes(depView);
  const selected = detail ? serving.find(d => d.id === depView || d.member_ids?.includes(depView)) : undefined;
  const modelTab = route[1] === 'discover' ? 'Discover' : 'Installed';
  const activityTab = ['events', 'operations', 'requests', 'sessions', 'launches'].includes(route[1]) ? titleCase(route[1]) : 'Events';
  const settingsTab = ['engines', 'host', 'recovery'].includes(route[1]) ? titleCase(route[1]) : 'Engines';
  const busyJobs = jobs.filter(j => ['QUEUED', 'RUNNING'].includes(j.state));
  return <div className="shell">
    <a className="skip-link" href="#main" onClick={e => {e.preventDefault(); document.getElementById('main')?.focus();}}>Skip to content</a>
    <aside className="sidebar"><a className="brand" href="#/overview"><Boxes size={27}/><span>menagerie</span></a><nav aria-label="Main navigation">{navigation.map(n => <a key={n.id} href={'#/' + n.id} aria-current={page === n.id ? 'page' : undefined} className={page === n.id ? 'selected' : ''}><n.icon size={19}/><span>{n.label}</span>{n.id === 'activity' && busyJobs.length > 0 && <b>{busyJobs.length}</b>}</a>)}</nav><div className="connection"><i className={connection && !fetchError ? 'online' : ''}/>{connection && !fetchError ? 'Connected' : 'Reconnecting'}</div></aside>
    <main id="main" tabIndex={-1}>
      {fetchError && <div className="alert error" role="alert">{fetchError}<button onClick={() => void reload()}>Retry</button></div>}
      {notice && <div className="toast" role="status"><Check size={16}/><span>{notice}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={16}/></button></div>}
      {!detail && <div className="page-head"><h1>{navigation.find(n => n.id === page)?.label || 'Page not found'}</h1><div className="actions">{page === 'overview' && <button onClick={() => open({type: 'connect'})}>Connect client <ArrowUpRight size={16}/></button>}{page === 'models' && <button onClick={() => open({type: 'import', path: ''})}><Plus size={16}/>Import</button>}{page === 'deployments' && <button className="primary" onClick={() => newDeployment()}><Plus size={16}/>New deployment</button>}</div></div>}
      {loading ? <Empty title="Loading workspace…"/> : <>
        {host.pressure && <div className="alert error" role="alert">Low memory headroom. Review running deployments.</div>}
        {page === 'overview' && <>
          <div className="stats">{(host.gpus || []).map((g: Row, index: number) => <div className="stat" key={g.index ?? index}><span>{host.gpus.length > 1 ? `GPU ${g.index ?? index} memory` : 'GPU memory'}</span><strong>{gib(g.used_mib)} <small>/ {gib(g.total_mib)} GiB</small></strong><meter aria-label={'GPU ' + (g.index ?? index) + ' memory used'} value={g.used_mib || 0} max={g.total_mib || 1}/></div>)}<div className="stat"><span>Available models</span><strong>{deployments.filter(d => d.lifecycle?.serving).length}</strong><small>{running.length} loaded</small></div><div className="stat"><span>System RAM</span><strong>{typeof host.ram_total_mib === 'number' && typeof host.ram_available_mib === 'number' ? gib(host.ram_total_mib - host.ram_available_mib) : '—'} <small>GiB</small></strong><small>{gib(host.ram_available_mib)} GiB available</small></div></div>
          <div className="section-heading"><h2>Deployments</h2><a href="#/deployments">View all <ArrowUpRight size={14}/></a></div><section className="panel">{enabled.length ? <ServingTable rows={enabled} host={host} actions={actions} compact/> : <Empty title={data.models?.length ? 'No enabled deployments' : 'Add your first model'}><button className="primary" onClick={() => data.models?.length ? newDeployment() : go('models/discover')}>{data.models?.length ? 'Create deployment' : 'Discover models'}</button>{!data.models?.length && <button onClick={() => open({type: 'import', path: ''})}>Import local files</button>}</Empty>}</section>
          <div className="section-heading"><h2>Activity</h2><a href="#/activity">View all <ArrowUpRight size={14}/></a></div><section className="panel"><ActivityFeed events={events.filter(e => !['QUEUED', 'VALIDATING', 'STARTING', 'LOADING', 'STOPPING'].includes(e.data?.to)).slice(0, 4)} deployments={deployments}/></section>
          <MemoryChart samples={samples}/>
          <details className="panel padded"><summary>Hardware</summary><div className="hardware-grid">{(host.gpus || []).map((g: Row, i: number) => <dl className="properties" key={g.index ?? i}><dt>GPU {g.index ?? i}</dt><dd>{g.name}</dd><dt>Utilization</dt><dd>{number(g.utilization, 0)}%</dd><dt>Temperature</dt><dd>{number(g.temperature, 0)} °C</dd><dt>Power</dt><dd>{number(g.power_w, 0)} W</dd></dl>)}</div><dl className="properties"><dt>Disk free</dt><dd>{number(host.disk_free_gib)} GiB</dd><dt>CPU</dt><dd>{number(host.cpu_percent)}%</dd><dt>Swap used</dt><dd>{gib(host.swap_used_mib)} GiB</dd></dl><details><summary>GPU processes</summary><Json value={host.processes || []}/></details></details>
        </>}
        {page === 'models' && <><Tabs items={['Installed', 'Discover']} value={modelTab} onChange={t => go('models/' + t.toLowerCase())}/>{modelTab === 'Installed' ? <ModelLibrary data={data} query={query} setQuery={setQuery} create={newDeployment} inspect={(title, value) => open({type: 'model', title, value})} importModel={() => open({type: 'import', path: ''})} discover={() => go('models/discover')}/> : <ModelCatalog api={api} queued={() => {setNotice('Download queued'); void reload();}}/>}</>}
        {page === 'deployments' && (detail ? selected ? selected.multi_model ? <MultiDeploymentDetail key={selected.id} d={selected} tab={['policy', 'activity', 'logs'].includes(route[2]) ? titleCase(route[2]) : 'Models'} data={data} host={host} actions={actions} events={events}/> : <DeploymentDetail key={selected.id} d={selected} tab={['configuration', 'activity', 'logs'].includes(route[2]) ? titleCase(route[2]) : 'Overview'} data={data} host={host} inflight={selected.inflight || 0} actions={actions} events={events}/> : <Empty title="Deployment not found"><a className="button" href="#/deployments">Back to deployments</a></Empty> : <>
            <Tabs items={[`Enabled (${enabled.length})`, `Inactive (${inactive.length})`]} value={depView === 'inactive' ? `Inactive (${inactive.length})` : `Enabled (${enabled.length})`} onChange={t => go('deployments/' + t.split(' ')[0].toLowerCase())}/>
            <input className="search" type="search" aria-label="Search deployments" placeholder="Search deployments…" value={query} onChange={e => setQuery(e.target.value)}/><section className="panel">{(depView === 'inactive' ? inactive : enabled).length ? <ServingTable rows={(depView === 'inactive' ? inactive : enabled).filter(d => (d.name + ' ' + (d.members || [d]).map((m: Row) => m.alias + ' ' + m.name).join(' ')).toLowerCase().includes(query.toLowerCase()))} host={host} actions={actions}/> : <Empty title={depView === 'inactive' ? 'No inactive deployments' : 'No enabled deployments'}/>}</section>
        </>)}
        {page === 'activity' && <ActivityPage tab={activityTab} jobs={jobs} events={events} deployments={deployments} inspect={inspect} restore={(path, text) => open({type: 'restore', path, text})}/>}
        {page === 'settings' && <SettingsPage tab={settingsTab} data={data} status={status} actions={actions} policy={() => open({type: 'policy'})} backup={() => open({type: 'backup'})} install={() => open({type: 'source'})} pull={() => open({type: 'edit', kind: 'runtimes', pull: true, value: {...editable('runtimes'), name: 'vLLM container', engine: 'vllm', execution_kind: 'docker'}})}/>}
      </>}
      {busyJobs.length > 0 && <a className="operation-indicator" href="#/activity/operations"><RefreshCw size={14} className="spin"/>{busyJobs.length === 1 ? busyJobs[0].name : `${busyJobs.length} operations running`}<ArrowUpRight size={14}/></a>}
    </main>
    {modal?.type === 'wizard' && <DeploymentWizard data={data} modelId={modal.modelId} close={close} setupEngine={() => {close(); go('settings/engines');}} created={(row, load) => {void reload(); go('deployments/' + row.id); open(load ? {type: 'launch', kind: 'deployments', row} : null); if (!load) setNotice('Deployment created');}}/>}
    {modal?.type === 'launch' && <LaunchReview modal={modal} deployments={deployments} host={host} close={close} done={() => completed('Launch queued')}/>}
    {modal?.type === 'connect' && <Connect endpoint={endpoint} deployments={deployments} close={close}/>}
    {modal?.type === 'source' && <SourceBuild close={close} done={() => completed('Build queued')}/>}
    {modal?.type === 'deployment-set' && <DeploymentSetEditor initial={modal.row} modelId={modal.modelId} data={data} close={close} saved={id => {completed('Deployment saved'); go(id ? 'deployments/' + id : 'deployments');}}/>}
    {modal && !['wizard', 'launch', 'connect', 'source', 'deployment-set'].includes(modal.type) && <Dialog title={modal.type === 'new-deployment' ? 'New deployment' : modal.type === 'edit' ? modal.memberOnly ? 'Edit model' : (modal.value.id ? 'Edit ' : modal.pull ? 'Pull ' : 'New ') + ({runtimes: 'engine', profiles: 'profile', deployments: 'deployment'} as Row)[modal.kind] : modal.type === 'stop' ? 'Unload ' + modal.row.name + '?' : modal.type === 'enable' ? (modal.enabled ? 'Enable ' : 'Disable ') + modal.row.name + '?' : modal.type === 'delete' ? 'Remove ' + modal.value.name + '?' : modal.type === 'import' ? 'Import local files' : modal.type === 'policy' ? 'Host policy' : modal.type === 'purge' ? 'Purge telemetry' : modal.type === 'backup' ? 'Registry backup' : modal.type === 'restore' ? 'Restore configuration?' : modal.title || 'Details'} close={close} busy={busy} editor={modal.type === 'edit' || modal.type === 'policy'} wide={['inspect', 'model', 'edit'].includes(modal.type)}>
      {modalError && <p className="alert error" role="alert">{modalError}</p>}
      {modal.type === 'new-deployment' && <div className="creation-options"><button onClick={() => open({type: 'wizard'})}>Single model</button><button onClick={() => open({type: 'deployment-set'})}>Multiple models</button></div>}
      {modal.type === 'edit' && <Editor key={modal.kind + (modal.value.id || 'new')} kind={modal.kind} initial={modal.value} data={data} busy={busy} memberOnly={modal.memberOnly} save={value => void perform(() => api(modal.pull ? '/api/runtimes/pull' : '/api/' + modal.kind + (modal.expected ? '?expected=' + modal.expected : ''), value), modal.pull ? 'Image pull queued' : 'Saved')} remove={modal.value.id && !modal.memberOnly ? () => open({...modal, type: 'delete'}) : undefined}/>}
      {modal.type === 'delete' && <><p>Remove the registry entry? Model files and history will be kept.</p><div className="dialog-actions"><button onClick={() => open({...modal, type: 'edit'})}>Back</button><button className="danger" disabled={busy} onClick={() => void perform(() => api(`/api/registry/${modal.kind}/${modal.value.id}/delete`, {}), 'Entry removed')}>Remove entry</button></div></>}
      {modal.type === 'stop' && <><p>Unloads every model in this deployment and discards its KV caches. Active requests finish first.</p>{modal.row.residency === 'on-demand' && <p className="muted">It stays enabled. The next client request can load it again.</p>}<div className="dialog-actions"><button disabled={busy} onClick={close}>Cancel</button><button className="danger" disabled={busy} onClick={() => void perform(() => api(`/api/${modal.kind}/${modal.row.id}/stop`, {}), 'Unload queued')}>Unload</button></div></>}
      {modal.type === 'enable' && <><p>{modal.enabled ? 'Enable this deployment for clients? It will not load immediately.' : 'Remove this deployment’s models from client discovery? Their configuration will be kept.'}</p><div className="dialog-actions"><button onClick={close}>Cancel</button><button className="primary" disabled={busy} onClick={() => void perform(() => api(`/api/${data.serving ? 'serving-deployments' : 'deployments'}/${modal.row.id}/enabled`, {enabled: modal.enabled}), modal.enabled ? 'Deployment enabled' : 'Deployment disabled')}>{modal.enabled ? 'Enable' : 'Disable'}</button></div></>}
      {modal.type === 'import' && <form onSubmit={e => {e.preventDefault(); void perform(() => api('/api/models/import', {path: modal.path}), 'Import queued');}}><Field label="Path on the Menagerie host" hint="GGUF file or safetensors directory. Files stay in place."><input autoFocus required placeholder="/path/to/model.gguf" value={modal.path} onChange={e => setModal({...modal, path: e.target.value})}/></Field><div className="dialog-actions"><button className="primary" disabled={busy || !modal.path}>Import</button></div></form>}
      {modal.type === 'inspect' && <StructuredDetails value={modal.value}/>}
      {modal.type === 'revisions' && (modal.value ? <StructuredDetails value={modal.value}/> : <p className="muted">Loading revisions…</p>)}
      {modal.type === 'model' && <><dl className="properties">{[['Format', modal.value.format], ['Architecture', modal.value.architecture], ['Size (GiB)', number(modal.value.size_bytes / 1024 ** 3)], ['Source', modal.value.source], ['Path', modal.value.local_path], ['Checksum', modal.value.sha256 ? 'Verified' : 'Not verified']].map(([label, value]) => <div className="property-pair" key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}</dl><details><summary>Provenance</summary><Json value={modal.value}/></details><div className="dialog-actions"><button className="primary" onClick={() => newDeployment(modal.value.id)}>Create deployment</button></div></>}
      {modal.type === 'policy' && <PolicyEditor initial={status.settings || {}} busy={busy} save={value => void perform(() => api('/api/settings', value), 'Policy saved')} purge={() => open({type: 'purge', days: 7})}/>}
      {modal.type === 'purge' && <form onSubmit={e => {e.preventDefault(); void perform(() => api('/api/history/purge', {older_than_days: modal.days, confirm: true}), 'Telemetry purged');}}><Field label="Remove telemetry older than (days)"><input type="number" required min={1} max={365} value={modal.days} onChange={e => setModal({...modal, days: Number(e.target.value)})}/></Field><p>Configuration, sessions, model files, and operational events will be kept.</p><div className="dialog-actions"><button className="danger" disabled={busy}>Purge telemetry</button></div></form>}
      {modal.type === 'backup' && <><p>Back up the registry, including configuration and history. Model files are not included.</p>{modal.path ? <p className="path" role="status">Saved to {modal.path}</p> : <div className="dialog-actions"><button className="primary" disabled={busy} onClick={async () => {const result = await perform(() => api('/api/backup', {}), '', false); if (result) setModal({...modal, path: result.path});}}>Create backup</button></div>}</>}
      {modal.type === 'restore' && <><p>{modal.text}</p><div className="dialog-actions"><button className="primary" disabled={busy} onClick={() => void perform(() => api(modal.path, {}), modal.text)}>Restore</button></div></>}
    </Dialog>}
  </div>;
}

function StructuredDetails({value}: {value: any}) {
  if (Array.isArray(value)) return <>{value.map((v, i) => <section className="comparison-section" key={i}><h3>{v.deployment || v.name || `Record ${i + 1}`}</h3><StructuredDetails value={v}/></section>)}</>;
  if (!value || typeof value !== 'object') return <p>{String(value ?? '—')}</p>;
  return <><dl className="properties">{Object.entries(value).filter(([, v]) => v === null || typeof v !== 'object').map(([k, v]) => <div className="property-pair" key={k}><dt>{k.replaceAll('_', ' ')}</dt><dd>{typeof v === 'boolean' ? v ? 'Yes' : 'No' : String(v ?? '—')}</dd></div>)}</dl>{Object.entries(value).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => <details key={k}><summary>{k.replaceAll('_', ' ')}</summary><StructuredDetails value={v}/></details>)}</>;
}
