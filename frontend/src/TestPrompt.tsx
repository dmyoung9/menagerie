import {useEffect, useRef, useState} from 'react';
import {Field, message, type Row} from './ui';
import {streamCompletion} from './completionStream';

export function TestPrompt({deployments}: {deployments: Row[]}) {
  const available = deployments.filter(d => d.enabled && d.state === 'READY');
  const [alias, setAlias] = useState(''), [prompt, setPrompt] = useState('Say hello in one sentence.'), [output, setOutput] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const selected = available.some(d => d.alias === alias) ? alias : available[0]?.alias || '';
  return <form onSubmit={async e => {
    e.preventDefault(); setError(''); setOutput(''); setBusy(true);
    const current = new AbortController(); controller.current = current;
    try {await streamCompletion(selected, prompt, current.signal, text => setOutput(old => old + text));}
    catch (e) {setError(current.signal.aborted ? 'Request cancelled. Any partial response is kept below.' : message(e));}
    finally {setBusy(false); controller.current = null;}
  }}>
    {!available.length && <p>Load an enabled deployment and wait for Ready to test it here.</p>}
    <Field label="Test model"><select disabled={busy || !available.length} value={selected} onChange={e => setAlias(e.target.value)}>{available.map(d => <option key={d.id} value={d.alias}>{d.alias}</option>)}</select></Field>
    <Field label="Test prompt"><textarea required maxLength={4000} disabled={busy} value={prompt} onChange={e => setPrompt(e.target.value)}/></Field>
    <button className="primary" disabled={busy || !selected || !prompt.trim()}>{busy ? 'Receiving…' : 'Send test prompt'}</button>
    {busy && <button type="button" onClick={() => controller.current?.abort()}>Cancel request</button>}
    {error && <p role="alert" className="alert error">{error}</p>}
    <pre aria-label="Test response" aria-live="polite" style={{whiteSpace: 'pre-wrap'}}>{output}</pre>
    <p className="muted">Uses the local gateway. This test is not saved as a conversation. Normal gateway request accounting still applies.</p>
  </form>;
}
