import {useState} from 'react';
import {ModelCard} from './ModelCard';
import {VariantDialog} from './VariantDialog';
import {byteSize,parameterSize} from './variants';
import './catalog.css';

type Row=Record<string,any>;
type Props={api:(path:string,body?:unknown)=>Promise<any>;queued:()=>void};
export function ModelCatalog({api,queued}:Props){
  const [source,setSource]=useState<'hf'|'ollama'>('hf'),[query,setQuery]=useState(''),[rows,setRows]=useState<Row[]>([]);
  const [model,setModel]=useState<string|null>(null),[local,setLocal]=useState<Row|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[searched,setSearched]=useState(false);
  const [localInfo,setLocalInfo]=useState<Row|null>(null);
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
      return <ModelCard key={name} name={name} url={url} chips={[source==='hf'?'Hugging Face':'Ollama',...formats,...(params!=='Unspecified'?[params]:[]),...capabilities,...(row.gated?['Gated']:[])]} footer={source==='hf'?`${(row.downloads||0).toLocaleString()} downloads`:'Public model library'}><button onClick={()=>setModel(name)}>Choose variant</button></ModelCard>
    })}</div>
    {local&&<section className="catalog-local"><h3>Locally installed Ollama models</h3><p>{local.note||`${local.models.length} models installed`}</p><div className="catalog-grid">{local.models.map((m:Row)=><ModelCard key={m.name} name={m.name} chips={['Ollama',byteSize(m.size),m.details?.quantization_level].filter(Boolean)} footer="Managed by Ollama"><button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{setLocalInfo(await api('/api/catalog/ollama/show?model='+encodeURIComponent(m.name)))}catch(e){setError(String(e))}finally{setBusy(false)}}}>Inspect capabilities</button></ModelCard>)}</div>{localInfo&&<div role="status"><h4>{localInfo.model}</h4><p>{[...localInfo.capabilities.input,...(localInfo.capabilities.tools?['tools']:[]),...(localInfo.capabilities.reasoning?['reasoning']:[])].join(' · ')}</p><p>{localInfo.capabilities.note}</p></div>}</section>}
    {model&&<VariantDialog key={source+':'+model} source={source} name={model} api={api} close={()=>setModel(null)} queued={queued} openModel={setModel}/>}
  </section>
}
