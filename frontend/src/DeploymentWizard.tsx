import {useEffect, useState} from 'react';
import {api, Dialog, Field, JsonEdit, message, type Registry, type Row} from './ui';
import {defaults} from './Editors';
import {RuntimeSettings} from './FormControls';

export function DeploymentWizard({data, modelId, close, created, setupEngine}: {data: Registry; modelId?: string; close: () => void; created: (row: Row, load: boolean) => void; setupEngine: () => void}) {
  const [step, setStep] = useState(0), [artifactId, setArtifactId] = useState(modelId || data.models?.[0]?.id || '');
  const [runtimeId, setRuntimeId] = useState('');
  const [name, setName] = useState(''), [alias, setAlias] = useState('');
  const [context, setContext] = useState(8192), [parallel, setParallel] = useState(1), [custom, setCustom] = useState(false);
  const [residency, setResidency] = useState('on-demand'), [idle, setIdle] = useState(300);
  const [tools, setTools] = useState(false), [vision, setVision] = useState(false), [output, setOutput] = useState(1024);
  const [extra, setExtra] = useState<Row>({}), [args, setArgs] = useState<any>([]), [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const usedPorts = new Set((data.deployments || []).map(d => d.port));
  const [advanced, setAdvanced] = useState<Row>({...defaults.deployments, port: Array.from({length: 50000}, (_, i) => 8120 + i).find(p => !usedPorts.has(p))});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const artifact = data.models?.find(m => m.id === artifactId);
  const engines = (data.runtimes || []).filter(r => r.capabilities?.formats?.includes(artifact?.format));
  const runtime = engines.find(r => r.id === runtimeId) || engines[0];
  const schema = runtime?.capabilities?.schema || {};
  useEffect(() => {
    const supported = runtime?.capabilities?.schema || {};
    setExtra(Object.fromEntries(Object.entries(defaults.profiles.config).filter(([key]) => supported[key] && !['ctx-size', 'parallel'].includes(key))));
  }, [runtime?.id]);
  const contextKey = runtime?.engine === 'vllm' ? 'max-model-len' : 'ctx-size';
  const hasContext = Boolean(schema[contextKey]), hasParallel = Boolean(schema.parallel);
  const displayName = name || artifact?.name || 'New deployment';
  const apiAlias = alias || displayName.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+/, '').slice(0, 140) || 'model';
  const perRequest = hasContext ? context : Number(extra['ctx-size'] || extra['max-model-len'] || 4096) / Number(extra.parallel || 1);
  async function submit(load: boolean) {
    setBusy(true); setError('');
    try {
      const config: Row = {...extra};
      if (hasContext) config[contextKey] = context * (hasParallel ? parallel : 1);
      if (hasParallel) config.parallel = parallel;
      const configuration = {name: displayName, artifact_id: artifactId, runtime_id: runtime.id, config, raw_args: args, catalog: {model: {capabilities: {tools, input: vision ? ['text', 'image'] : ['text'], output: ['text']}, limit: {output}}}};
      const deployment = await api('/api/deployments', {...advanced, name: displayName, configuration, alias: apiAlias, residency, idle_timeout: idle, enabled: true});
      created(deployment, load);
    } catch (e) {setError(message(e));} finally {setBusy(false);}
  }
  const advance = () => {
    if (step === 1 && hasContext && (context * (hasParallel ? parallel : 1) > (schema[contextKey].max || 1048576) || context < (schema[contextKey].min || 512))) {
      setError('Context and concurrency exceed this engine’s supported context pool.'); return;
    }
    setError(''); setStep(s => s + 1);
  };
  return <Dialog title={['New deployment', 'Configuration', 'Review deployment'][step]} close={close} busy={busy} wide>
    <ol className="steps" aria-label="Deployment setup">{['Model & engine', 'Configuration', 'Review'].map((s, i) => <li key={s} aria-current={i === step ? 'step' : undefined} className={i <= step ? 'current' : ''}><span>{i + 1}</span>{s}</li>)}</ol>
    {error && <p className="alert error" role="alert">{error}</p>}
    <form onSubmit={e => {e.preventDefault(); if (step < 2) advance();}}>
      <fieldset disabled={busy}>
        {step === 0 && <>
          <><Field label="Model"><select required value={artifactId} onChange={e => {setArtifactId(e.target.value); setRuntimeId(''); setExtra({});}}><option value="" disabled>Select model…</option>{(data.models || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
            {engines.length ? <Field label="Engine"><select value={runtime?.id} onChange={e => {setRuntimeId(e.target.value); setExtra({});}}>{engines.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field> : <div className="empty"><h3>No compatible engine</h3><button type="button" onClick={setupEngine}>Set up engine</button></div>}
          </>
        </>}
        {step === 1 && <>
          <Field label="Name"><input required value={displayName} onChange={e => setName(e.target.value)}/></Field>
          <Field label="API model"><input required pattern="[a-zA-Z0-9][a-zA-Z0-9_.\/\-]{0,159}" value={apiAlias} onChange={e => setAlias(e.target.value)}/></Field>
          <>
            {hasContext && <Field label="Context / request"><div className="segmented">{[8192, 16384, 32768].map(n => <button type="button" aria-pressed={!custom && context === n} key={n} onClick={() => {setContext(n); setCustom(false);}}>{n / 1024}K</button>)}<button type="button" aria-pressed={custom} onClick={() => setCustom(true)}>Custom</button></div>{custom && <input aria-label="Custom context / request" type="number" required min={schema[contextKey].min || 512} max={(schema[contextKey].max || 1048576) / (hasParallel ? parallel : 1)} value={context} onChange={e => setContext(Number(e.target.value))}/>}</Field>}
            {hasParallel && <Field label="Concurrent requests" hint={`Shared context pool: ${(context * parallel).toLocaleString()} tokens`}><input type="number" min={1} max={schema.parallel.max || 64} required value={parallel} onChange={e => setParallel(Number(e.target.value))}/></Field>}
            {!hasContext && <p className="muted">This engine requires manual context configuration in Advanced.</p>}
          </>
          <Field label="Mode"><select value={residency} onChange={e => setResidency(e.target.value)}><option value="on-demand">On demand</option><option value="pinned">Pinned</option><option value="evictable">Evictable</option></select><small>{residency === 'on-demand' ? 'Loads when a client sends a request.' : residency === 'pinned' ? 'Never automatically unloaded to make room.' : 'Loads manually; can make room when idle and authorized.'}</small></Field>
          {residency === 'on-demand' && <Field label="Unload after idle"><select value={idle} onChange={e => setIdle(Number(e.target.value))}>{[60, 300, 900, 1800, 0].map(s => <option key={s} value={s}>{s ? s / 60 + ' minutes' : 'Never'}</option>)}</select></Field>}
          <details><summary>Advanced</summary>
            <><RuntimeSettings schema={Object.fromEntries(Object.entries(schema).filter(([key]) => !['ctx-size', 'max-model-len', 'parallel'].includes(key)))} value={extra} change={setExtra} host={data.host?.[0]}/>
              <Field label="Client output limit"><input required type="number" min={1} max={perRequest} value={output} onChange={e => setOutput(Number(e.target.value))}/></Field>
              <label className="check"><input type="checkbox" checked={tools} onChange={e => setTools(e.target.checked)}/>Advertise tool support</label><label className="check"><input type="checkbox" checked={vision} onChange={e => setVision(e.target.checked)}/>Advertise image input</label>
              {!hasContext && <JsonEdit label="Runtime options (JSON)" value={extra} onChange={setExtra} onValid={valid => setInvalid(v => ({...v, config: !valid}))}/>}
              <JsonEdit label="Additional engine arguments" value={args} onChange={setArgs} onValid={valid => setInvalid(v => ({...v, args: !valid}))}/>
            </>
            <div className="form-grid">{[['port', 'Private port', 1024, 65535], ['gpu', 'GPU index', 0, 31], ['reservation_mib', 'VRAM reservation (MiB; 0 = estimate)', 0, undefined], ['priority', 'Priority', 0, 100], ['queue_timeout', 'Queue timeout (seconds)', 1, 1800]].map(([key, label, min, max]) => <Field key={String(key)} label={String(label)}><input required type="number" min={min as number} max={max as number | undefined} value={advanced[key!]} onChange={e => setAdvanced({...advanced, [key!]: Number(e.target.value)})}/></Field>)}</div>
            {residency !== 'pinned' && <label className="check"><input type="checkbox" checked={advanced.allow_eviction} onChange={e => setAdvanced({...advanced, allow_eviction: e.target.checked})}/>Allow automatic unloading when idle</label>}
          </details>
        </>}
        {step === 2 && <>
          <h3>{displayName}</h3><dl className="properties"><dt>API model</dt><dd><code>{apiAlias}</code></dd><dt>Engine</dt><dd>{runtime?.name}</dd>{hasContext && <><dt>Context / request</dt><dd>{context.toLocaleString()}</dd></>}<dt>Mode</dt><dd>{residency === 'on-demand' ? 'On demand' : residency === 'pinned' ? 'Pinned' : 'Evictable'}</dd>{residency === 'on-demand' && <><dt>Unload after idle</dt><dd>{idle ? idle / 60 + ' minutes' : 'Never'}</dd></>}</dl>
          <p className="muted">Loading requires a capacity review. Creating without loading leaves this enabled for clients{residency === 'on-demand' ? '; the first request can trigger loading' : ''}.</p>
          {residency === 'on-demand' && <><label className="check"><input type="checkbox" checked={advanced.allow_uncertain} onChange={e => setAdvanced({...advanced, allow_uncertain: e.target.checked})}/>Allow on-demand loading with uncertain memory estimates</label>{!advanced.allow_uncertain && <p className="warning">Client-triggered loading may be blocked until this permission is granted.</p>}</>}
        </>}
      </fieldset>
      <div className="dialog-actions">{step > 0 && <button type="button" disabled={busy} onClick={() => setStep(s => s - 1)}>Back</button>}{step < 2 ? <button className="primary" disabled={Object.values(invalid).some(Boolean) || !runtime}>Next</button> : <><button type="button" disabled={busy} onClick={() => void submit(false)}>Create without loading</button><button type="button" className="primary" disabled={busy} onClick={() => void submit(true)}>{busy ? 'Creating…' : 'Create & review launch'}</button></>}</div>
    </form>
  </Dialog>;
}
