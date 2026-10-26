import {useId} from 'react';
import {Field, type Row} from './ui';

export function Placement({value, change, host = {}}: {value: Row; change: (v: Row) => void; host?: Row}) {
  return <div className="form-grid"><Field label="GPU">{host.gpus?.length ? <select value={value.gpu} onChange={e => change({...value, gpu: Number(e.target.value)})}>{!host.gpus.some((g: Row) => g.index === value.gpu) && <option value={value.gpu}>GPU {value.gpu} (unavailable)</option>}{host.gpus.map((g: Row) => <option key={g.index} value={g.index}>{g.name} · GPU {g.index}</option>)}</select> : <input type="number" required min={0} aria-label="GPU index" value={value.gpu} onChange={e => change({...value, gpu: Number(e.target.value)})}/>}</Field><Field label="Memory reservation"><div className="control-pair"><select aria-label="Memory reservation mode" value={value.reservation_mib === 0 ? 'auto' : 'custom'} onChange={e => change({...value, reservation_mib: e.target.value === 'auto' ? 0 : 1024})}><option value="auto">Automatic estimate</option><option value="custom">Custom GiB</option></select>{value.reservation_mib !== 0 && <input aria-label="Memory reservation in GiB" type="number" required min={1 / 1024} step={1 / 1024} value={value.reservation_mib / 1024} onChange={e => change({...value, reservation_mib: Math.round(Number(e.target.value) * 1024)})}/>}</div></Field><Field label="Private port"><input type="number" required min={1024} max={65535} value={value.port} onChange={e => change({...value, port: Number(e.target.value)})}/></Field></div>;
}

export function Choices({label, value, options, change}: {label: string; value: string; options: {value: string; label: string}[]; change: (value: string) => void}) {
  const name = useId();
  return <fieldset className="choice-field"><legend>{label}</legend><div className="segmented">{options.map(o => <label key={o.value} className={value === o.value ? 'selected' : ''}><input type="radio" name={name} checked={value === o.value} onChange={() => change(o.value)}/>{o.label}</label>)}</div></fieldset>;
}

export function Duration({value, change}: {value: number; change: (value: number) => void}) {
  const presets = [0, 60, 300, 900, 1800];
  return <Field label="Unload after idle"><div className="control-pair"><select aria-label="Idle duration" value={presets.includes(value) ? value : 'custom'} onChange={e => change(e.target.value === 'custom' ? 600 : Number(e.target.value))}>{presets.map(n => <option key={n} value={n}>{n ? `${n / 60} minutes` : 'Never'}</option>)}<option value="custom">Custom seconds</option></select>{!presets.includes(value) && <input aria-label="Custom idle duration in seconds" type="number" min={1} max={86400} required value={value} onChange={e => change(Number(e.target.value))}/>}</div></Field>;
}

export function RuntimeSettings({schema, value, change, host = {}}: {schema: Row; value: Row; change: (value: Row) => void; host?: Row}) {
  const update = (key: string, v: any) => {const next = {...value}; if (v === undefined) delete next[key]; else next[key] = v; change(next);};
  const groups = [
    ['Context & concurrency', ['ctx-size', 'max-model-len', 'parallel']],
    ['Memory & GPU', ['gpu-layers', 'cache-type-k', 'cache-type-v', 'flash-attn', 'n-cpu-moe']],
    ['Performance', ['threads', 'threads-batch', 'batch-size', 'ubatch-size']],
    ['Generation', Object.keys(schema).filter(k => !['ctx-size', 'max-model-len', 'parallel', 'gpu-layers', 'cache-type-k', 'cache-type-v', 'flash-attn', 'n-cpu-moe', 'threads', 'threads-batch', 'batch-size', 'ubatch-size'].includes(k))],
  ] as [string, string[]][];
  function control(key: string) {
    const f = schema[key], current = value[key], label = f.label || key;
    const thread = ['threads', 'threads-batch'].includes(key);
    const context = ['ctx-size', 'max-model-len'].includes(key);
    const max = thread && host.cpu_count ? Math.min(f.max || host.cpu_count, host.cpu_count) : f.max;
    const numeric = ['integer', 'number'].includes(f.type);
    const stops = [...new Set([f.min, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, max].filter(n => typeof n === 'number' && n >= f.min && n <= max))].sort((a, b) => a - b);
    const effective = Number(current ?? f.default ?? f.min);
    const nearest = stops.reduce((best, n, i) => Math.abs(n - effective) < Math.abs(stops[best] - effective) ? i : best, 0);
    const exact = <input aria-label={label} type={numeric ? 'number' : 'text'} required={current !== undefined} min={f.min} max={max} step={f.type === 'number' ? 'any' : 1} value={current ?? ''} placeholder={`Default: ${f.default ?? 'engine'}`} onChange={e => update(key, e.target.value === '' ? undefined : numeric ? Number(e.target.value) : e.target.value)}/>;
    if (key === 'gpu-layers') return <Field key={key} label={label}><div className="control-pair"><select aria-label="GPU layer mode" value={current === undefined ? 'default' : current === 'all' ? 'all' : 'custom'} onChange={e => update(key, e.target.value === 'default' ? undefined : e.target.value === 'all' ? 'all' : '0')}><option value="default">Engine default</option><option value="all">All layers</option><option value="custom">Custom count</option></select>{current !== undefined && current !== 'all' && <input aria-label="GPU layer count" type="number" required min={0} step={1} value={current} onChange={e => update(key, e.target.value)}/>}</div></Field>;
    if (key === 'flash-attn') return <Choices key={key} label={label} value={current ?? ''} options={[{value: '', label: 'Default'}, ...f.choices.map((v: string) => ({value: v, label: v === 'auto' ? 'Auto' : v === 'on' ? 'On' : 'Off'}))]} change={v => update(key, v || undefined)}/>;
    if (f.choices) return <Field key={key} label={label}><select value={current ?? ''} onChange={e => update(key, e.target.value || undefined)}><option value="">Engine default ({f.default})</option>{f.choices.map((v: string) => <option key={v}>{v}</option>)}</select></Field>;
    return <Field key={key} label={label} hint={context && schema.parallel ? `${effective.toLocaleString()} tokens shared across ${value.parallel ?? schema.parallel.default ?? 1} concurrent requests` : thread && host.cpu_count ? `${host.cpu_count} host threads available` : f.units}><div className="range-control">{context && stops.length > 1 ? <input aria-label={`${label} range`} aria-valuetext={`${effective.toLocaleString()} tokens`} type="range" min={0} max={stops.length - 1} step={1} value={nearest} onChange={e => update(key, stops[Number(e.target.value)])}/> : thread && host.cpu_count ? <input aria-label={`${label} range`} type="range" min={f.min} max={max} step={1} value={effective} onChange={e => update(key, Number(e.target.value))}/> : null}{exact}</div></Field>;
  }
  return <div className="runtime-settings">{groups.filter(([, keys]) => keys.some(k => schema[k])).map(([title, keys], index) => <details key={title} open={index === 0} className="settings-section"><summary>{title}</summary><div className="form-grid">{keys.filter(k => schema[k]).map(control)}</div></details>)}</div>;
}
