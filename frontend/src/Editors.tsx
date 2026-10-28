import {FieldSet, FieldLegend, FieldGroup} from '@/components/ui/field';
import {NativeSelect, NativeSelectOption} from '@/components/ui/native-select';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Checkbox} from '@/components/ui/checkbox';
import {DropdownMenuItem} from '@/components/ui/dropdown-menu';
import {useEffect, useState} from 'react';
import {api, Field, JsonEdit, Menu, type Row, type Registry} from './ui';
import {EngineCatalog} from './EngineCatalog';
import {Duration, Placement, RuntimeSettings} from './FormControls';
import {DraftResources, useResourcePreview} from './Resources';
import {Capabilities} from './Capabilities';
import {useConfirmation} from '@/hooks/use-confirmation';

export const defaults: Record<string, Row> = {
  profiles: {name: 'New profile', artifact_id: '', runtime_id: '', config: {'ctx-size': 8192, parallel: 1, 'gpu-layers': 'all', 'cache-type-k': 'q8_0', 'cache-type-v': 'q8_0', 'flash-attn': 'on'}, raw_args: [], catalog: {}},
  deployments: {name: 'New deployment', profile_id: '', alias: 'local-model', port: 8120, residency: 'on-demand', priority: 50, idle_timeout: 300, reservation_mib: 0, allow_eviction: false, allow_uncertain: false, enabled: true, gpu: 0, queue_timeout: 300},
  runtimes: {name: 'Runtime', engine: 'llama.cpp', execution_kind: 'native', executable: '', env: {}, command_template: [], trust: false},
};
export function ConfigurationFields({value, data, set, onValid, recommendation}: {value: Row; data: Registry; set: (value: Row) => void; onValid: (valid: boolean) => void; recommendation?: Row}) {
  const {confirm, confirmation} = useConfirmation();
  const runtime = data.runtimes?.find(r => r.id === value.runtime_id);
  const artifact = data.models?.find(m => m.id === value.artifact_id);
  const schema = {...runtime?.capabilities?.schema};
  const metadata = artifact?.metadata || {}, hf = metadata.config?.text_config || metadata.config || {};
  const modelContext = metadata[`${artifact?.architecture}.context_length`] || hf.max_position_embeddings;
  const layers = metadata[`${artifact?.architecture}.block_count`] || hf.num_hidden_layers;
  for (const key of ['ctx-size', 'max-model-len']) if (schema[key] && modelContext) schema[key] = {...schema[key], max: Math.min(schema[key].max, modelContext * (key === 'ctx-size' ? value.config.parallel || 1 : 1))};
  if (schema.parallel) schema.parallel = {...schema.parallel, max: Math.min(schema.parallel.max, Math.floor((value.config['ctx-size'] || schema['ctx-size']?.default || 8192) / 32))};
  if (schema['gpu-layers'] && runtime?.managed?.backend === 'cpu') schema['gpu-layers'] = {...schema['gpu-layers'], cpu_only: true};
  const [engineHint, setEngineHint] = useState<Row>({}), [installing, setInstalling] = useState(false);
  useEffect(() => {let alive = true; setEngineHint({}); if (value.artifact_id) api(`/api/models/${value.artifact_id}/engine-recommendation`).then(hint => {if (alive) setEngineHint(hint);}).catch(() => {}); return () => {alive = false;};}, [value.artifact_id]);
  const engines = (data.runtimes || []).filter(r => r.id === value.runtime_id || artifact?.format === 'unknown' || r.capabilities?.formats?.includes(artifact?.format));
  const [validity, setValidity] = useState<Record<string, boolean>>({});
  const valid = (key: string, ok: boolean) => {const next = {...validity, [key]: ok}; setValidity(next); onValid(Object.values(next).every(Boolean));};
  const catalog = structuredClone(value.catalog || {});
  delete catalog.catalog_id;
  if (catalog.model) delete catalog.model.name;
  return <FieldSet className="configuration-fields"><FieldLegend>Model configuration</FieldLegend>{confirmation}
    <Field label="Model"><NativeSelect required value={value.artifact_id} onChange={async e => {const id = e.target.value; const next = data.models?.find(m => m.id === id); if (!runtime?.capabilities?.formats?.includes(next?.format)) {if (!await confirm('This model needs a different engine. Reset engine settings?')) return; let hint: Row = {}; try {hint = await api(`/api/models/${next!.id}/engine-recommendation`);} catch { /* Manual selection remains available. */ } const compatible = (data.runtimes || []).filter(r => next?.format === 'unknown' || r.capabilities?.formats?.includes(next?.format)); const engine = compatible.find(r => r.engine === hint.engine) || compatible[0]; set({...value, artifact_id:id, runtime_id:engine?.id || '', config:{}, raw_args:[]});} else set({...value, artifact_id:id});}}>{(data.models || []).map(m => <NativeSelectOption key={m.id} value={m.id}>{m.name}</NativeSelectOption>)}</NativeSelect></Field>
    <Field label="Engine"><NativeSelect required value={value.runtime_id} onChange={async e => {const id = e.target.value; if (value.runtime_id && !await confirm('Change engine? Engine-specific settings and arguments will be reset.')) return; const selected = engines.find(r => r.id === id); const config: Row = Object.fromEntries(Object.entries(selected?.capabilities?.schema || {}).filter(([, f]: [string, any]) => f.default !== undefined).map(([k, f]: [k:string, any]) => [k, f.default])); if (selected?.managed?.backend === 'cpu') config['gpu-layers'] = '0'; const meta = artifact?.metadata || {}, hf = meta.config?.text_config || meta.config || {}; const context = meta[`${artifact?.architecture}.context_length`] || hf.max_position_embeddings; if (context) for (const key of ['ctx-size', 'max-model-len']) if (config[key]) config[key] = Math.min(config[key], context); setValidity({}); onValid(true); set({...value, runtime_id: id, config, raw_args: []});}}><NativeSelectOption value="" disabled>Select compatible engine</NativeSelectOption>{engines.map(r => <NativeSelectOption key={r.id} value={r.id}>{r.name}{engineHint.engine === r.engine ? ' · Recommended' : ''}</NativeSelectOption>)}</NativeSelect></Field>
    {engineHint.reason && <p className="muted">{engineHint.reason}</p>}
    <Button variant="outline" type="button" onClick={() => setInstalling(!installing)}>{installing ? 'Hide engine downloads' : 'Install an engine'}</Button>
    {installing && <EngineCatalog runtimes={data.runtimes || []} recommended={engineHint.engine}/>}
    <RuntimeSettings schema={schema} value={value.config} change={config => set({...value, config})} host={data.host?.[0]} recommendation={{gpu_layers_max: layers, ...recommendation}}/>
    {artifact?.metadata?.projector && runtime?.capabilities?.schema?.mmproj && <Button variant="outline" type="button" onClick={() => set({...value, config: {...value.config, mmproj: artifact.metadata.projector.path}})}>Use downloaded projector: {artifact.metadata.projector.name}</Button>}
    <Capabilities key={value.artifact_id + ':' + value.runtime_id} catalog={catalog} change={catalog => set({...value, catalog})} hints={artifact?.discovered_capabilities} runtime={runtime} valid={valid}/>
    <details key={value.runtime_id}><summary>Advanced model settings</summary><JsonEdit label="Runtime options (JSON)" value={value.config} onChange={config => set({...value, config})} onValid={ok => valid('config', ok)}/><JsonEdit label="Engine arguments" value={value.raw_args} onChange={raw_args => set({...value, raw_args})} onValid={ok => valid('args', ok)}/><JsonEdit label="Client capabilities (JSON)" value={catalog} onChange={catalog => set({...value, catalog})} onValid={ok => valid('catalog', ok)}/></details>
  </FieldSet>;
}
const allowed: Record<string, string[]> = {
  profiles: ['id', 'name', 'artifact_id', 'runtime_id', 'config', 'raw_args', 'catalog'],
  deployments: ['id', ...Object.keys(defaults.deployments)],
  runtimes: ['id', ...Object.keys(defaults.runtimes), 'version', 'commit', 'fork_url', 'formats'],
};
export function editable(kind: string, row?: Row, clone = false): Row {
  const value = structuredClone(row ? Object.fromEntries(allowed[kind].filter(k => row[k] !== undefined).map(k => [k, row[k]])) : defaults[kind]);
  if (kind === 'deployments' && row?.profile_snapshot) {
    value.configuration = editable('profiles', row.profile_snapshot);
    delete value.configuration.id;
    delete value.profile_id;
  }
  if (clone) {
    delete value.id; value.name += ' (copy)';
    if (kind === 'profiles') value.catalog.catalog_id = (value.catalog.catalog_id || 'model') + '-copy-' + Date.now().toString(36);
    if (kind === 'deployments') value.alias += '-copy';
  }
  return value;
}
export function Editor({kind, initial, data, save, remove, busy, memberOnly = false}: {kind: string; initial: Row; data: Registry; save: (v: Row) => void; remove?: () => void; busy: boolean; memberOnly?: boolean}) {
  const [value, setValue] = useState(initial), [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const unitId = memberOnly ? data.deployments?.find(m => m.id === value.id)?.unit_id : undefined;
  const peers = unitId ? (data.deployments || []).filter(d => d.unit_id === unitId && d.id !== value.id).map(d => ({...d, configuration: d.profile_snapshot})) : [];
  const preview = useResourcePreview(kind === 'deployments' && value.configuration ? [value, ...peers] : [], data.host?.[0]?.ts);
  const set = (key: string, v: any) => setValue(prev => ({...prev, [key]: v}));
  const input = (key: string, label: string, type = 'text', min?: number, max?: number) => <Field label={label}><Input required={!['commit', 'fork_url'].includes(key)} type={type} min={min} max={max} value={value[key] ?? ''} onChange={e => set(key, type === 'number' ? Number(e.target.value) : e.target.value)}/></Field>;
  const check = (key: string, label: string) => <label className="check"><Checkbox  checked={!!value[key]} onCheckedChange={checked => set(key, checked)}/>{label}</label>;
  const select = (key: string, rows: Row[], label: string) => <Field label={label}><NativeSelect required value={value[key]} onChange={e => set(key, e.target.value)}><NativeSelectOption value="" disabled>Select…</NativeSelectOption>{rows.map(r => <NativeSelectOption key={r.id} value={r.id}>{r.name}</NativeSelectOption>)}</NativeSelect></Field>;
  const json = (key: string, label: string) => <JsonEdit label={label} value={value[key]} onChange={v => set(key, v)} onValid={valid => setInvalid(prev => ({...prev, [key]: !valid}))}/>;
  return <form onSubmit={e => {e.preventDefault(); if (!Object.values(invalid).some(Boolean)) save(value);}}>
    {input('name', 'Display name')}
    {kind === 'profiles' && <>
      {select('artifact_id', data.models || [], 'Model')}{select('runtime_id', data.runtimes || [], 'Engine')}
      <RuntimeSettings schema={data.runtimes?.find(r => r.id === value.runtime_id)?.capabilities?.schema || {}} value={value.config} change={config => set('config', config)} host={data.host?.[0]}/>
      <details><summary>Advanced</summary>{json('config', 'Runtime options (JSON)')}{json('raw_args', 'Arguments (JSON array)')}{json('catalog', 'Client capabilities (JSON)')}</details>
      <p className="muted">Running deployments keep their saved revision.</p>
    </>}
    {kind === 'deployments' && <>
      {input('alias', 'API model ID')}
      {value.configuration && <ConfigurationFields value={value.configuration} data={data} set={configuration => set('configuration', configuration)} onValid={valid => setInvalid(prev => ({...prev, configuration: !valid}))} recommendation={preview.data?.members?.[0]?.recommendation}/>}
      {value.configuration && <DraftResources preview={preview.data} error={preview.error}/>}
      {!memberOnly && <><Field label="Mode"><NativeSelect value={value.residency} onChange={e => set('residency', e.target.value)}><NativeSelectOption value="on-demand">On demand</NativeSelectOption><NativeSelectOption value="pinned">Pinned</NativeSelectOption><NativeSelectOption value="evictable">Evictable</NativeSelectOption></NativeSelect></Field>{value.residency === 'on-demand' && <Duration value={value.idle_timeout} change={v => set('idle_timeout', v)}/>}</>}
      <details><summary>Placement</summary><Placement value={value} change={setValue} host={data.host?.[0]}/></details><details><summary>Scheduling</summary>{!memberOnly && <><FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">{input('priority', 'Priority', 'number', 0, 100)}{input('queue_timeout', 'Queue timeout (seconds)', 'number', 1, 1800)}</FieldGroup>{value.residency !== 'pinned' && check('allow_eviction', 'Can unload to make room for another deployment')}{check('allow_uncertain', 'Allow on-demand loading with uncertain memory estimates')}</>}</details>
      {!memberOnly && check('enabled', 'Enabled for clients')}
    </>}
    {kind === 'runtimes' && <>
      <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2"><Field label="Engine"><NativeSelect value={value.engine} onChange={e => set('engine', e.target.value)}>{['llama.cpp', 'prism', 'vllm', 'sglang', 'custom'].map(v => <NativeSelectOption key={v}>{v}</NativeSelectOption>)}</NativeSelect></Field><Field label="Execution"><NativeSelect value={value.execution_kind} onChange={e => set('execution_kind', e.target.value)}>{['native', 'docker', 'podman'].map(v => <NativeSelectOption key={v}>{v}</NativeSelectOption>)}</NativeSelect></Field></FieldGroup>
      {input('executable', value.execution_kind === 'native' ? 'Executable path' : 'Image (pinned digest)')}
      <details><summary>Advanced</summary>{input('commit', 'Source commit')}{input('fork_url', 'Source repository')}{json('env', 'Environment (JSON)')}{value.engine === 'custom' && json('command_template', 'Command template (JSON array)')}</details>
      <p className="warning">Registration runs the executable to check its version and supported options.</p>{check('trust', 'I trust this executable or image')}
    </>}
    <div className="dialog-actions">{remove && <Menu label="More deployment actions"><DropdownMenuItem variant="destructive"   disabled={busy} onClick={remove}>Remove</DropdownMenuItem></Menu>}<Button variant="default" type="submit"  disabled={busy || Object.values(invalid).some(Boolean)}>{busy ? 'Saving…' : kind === 'profiles' ? 'Save revision' : 'Save'}</Button></div>
  </form>;
}
