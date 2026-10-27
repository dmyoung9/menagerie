import {useEffect, useState} from 'react';
import {api, message, type Row} from './ui';

export function EngineCatalog({runtimes, recommended}: {runtimes: Row[]; recommended?: string}) {
  const [engines, setEngines] = useState<Row[]>([]), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [queued, setQueued] = useState<string[]>([]);
  async function refresh() {
    setBusy(true); setNotice('');
    try {const result = await api('/api/engines/releases'); setEngines(result.engines); setQueued([]); setNotice(result.note || '');}
    catch (e) {setNotice(message(e));} finally {setBusy(false);}
  }
  useEffect(() => {void refresh();}, []);
  async function install(recipe: Row) {
    setBusy(true);
    try {await api('/api/engines/install', {recipe_id: recipe.id}); setQueued(old => [...old, recipe.id]); setNotice('Installation queued. See Activity for progress; the engine appears here when ready.');}
    catch (e) {setNotice(message(e));} finally {setBusy(false);}
  }
  return <section aria-label="Install engines"><div className="section-heading"><h2>Install an engine</h2><button type="button" disabled={busy} onClick={refresh}>{busy ? 'Working…' : 'Check for updates'}</button></div>
    <p className="muted">Updates install alongside existing versions. Choose the new version in your deployment when ready.</p>
    {notice && <p role="status">{notice}</p>}
    <div className="model-grid">{engines.map(engine => <section className="panel library-card" key={engine.id}><h3>{engine.name}{recommended === engine.id ? ' · Recommended' : ''}</h3><p>{engine.description}</p>{engine.note && <p>{engine.note}</p>}{engine.releases.map((recipe: Row) => {
      const installed = runtimes.some(r => r.managed?.recipe_id === recipe.id);
      return <div key={recipe.id}><p>{recipe.version} · {recipe.backend.toUpperCase()}</p><p className="muted">{recipe.requirements}</p><button type="button" disabled={busy || installed || queued.includes(recipe.id)} onClick={() => install(recipe)}>{installed ? 'Installed' : queued.includes(recipe.id) ? 'Queued — see Activity' : 'Install'}</button></div>;
    })}</section>)}</div>
  </section>;
}
