import {Alert, AlertDescription} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Table, TableHeader, TableRow, TableHead, TableBody, TableCell} from '@/components/ui/table';
import {DropdownMenuItem} from '@/components/ui/dropdown-menu';
import {FieldSet, FieldLegend, FieldGroup} from '@/components/ui/field';
import {Input} from '@/components/ui/input';
import {NativeSelect, NativeSelectOption} from '@/components/ui/native-select';
import {Checkbox} from '@/components/ui/checkbox';
import {Card, CardHeader, CardDescription, CardContent} from '@/components/ui/card';
import {Fragment, useEffect, useState} from 'react';
import {ArrowLeft, ChevronDown, ChevronRight} from 'lucide-react';
import {active, api, Dialog, Empty, Field, gib, Menu, message, mode, number, state, Status, Tabs, type Row, type Registry} from './ui';
import {ActivityFeed, go} from './Views';
import {ConfigurationFields, defaults, editable} from './Editors';
import {Duration, Placement} from './FormControls';
import {DraftResources, useResourcePreview} from './Resources';
import {useConfirmation} from '@/hooks/use-confirmation';
import {ToggleGroup, ToggleGroupItem} from '@/components/ui/toggle-group';
import {Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem} from '@/components/ui/select';
import {Switch} from '@/components/ui/switch';

export function unitVram(d: Row, host: Row): number | undefined {
  const members = (d.members || [d]).filter(active);
  const values = members.map((m: Row) => host.deployments?.[m.id]?.gpu_mib);
  return values.length && values.every((v: any) => typeof v === 'number') ? values.reduce((a: number, b: number) => a + b, 0) : undefined;
}
export function ServingTable({rows, host, actions, compact = false}: {rows: Row[]; host: Row; actions: any; compact?: boolean}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  function primary(d: Row, menu = false) {
    const label = !d.enabled ? 'Enable' : active(d) ? 'Unload' : 'Load';
    const onClick = () => !d.enabled ? actions.enable(d, true) : active(d) ? actions.stop('serving-deployments', d) : actions.load('serving-deployments', d);
    if (d.state === 'STOPPING') return null;
    return menu ? <DropdownMenuItem onClick={onClick}>{label}</DropdownMenuItem> : <Button variant="outline" type="button" onClick={onClick}>{label}</Button>;
  }
  return <div className="table-wrap"><Table className={'deployment-table ' + (compact ? 'compact' : '')}><TableHeader><TableRow><TableHead>Deployment</TableHead><TableHead>State</TableHead><TableHead>Mode</TableHead><TableHead className="numeric">VRAM (GiB)</TableHead><TableHead className="numeric">Requests</TableHead>{!compact && <TableHead><span className="sr-only">Actions</span></TableHead>}</TableRow></TableHeader><TableBody>{rows.map(d => <Fragment key={d.id}><TableRow>
    <TableCell><div className="deployment-name">{d.members?.length > 1 && <Button variant="ghost" type="button"  aria-label={(expanded.includes(d.id) ? 'Collapse ' : 'Expand ') + d.name} aria-expanded={expanded.includes(d.id)} onClick={() => setExpanded(s => s.includes(d.id) ? s.filter(id => id !== d.id) : [...s, d.id])}>{expanded.includes(d.id) ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</Button>}<div><a className="row-link" href={'#/deployments/' + d.id}>{d.name}</a>{d.members?.length > 1 && <small className="muted">{d.members.length} models</small>}</div></div>{d.lifecycle?.failure && <small className="error-text">{d.lifecycle.failure}</small>}</TableCell>
    <TableCell><Status value={state(d)}/></TableCell><TableCell>{mode(d)}</TableCell><TableCell className="numeric">{gib(unitVram(d, host))}</TableCell><TableCell className="numeric">{d.inflight || 0}</TableCell>
    {!compact && <TableCell><div className="actions">{primary(d)}<Menu label={'Actions for ' + d.name}><DropdownMenuItem onClick={() => go('deployments/' + d.id)}>Details</DropdownMenuItem>{primary(d, true)}<DropdownMenuItem disabled={active(d)} onClick={() => actions.edit(d.multi_model ? 'deployment_sets' : 'deployments', d)}>Edit</DropdownMenuItem>{!d.multi_model && <DropdownMenuItem onClick={() => actions.edit('deployments', d, true)}>Duplicate</DropdownMenuItem>}<DropdownMenuItem onClick={() => go('deployments/' + d.id + '/logs')}>Logs</DropdownMenuItem>{d.enabled && <DropdownMenuItem variant="destructive" disabled={active(d)} onClick={() => actions.enable(d, false)}>Disable for clients</DropdownMenuItem>}</Menu></div></TableCell>}
  </TableRow>{expanded.includes(d.id) && d.members?.map((member: Row) => <TableRow className="member-row" key={member.id}><TableCell><a href={'#/deployments/' + d.id + '/models'}>{member.name}</a></TableCell><TableCell><Status value={state(member)}/></TableCell><TableCell/>
    <TableCell className="numeric">{gib(host.deployments?.[member.id]?.gpu_mib)}</TableCell><TableCell className="numeric">{member.inflight || 0}</TableCell>{!compact && <TableCell/>}</TableRow>)}</Fragment>)}</TableBody></Table>{!rows.length && <Empty title="No matching deployments"/>}</div>;
}

const sharedKeys = ['residency', 'priority', 'idle_timeout', 'allow_eviction', 'allow_uncertain', 'enabled', 'queue_timeout'];
export function DeploymentSetEditor({initial, modelId, data, close, saved}: {initial?: Row; modelId?: string; data: Registry; close: () => void; saved: (id: string) => void}) {
  const {confirm, confirmation} = useConfirmation();
  const [value, setValue] = useState<Row>({name: 'New deployment', residency: 'on-demand', priority: 50, idle_timeout: 300, allow_eviction: false, allow_uncertain: false, enabled: true, queue_timeout: 300, ...(initial ? Object.fromEntries(['id', 'name', ...sharedKeys].map(k => [k, initial[k]])) : {}), members: (initial?.members || []).map((m: Row) => editable('deployments', m))});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [separate, setSeparate] = useState(false);
  const [artifactId, setArtifactId] = useState(modelId || data.models?.[0]?.id || ''), [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState(0);
  const preview = useResourcePreview(value.members, data.host?.[0]?.ts);
  const [original] = useState(() => JSON.stringify(value));
  const changed = JSON.stringify(value) !== original || Object.values(invalid).some(Boolean);
  const aliasError = (m: Row) => value.members.some((other: Row) => other !== m && other.alias === m.alias) || (data.deployments || []).some(other => other.alias === m.alias && !value.members.some((member: Row) => member.id === other.id));
  const set = (key: string, v: any) => setValue(s => ({...s, [key]: v}));
  const updateMember = (index: number, change: Row) => setValue(v => ({...v, members: v.members.map((m: Row, i: number) => i === index ? {...m, ...change} : m)}));
  async function addModel() {
    const model = data.models?.find(m => m.id === artifactId);
    if (!model) {setError('Choose a model first.'); return;}
    setBusy(true);
    let recommended: string | null = null;
    try {recommended = (await api(`/api/models/${model.id}/engine-recommendation`)).engine;} catch { /* Manual selection remains available. */ }
    const compatible = (data.runtimes || []).filter(r => model.format === 'unknown' || r.capabilities?.formats?.includes(model.format));
    const runtime = compatible.find(r => r.engine === recommended) || compatible[0];
    const used = [...(data.deployments || []), ...value.members];
    const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'model';
    const base = slug(value.name) + '-' + slug(model.name).slice(0, 40);
    let alias = base, suffix = 2;
    while (used.some(m => m.alias === alias)) alias = base + '-' + suffix++;
    const port = Array.from({length: 50000}, (_, i) => 8120 + i).find(p => !used.some(m => m.port === p));
    const schema = runtime?.capabilities?.schema || {};
    const config = Object.fromEntries(Object.entries(schema).filter(([, f]: [string, any]) => f.default !== undefined).map(([k, f]: [string, any]) => [k, ['threads', 'threads-batch'].includes(k) && data.host?.[0]?.cpu_count ? Math.min(f.default, data.host[0].cpu_count) : f.default]));
    if (runtime?.managed?.backend === 'cpu') config['gpu-layers'] = '0';
    const meta = model.metadata || {}, hf = meta.config?.text_config || meta.config || {};
    const modelContext = meta[`${model.architecture}.context_length`] || hf.max_position_embeddings;
    if (modelContext) for (const key of ['ctx-size', 'max-model-len']) if (config[key]) config[key] = Math.min(config[key], modelContext);
    const gpus = data.host?.[0]?.gpus || [];
    const gpu = [...gpus].sort((a: Row, b: Row) => (b.free_mib - (preview.data?.gpus?.find((g: Row) => g.index === b.index)?.draft_mib || 0)) - (a.free_mib - (preview.data?.gpus?.find((g: Row) => g.index === a.index)?.draft_mib || 0)))[0]?.index ?? 0;
    const member = {...defaults.deployments, name: model.name, alias, port, gpu, configuration: {name: model.name, artifact_id: model.id, runtime_id: runtime?.id || '', config, raw_args: [], catalog: {}}};
    set('members', [...value.members, member]);
    setSelected(value.members.length);
    setError('');
    setBusy(true);
    try {
      if (!runtime) return;
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
  return <Dialog title={initial ? initial.name : 'New deployment'} close={close} busy={busy} wide editor changed={changed}>
    {confirmation}
    {error && <Alert variant="destructive" className="mb-5" role="alert"><AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">{error}</AlertDescription></Alert>}
    <form className="resource-editor" onInvalidCapture={e => {const target = e.target as HTMLElement; const section = target.closest<HTMLElement>('[data-model-index]'); if (section) setSelected(Number(section.dataset.modelIndex)); target.closest('details')?.setAttribute('open', '');}} onSubmit={e => {e.preventDefault(); void submit();}}><FieldSet disabled={busy}>
      <Field label="Name"><Input required value={value.name} onChange={e => set('name', e.target.value)}/></Field>
      <FieldSet className="model-composer"><FieldLegend>Models</FieldLegend>
        <Field label="Add installed model"><NativeSelect value={artifactId} onChange={e => setArtifactId(e.target.value)}>{(data.models || []).map(m => <NativeSelectOption key={m.id} value={m.id}>{m.name}</NativeSelectOption>)}</NativeSelect></Field><Button variant="outline" type="button" disabled={!artifactId} onClick={addModel}>Add model</Button>
        <div className="model-switcher"><ToggleGroup variant="outline" aria-label="Models" value={[String(selected)]} onValueChange={next => {if (next.length) setSelected(Number(next[0]));}}>{value.members.map((m: Row, index: number) => <ToggleGroupItem key={m.id || m.port} value={String(index)}>{m.name || `Model ${index + 1}`}{invalid[m.id || m.port] || aliasError(m) ? ' · Check settings' : ''}</ToggleGroupItem>)}</ToggleGroup></div>
        {value.members.map((m: Row, index: number) => <section hidden={selected !== index} data-model-index={index} className="model-edit-section" key={m.id || m.port}>
          <h3>{m.name}</h3><Field label="Model display name"><Input required value={m.name} onChange={e => updateMember(index, {name: e.target.value})}/></Field>
          <Field label="API model ID"><Input required aria-label="API model ID" aria-invalid={aliasError(m)} pattern="[a-zA-Z0-9][a-zA-Z0-9_.\/\-]{0,159}" value={m.alias} onChange={e => updateMember(index, {alias: e.target.value})}/>{aliasError(m) && <small className="error-text" role="alert">This API model ID is already in use.</small>}</Field>
          <ConfigurationFields value={m.configuration} data={data} set={configuration => updateMember(index, {configuration})} onValid={valid => setInvalid(v => ({...v, [m.id || m.port]: !valid}))} recommendation={preview.data?.members?.[index]?.recommendation}/>
          <details><summary>Placement</summary><Placement value={m} change={v => updateMember(index, v)} host={data.host?.[0]}/></details>
          <Button variant="destructive" type="button" onClick={async () => {if (m.id && !await confirm('Remove this model from the deployment? It will be kept as an inactive standalone configuration.')) return; set('members', value.members.filter((_: Row, i: number) => i !== index)); setSelected(Math.max(0, selected - 1)); setInvalid(v => ({...v, [m.id || m.port]: false}));}}>Remove model</Button>
        </section>)}
      </FieldSet>
      <Field label="Mode"><Select disabled={busy} items={[{value:'on-demand',label:'On demand'},{value:'pinned',label:'Pinned'},{value:'evictable',label:'Evictable'}]} value={value.residency} onValueChange={next => {if (next) set('residency', next);}}><SelectTrigger aria-label="Mode" className="w-full"><SelectValue/></SelectTrigger><SelectContent><SelectGroup><SelectItem value="on-demand">On demand</SelectItem><SelectItem value="pinned">Pinned</SelectItem><SelectItem value="evictable">Evictable</SelectItem></SelectGroup></SelectContent></Select></Field>
      {value.residency === 'on-demand' && <Duration value={value.idle_timeout} change={v => set('idle_timeout', v)}/>}
      {value.residency !== 'pinned' && <label className="check"><Checkbox  checked={value.allow_eviction} onCheckedChange={checked => set('allow_eviction', checked)}/>Can unload to make room for another deployment</label>}
      {value.residency === 'on-demand' && <label className="check"><Checkbox  checked={value.allow_uncertain} onCheckedChange={checked => set('allow_uncertain', checked)}/>Allow on-demand loading with uncertain memory estimates</label>}
      <details><summary>Advanced</summary><FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2"><Field label="Priority"><Input required type="number" min={0} max={100} value={value.priority} onChange={e => set('priority', Number(e.target.value))}/></Field><Field label="Switch timeout (seconds)"><Input required type="number" min={1} max={1800} value={value.queue_timeout} onChange={e => set('queue_timeout', Number(e.target.value))}/></Field></FieldGroup><label className="check"><Switch disabled={busy} checked={value.enabled} onCheckedChange={checked => set('enabled', checked)}/>Enabled for clients</label></details>
    </FieldSet>{value.members.length > 0 && <DraftResources preview={preview.data} error={preview.error}/>}<div className="dialog-actions">{initial && value.members.length > 1 && <Button variant="destructive" type="button"  disabled={busy} onClick={() => setSeparate(true)}>Separate models…</Button>}<Button variant="default" type="submit"  disabled={busy || value.members.length < 1 || value.members.some(aliasError) || Object.values(invalid).some(Boolean)}>{busy ? 'Saving…' : 'Save deployment'}</Button></div></form>
    {separate && <section className="warning"><p>Make each model a standalone deployment? Current shared policies will be kept.</p><Button variant="destructive" type="button"  disabled={busy} onClick={async () => {setBusy(true); try {await api(`/api/deployment-sets/${initial!.id}/dissolve?expected=${initial!.revision}`, {}); saved('');} catch (e) {setError(message(e));} finally {setBusy(false);}}}>Separate models</Button></section>}
  </Dialog>;
}

export function MultiDeploymentDetail({d, tab, data, host, actions, events}: {d: Row; tab: string; data: Registry; host: Row; actions: any; events: Row[]}) {
  const [logMember, setLogMember] = useState(d.member_ids[0]), [logs, setLogs] = useState(''), [error, setError] = useState('');
  useEffect(() => {if (tab !== 'Logs') return; let alive = true; const load = () => api(`/api/deployments/${logMember}/logs`).then(r => {if (alive) {setLogs(r.text); setError('');}}).catch(e => {if (alive) setError(message(e));}); setLogs(''); void load(); const timer = setInterval(load, 2000); return () => {alive = false; clearInterval(timer);};}, [logMember, tab]);
  return <><a className="back-link" href="#/deployments"><ArrowLeft size={16}/>Deployments</a><div className="page-head"><div><h1>{d.name}</h1><Status value={state(d)}/></div><div className="actions">{!active(d) && d.enabled && <Button variant="default" type="button"  onClick={() => actions.load('serving-deployments', d)}>Load</Button>}{active(d) && d.state !== 'STOPPING' && <Button variant="outline" type="button" onClick={() => actions.stop('serving-deployments', d)}>Unload</Button>}<Button variant="outline" type="button" disabled={active(d)} onClick={() => actions.edit('deployment_sets', d)}>Edit</Button></div></div>
    {d.lifecycle?.failure && <Alert variant="destructive" role="alert" className="mb-5"><AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">{d.lifecycle.failure}</AlertDescription></Alert>}
    <Tabs items={['Models', 'Policy', 'Activity', 'Logs']} value={tab} onChange={t => go(`deployments/${d.id}/${t.toLowerCase()}`)}/>
    {tab === 'Models' && <><div className="stats"><Card className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3"><CardHeader className="p-0 pb-3"><CardDescription>Models ready</CardDescription></CardHeader><CardContent className="flex flex-col gap-3 p-0"><strong>{d.members.filter((m: Row) => m.state === 'READY').length} <small>/ {d.members.length}</small></strong></CardContent></Card><Card className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3"><CardHeader className="p-0 pb-3"><CardDescription>VRAM</CardDescription></CardHeader><CardContent className="flex flex-col gap-3 p-0"><strong>{gib(unitVram(d, host))} <small>GiB</small></strong></CardContent></Card><Card className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3"><CardHeader className="p-0 pb-3"><CardDescription>Active requests</CardDescription></CardHeader><CardContent className="flex flex-col gap-3 p-0"><strong>{d.inflight || 0}</strong></CardContent></Card></div><div className="model-grid">{d.members.map((m: Row) => <Card className="mb-5 min-w-0 gap-0 p-0 library-card" key={m.id}><CardContent className="p-0"><Status value={state(m)}/><h2>{m.name}</h2><dl className="properties"><dt>API model</dt><dd><code>{m.alias}</code></dd><dt>Context / request</dt><dd>{number(m.profile_snapshot?.catalog?.model?.limit?.context, 0)}</dd><dt>VRAM (GiB)</dt><dd>{gib(host.deployments?.[m.id]?.gpu_mib)}</dd></dl><div className="card-actions"><Button variant="outline" type="button" disabled={active(d)} onClick={() => actions.edit('deployments', {...m, unit_id: d.id, member_only: true})}>Edit model</Button><Button variant="outline" type="button" onClick={() => {setLogMember(m.id); go(`deployments/${d.id}/logs`);}}>Logs</Button></div></CardContent></Card>)}</div></>}
    {tab === 'Policy' && <Card className="mb-5 min-w-0 gap-0 p-5"><CardContent className="p-0"><dl className="properties"><dt>Mode</dt><dd>{mode(d)}</dd>{d.residency === 'on-demand' && <><dt>Unload after idle</dt><dd>{d.idle_timeout ? `${d.idle_timeout} seconds` : 'Never'}</dd></>}<dt>Automatic eviction</dt><dd>{d.residency !== 'pinned' && d.allow_eviction ? 'Allowed' : 'Not allowed'}</dd><dt>Priority</dt><dd>{d.priority}</dd><dt>Client discovery</dt><dd>{d.lifecycle?.serving ? 'Available' : 'Not listed'}</dd><dt>Switch timeout</dt><dd>{d.queue_timeout} seconds</dd></dl></CardContent></Card>}
    {tab === 'Activity' && <Card className="mb-5 min-w-0 gap-0 p-0"><CardContent className="p-0"><ActivityFeed events={events.filter(e => e.deployment_id === d.id || d.member_ids.includes(e.deployment_id))} deployments={[...data.deployments || [], d]}/></CardContent></Card>}
    {tab === 'Logs' && <Card className="mb-5 min-w-0 gap-0 p-5"><CardContent className="p-0"><Field label="Model"><NativeSelect value={logMember} onChange={e => setLogMember(e.target.value)}>{d.members.map((m: Row) => <NativeSelectOption key={m.id} value={m.id}>{m.name}</NativeSelectOption>)}</NativeSelect></Field>{error && <p role="alert" className="error-text">{error}</p>}<pre tabIndex={0}>{logs || 'Loading logs…'}</pre></CardContent></Card>}
  </>;
}
