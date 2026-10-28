import {Card, CardContent} from '@/components/ui/card';
import {Input} from '@/components/ui/input';
import {Button} from '@/components/ui/button';
import {useState} from 'react';
import {ModelCard} from './ModelCard';
import {VariantDialog} from './VariantDialog';
import {parameterSize} from './variants';
import './catalog.css';

type Row=Record<string,any>;
type Props={api:(path:string,body?:unknown)=>Promise<any>;queued:()=>void};
export function ModelCatalog({api,queued}:Props){
  const [query,setQuery]=useState(''),[rows,setRows]=useState<Row[]>([]);
  const [model,setModel]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[searched,setSearched]=useState(false);
  async function search(){
    setError('');setBusy(true);setSearched(false);setRows([]);
    try{setRows(await api('/api/catalog/hf?q='+encodeURIComponent(query)));setSearched(true)}
    catch(e){setError(String(e))}finally{setBusy(false)}
  }
  return <Card role="region" className="mb-5 min-w-0 model-catalog" aria-label="Model catalog"><CardContent>
    <form className="toolbar" onSubmit={e=>{e.preventDefault();void search()}}><Input aria-label="Catalog search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search Hugging Face models or organizations"/><Button variant="default"  disabled={busy} type="submit">{busy?'Searching…':'Search catalog'}</Button></form>
    {error&&<p role="alert" className="error-text">{error}</p>}
    {searched&&!rows.length&&<p>No matching models found.</p>}
    <div className="catalog-grid">{rows.map(row=>{
      const name=row.id;
      const tags:string[]=row.tags||[];
      const formats=['GGUF','Safetensors','MLX','AWQ','GPTQ','FP8'].filter(t=>tags.some(tag=>tag.toLowerCase()===t.toLowerCase())||new RegExp(`(?:^|[-_/])${t}(?:$|[-_/])`,'i').test(name));
      const params=parameterSize(name);
      return <ModelCard key={name} name={name} url={`https://huggingface.co/${name}`} chips={['Hugging Face',...formats,...(params!=='Unspecified'?[params]:[]),...(row.gated?['Gated']:[])]} footer={`${(row.downloads||0).toLocaleString()} downloads`}><Button variant="outline" type="button" onClick={()=>setModel(name)}>Choose variant</Button></ModelCard>
    })}</div>
    {model&&<VariantDialog key={model} source="hf" name={model} api={api} close={()=>setModel(null)} queued={queued} openModel={setModel}/>}
  </CardContent></Card>
}
