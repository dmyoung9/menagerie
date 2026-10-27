import {useState} from 'react';
import {AudioLines, Check, Image, Video, Wrench} from 'lucide-react';
import {Field, type Row} from './ui';
import {mappingKind, reasoningLabel, reasoningOptions, setReasoningOptions} from './capabilityOptions';
import './capabilities.css';

function RequestMapping({preset, change, valid}: {preset: Row; change: (body: Row) => void; valid: (ok: boolean) => void}) {
  const [custom, setCustom] = useState(false), [text, setText] = useState(''), [error, setError] = useState('');
  const mode = custom ? 'custom' : mappingKind(preset.body || {});
  function select(value: string) {
    setError(''); valid(true); setCustom(value === 'custom');
    if (value === 'custom') {setText(JSON.stringify(preset.body || {}, null, 2)); return;}
    change(value === 'effort' ? {reasoning_effort: preset.id === 'instant' ? 'none' : preset.id} : value === 'template' ? {chat_template_kwargs: {enable_thinking: false}} : value ? {[value]: 4096} : {});
  }
  return <div className="mapping-row"><span>{reasoningLabel(preset.id)}</span><div>
    <select aria-label={`${reasoningLabel(preset.id)} control`} value={mode} onChange={e => select(e.target.value)}>
      <option value="">Not configured</option><option value="effort">Native effort</option>{preset.id === 'instant' && <option value="template">Thinking off (template)</option>}
      <option value="reasoning_budget">Reasoning token budget</option><option value="thinking_budget">Thinking token budget</option><option value="custom">Custom request settings</option>
    </select>
    {['reasoning_budget', 'thinking_budget'].includes(mode) && <input aria-label={`${reasoningLabel(preset.id)} token budget`} type="number" min={0} max={1048576} required value={preset.body[mode]} onChange={e => change({[mode]: Number(e.target.value)})}/>}
    {mode === 'custom' && <textarea aria-label={`${reasoningLabel(preset.id)} custom settings`} rows={3} spellCheck={false} value={custom ? text : JSON.stringify(preset.body, null, 2)} onChange={e => {setCustom(true); setText(e.target.value); try {const body = JSON.parse(e.target.value); if (!body || Array.isArray(body) || typeof body !== 'object') throw Error(); change(body); setError(''); valid(true);} catch {setError('Enter a JSON object.'); valid(false);}}}/>}
    {error && <small className="error-text" role="alert">{error}</small>}
  </div></div>;
}

export function Capabilities({catalog, change, hints, runtime, valid}: {catalog: Row; change: (v: Row) => void; hints?: Row; runtime?: Row; valid: (key: string, ok: boolean) => void}) {
  const model = catalog.model || {};
  const caps = {tools: false, input: ['text'], output: ['text'], ...model.capabilities};
  const options = reasoningOptions(catalog, hints, runtime);
  const update = (value: Row) => change({...catalog, model: {...model, capabilities: {...caps, ...value}}});
  const writeOptions = (next: Row[]) => change(setReasoningOptions(catalog, next));
  const unavailable = options.filter(p => p.id !== 'default' && !Object.keys(p.body || {}).length);
  const [advanced, setAdvanced] = useState(false);
  const features = [{id: 'tools', label: 'Tools', icon: Wrench}, {id: 'image', label: 'Images', icon: Image}, {id: 'audio', label: 'Audio', icon: AudioLines}, {id: 'video', label: 'Video', icon: Video}];
  return <section className="capabilities-panel" aria-label="Capabilities and reasoning">
    <div className="capability-heading"><h3>Capabilities</h3><span>Available to clients</span></div>
    <div className="capability-chips" role="group" aria-label="Input capabilities">{features.map(({id, label, icon: Icon}) => {
      const selected = id === 'tools' ? caps.tools : caps.input.includes(id);
      return <button type="button" key={id} className="capability-chip" aria-pressed={selected} onClick={() => update(id === 'tools' ? {tools: !selected} : {input: selected ? caps.input.filter((m: string) => m !== id) : [...caps.input, id]})}><Icon size={16}/>{label}{selected && <Check size={13}/>}</button>;
    })}</div>
    <div className="capability-heading reasoning-heading"><h3>Reasoning options</h3><span>Select to expose</span></div>
    <div className="capability-chips reasoning-chips" role="group" aria-label="Reasoning options">{options.map(p => {
      const available = p.id === 'default' || Object.keys(p.body || {}).length > 0;
      return <button type="button" key={p.id} className="capability-chip" disabled={!available} aria-pressed={p.enabled} title={p.source} onClick={() => writeOptions(options.map(row => row.id === p.id ? {...row, enabled: !row.enabled} : row))}>{reasoningLabel(p.id)}{p.enabled && <Check size={13}/>}</button>;
    })}</div>
    {unavailable.length > 0 && <p className="capability-hint">{unavailable.length === 4 ? 'Reasoning controls not detected.' : `${unavailable.map(p => reasoningLabel(p.id)).join(', ')} not configured.`} <button type="button" className="text-action" onClick={() => setAdvanced(true)}>Set up</button></p>}
    <div className="capability-limit"><Field label="Max output tokens"><input type="number" min={1} value={model.limit?.output ?? ''} placeholder="Default" onChange={e => {const limit = {...model.limit}; if (e.target.value) limit.output = Number(e.target.value); else delete limit.output; change({...catalog, model: {...model, limit}});}}/></Field></div>
    <details className="capability-advanced" open={advanced} onToggle={e => setAdvanced(e.currentTarget.open)}><summary>Advanced capabilities</summary>
      <p className="capability-hint">Only configure controls your engine supports. Default leaves its behavior unchanged; Instant must turn thinking off.</p>
      <label className="check"><input type="checkbox" checked={!!caps.reasoning?.supported} onChange={e => update({reasoning: {supported: e.target.checked}})}/>Model returns reasoning</label>
      <div className="reasoning-mappings">{options.filter(p => p.id !== 'default').map(p => <RequestMapping key={p.id} preset={p} change={body => {valid('reasoning-' + p.id, true); writeOptions(options.map(row => row.id === p.id ? {...row, body, enabled: Object.keys(body).length ? row.enabled : false} : row));}} valid={ok => valid('reasoning-' + p.id, ok)}/>)}</div>
      <fieldset className="output-capabilities"><legend>Output formats</legend><div className="capability-chips">{['text', 'image', 'audio', 'video'].map(m => <button type="button" className="capability-chip" key={m} aria-pressed={caps.output.includes(m)} disabled={caps.output.length === 1 && caps.output.includes(m)} onClick={() => update({output: caps.output.includes(m) ? caps.output.filter((v: string) => v !== m) : [...caps.output, m]})}>{reasoningLabel(m)}</button>)}</div></fieldset>
      {hints && <div className="capability-evidence"><span>Model metadata</span><p>{hints.evidence?.join('; ') || 'No conclusive capability metadata.'}</p>{hints.dependencies?.length > 0 && <p>Companion candidates: {hints.dependencies.map((d: Row) => d.name).join(', ')}</p>}</div>}
    </details>
  </section>;
}
