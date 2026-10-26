import {useState} from 'react';
import {ArrowUpRight,Boxes} from 'lucide-react';
import {VariantDialog} from './VariantDialog';
import {byteSize,parameterSize} from './variants';
import './catalog.css';

type Row=Record<string,any>;
type Props={api:(path:string,body?:unknown)=>Promise<any>;queued:()=>void};
export function ModelCatalog({api,queued}:Props){
  const [source,setSource]=useState<'hf'|'ollama'>('hf'),[query,setQuery]=useState(''),[rows,setRows]=useState<Row[]>([]);
  const [model,setModel]=useState<string|null>(null),[local,setLocal]=useState<Row|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[searched,setSearched]=useState(false);
  function switchSource(value:'hf'|'ollama'){setSource(value);setRows([]);setModel(null);setLocal(null);setError('');setSearched(false)}
  async function search(){
    setError('');setBusy(true);setLocal(null);setSearched(false);setRows([]);
    try{const result=await api(source==='hf'?'/api/catalog/hf?q='+encodeURIComponent(query):'/api/catalog/ollama/search?q='+encodeURIComponent(query));setRows(source==='hf'?result:result.models);setSearched(true)}
    catch(e){setError(String(e))}finally{setBusy(false)}
  }
  return <section className="panel model-catalog" aria-label="Model catalog">
    <div className="toolbar"><button disabled={busy} className={source==='hf'?'primary':''} onClick={()=>switchSource('hf')}>Hugging Face</button><button disabled={busy} className={source==='ollama'?'primary':''} onClick={()=>switchSource('ollama')}>Ollama library</button><button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{setLocal(await api('/api/catalog/ollama'))}catch(e){setError(String(e))}finally{setBusy(false)}}}>Locally installed Ollama models</button></div>
    <form className="toolbar" onSubmit={e=>{e.preventDefault();void search()}}><input aria-label="Catalog search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={source==='hf'?'Model name or organization':'e.g. qwen, llama3.2'}/><button className="primary" disabled={busy} type="submit">{busy?'Searching…':'Search catalog'}</button></form>
    {error&&<p role="alert" className="error-text">{error}</p>}
    {searched&&!rows.length&&<p>No matching models found.</p>}
    <div className="catalog-grid">{rows.map(row=>{
      const name=row.id||row.name;
      const tags:string[]=row.tags||[];
      const capabilities=['vision','tools','thinking','embedding'].filter(t=>tags.includes(t)||new RegExp(`\\b${t}\\b`,'i').test(row.description||''));
      const formats=['GGUF','Safetensors','MLX','AWQ','GPTQ','FP8'].filter(t=>tags.some(tag=>tag.toLowerCase()===t.toLowerCase())||new RegExp(`(?:^|[-_/])${t}(?:$|[-_/])`,'i').test(name));
      const params=parameterSize(name);
      const url=source==='hf'?`https://huggingface.co/${name}`:row.url;
      return <article className="catalog-card" key={name}><div className="catalog-card-heading"><Boxes size={20}/><h3>{name}</h3><a className="button icon-button" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${name} on ${source==='hf'?'Hugging Face':'Ollama'}`} title="Open supplier page"><ArrowUpRight size={17}/></a></div><div className="catalog-chips"><span className="catalog-chip">{source==='hf'?'Hugging Face':'Ollama'}</span>{formats.map(t=><span className="catalog-chip" key={t}>{t}</span>)}{params!=='Unspecified'&&<span className="catalog-chip">{params}</span>}{capabilities.map(t=><span className="catalog-chip" key={t}>{t}</span>)}{row.gated&&<span className="catalog-chip">Gated</span>}</div><div className="catalog-card-footer"><span>{source==='hf'?`${(row.downloads||0).toLocaleString()} downloads`:'Public model library'}</span><button onClick={()=>setModel(name)}>Choose variant</button></div></article>
    })}</div>
    {local&&<section className="catalog-local"><h3>Locally installed Ollama models</h3><p>{local.note||`${local.models.length} models installed`}</p><div className="catalog-chips">{local.models.map((m:Row)=><span className="catalog-chip" key={m.name}>{m.name} · {byteSize(m.size)} {m.details?.quantization_level}</span>)}</div></section>}
    {model&&<VariantDialog key={source+':'+model} source={source} name={model} api={api} close={()=>setModel(null)} queued={queued} openModel={setModel}/>}
  </section>
}
