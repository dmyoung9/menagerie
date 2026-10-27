import {useEffect,useMemo,useRef,useState,type KeyboardEvent} from 'react';
import {ArrowUpRight,Download,X,Check,LoaderCircle} from 'lucide-react';
import {byteSize,candidates,choose,dimensions,hfVariants,optionsFor,QUANTS,reconcile,SUFFIXES,type Dimension,type Selection,type Variant} from './variants';

type Row=Record<string,any>;
type Props={source:'hf';name:string;api:(path:string,body?:unknown)=>Promise<any>;close:()=>void;queued:()=>void;openModel:(name:string)=>void};
const labels:Record<Dimension,string>={format:'Format',parameters:'Parameter size',quant:'Quantization',suffix:'Size / quality suffix'};

export function VariantDialog({source,name,api,close,queued,openModel}:Props){
  const dialog=useRef<HTMLDialogElement>(null);
  const [data,setData]=useState<Row|null>(null),[refs,setRefs]=useState<Row[]>([]),[revision,setRevision]=useState('main');
  const [selection,setSelection]=useState<Selection>({}),[exact,setExact]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [submitting,setSubmitting]=useState(false),[related,setRelated]=useState<Row[]|null>(null),[relatedBusy,setRelatedBusy]=useState(false);
  const [projector,setProjector]=useState('');
  const variants=useMemo(()=>data?hfVariants(data.files):[],[data]);
  const matches=candidates(variants,selection);
  const selected:Variant|undefined=matches.length===1?matches[0]:matches.find(v=>v.id===exact);
  const ready=!!selected&&dimensions.every(d=>!!selection[d])&&selected.complete&&selected.bytes!==null;
  const supplier='Hugging Face';
  const url=`https://huggingface.co/${name}`;
  useEffect(()=>{
    const node=dialog.current!;const before=document.activeElement as HTMLElement|null;
    const overflow=document.body.style.overflow;document.body.style.overflow='hidden';node.showModal();
    return()=>{node.close();document.body.style.overflow=overflow;before?.focus()};
  },[]);
  useEffect(()=>{
    let active=true;setLoading(true);setError('');setData(null);setSelection({});setExact('');setProjector('');
    (async()=>{
      try{
        const next=await api(`/api/catalog/hf/files?repo=${encodeURIComponent(name)}&revision=${encodeURIComponent(revision)}`);
        if(!active)return;setData(next);setSelection(reconcile(hfVariants(next.files)));
      }catch(e){if(active)setError(String(e))}finally{if(active)setLoading(false)}
    })();return()=>{active=false};
  },[source,name,revision]);
  useEffect(()=>{
    let active=true;
    if(source==='hf')api('/api/catalog/hf/revisions?repo='+encodeURIComponent(name)).then(r=>{if(active)setRefs(r)}).catch(()=>{if(active)setNotice('Branch list unavailable; using the selected revision.')});
    return()=>{active=false};
  },[source,name]);
  async function download(){
    if(!ready||!selected||!data)return;
    setSubmitting(true);setError('');
    try{
      await api('/api/downloads',{repo:name,revision:data.revision,filename:selected.id,...(selected.format==='GGUF'&&projector?{projector}:{})});
      queued();close();
    }catch(e){setError(String(e));setSubmitting(false)}
  }
  function trapFocus(e:KeyboardEvent<HTMLDialogElement>){
    if(e.key!=='Tab')return;
    const nodes=[...dialog.current!.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),select:not(:disabled),input:not(:disabled),summary')].filter(n=>n.offsetParent!==null);
    if(!nodes.length)return;
    const first=nodes[0],last=nodes.at(-1)!;
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
  }
  return <dialog className="variant-dialog" ref={dialog} aria-labelledby="variant-title" aria-modal="true" onKeyDown={trapFocus} onCancel={e=>{e.preventDefault();if(!submitting)close()}} onClick={e=>{if(e.target!==dialog.current||submitting)return;const r=dialog.current.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()}}>
    <div className="variant-header"><div><span className="catalog-chip">{supplier}</span><h2 id="variant-title">Choose a variant</h2><p>{name}</p></div><div className="variant-header-actions"><a className="icon-button button" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${name} on ${supplier}`} title={`Open on ${supplier}`}><ArrowUpRight size={18}/></a><button className="icon-button" disabled={submitting} aria-label="Close variant dialog" onClick={close}><X size={18}/></button></div></div>
    <div className="variant-body" aria-busy={loading}>
      {source==='hf'&&<label className="variant-revision">Revision<select disabled={loading||submitting} value={revision} onChange={e=>{setRelated(null);setRevision(e.target.value)}}>{!refs.some(r=>r.name==='main')&&<option value="main">main</option>}{refs.map(r=><option key={r.kind+':'+r.name} value={r.name}>{r.name} · {r.kind}</option>)}</select></label>}
      {error&&<div className="alert error" role="alert">{error}</div>}
      {notice&&<p>{notice}</p>}
      {loading?<div className="variant-loading" role="status"><LoaderCircle size={24}/>Loading available variants…</div>:data&&<>
        {variants.length===0&&<p>No primary downloadable weights were found in this repository. Try a linked quantization below.</p>}
        {data.capabilities&&<details><summary>Detected capabilities & dependencies</summary><p>{[...data.capabilities.input,...(data.capabilities.tools?['tools']:[]),...(data.capabilities.reasoning?['reasoning']:[])].join(' · ')}</p><p>{data.capabilities.evidence.join('; ')||'No conclusive structured metadata.'}</p><p>{data.capabilities.note}</p>{data.capabilities.warnings?.map((w:string)=><p key={w}>{w}</p>)}</details>}
        {dimensions.map((d,index)=>{
          if(d==='format'&&new Set(variants.map(v=>v.format)).size<2)return null;
          if(d==='parameters'&&new Set(variants.map(v=>v.parameters)).size<2)return null;
          const locked=dimensions.slice(0,index).some(parent=>!selection[parent]);
          const available=optionsFor(variants,selection,d);
          const common=d==='quant'?QUANTS:d==='suffix'?SUFFIXES:[];
          const values=[...new Set([...common,...variants.map(v=>v[d])])];
          if(!variants.length)return null;
          return <fieldset className="variant-field" key={d}><legend>{labels[d]}</legend><div className="variant-options">{values.map(value=><button key={value} type="button" className={'variant-chip '+(selection[d]===value?'chosen':'')} aria-pressed={selection[d]===value} disabled={locked||!available.has(value)||submitting} title={locked?'Choose the preceding option first':!available.has(value)?'Not available for this model and selection':value} onClick={()=>{setSelection(choose(variants,selection,d,value));setExact('')}}>{selection[d]===value&&<Check size={13}/>} {value==='None'?'No suffix':value}</button>)}</div></fieldset>
        })}
        {matches.length>1&&dimensions.every(d=>!!selection[d])&&<label>Exact variant<select value={exact} disabled={submitting} onChange={e=>setExact(e.target.value)}><option value="">Choose the supplier variant…</option>{matches.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select><small>These files/tags share the same chip choices. Choose the exact supplier variant.</small></label>}
        {source==='hf'&&selected?.format==='GGUF'&&data.capabilities?.dependencies?.length>0&&<label>Optional multimodal projector<select value={projector} disabled={submitting} onChange={e=>setProjector(e.target.value)}><option value="">Do not download a projector</option>{data.capabilities.dependencies.map((d:Row)=><option key={d.name} value={d.name}>{d.name} · {byteSize(d.size)}</option>)}</select><small>Candidates only: confirm compatibility with these weights. The selected file is checked against its upstream checksum when available and must be enabled in deployment settings.</small></label>}
        <div className="variant-summary" aria-live="polite"><span className="eyebrow">YOUR SELECTION</span>{selected?<>
          <h3>{selected.label}</h3><div className="catalog-chips"><span className="catalog-chip">{selected.format}</span><span className="catalog-chip">{selected.quant}</span>{selected.suffix!=='None'&&<span className="catalog-chip">{selected.suffix}</span>}{selected.parameters!=='Unspecified'&&<span className="catalog-chip">{selected.parameters}</span>}{selected.bytes!==null&&<span className="catalog-chip">{byteSize(selected.bytes)}</span>}{selected.note&&<span className="catalog-chip">{selected.note}</span>}</div>
          {!selected.complete&&<p className="error-text">The supplier listing is missing shards. This variant cannot be downloaded.</p>}
          {source==='hf'&&selected.bytes===null&&<p>Download is unavailable until the supplier reports file sizes.</p>}
          {source==='hf'&&<><p className="variant-commit">Pinned commit: {data.revision}</p><details><summary>{selected.files.length} file{selected.files.length===1?'':'s'} included</summary><ul>{selected.files.map(f=><li key={f.name}><code>{f.name}</code><span>{byteSize(f.size)}</span></li>)}</ul></details></>}
        </>:<p>Choose {dimensions.filter(d=>!selection[d]).map(d=>labels[d].toLowerCase()).join(' and ')||'an exact variant'} to complete your selection.</p>}</div>
        {source==='hf'&&<details className="variant-related"><summary>Other quantized repositories</summary><p>Some suppliers publish quantizations in separate repositories.</p><button disabled={relatedBusy||submitting} onClick={async()=>{setRelatedBusy(true);try{setRelated(await api('/api/catalog/hf/quantizations?repo='+encodeURIComponent(name)))}catch(e){setError(String(e))}finally{setRelatedBusy(false)}}}>{relatedBusy?'Loading…':'Find related quantizations'}</button>{related?.length===0&&<p>No linked quantizations declared upstream.</p>}{related?.map(r=><button className="variant-related-item" key={r.id} disabled={submitting} onClick={()=>openModel(r.id)}>{r.id}</button>)}</details>}
      </>}
    </div>
    <div className="variant-footer"><span>{selected?byteSize(selected.bytes):'Choose your variant'}</span><button disabled={submitting} onClick={close}>Cancel</button><button className="primary" disabled={loading||submitting||!ready} onClick={download}><Download size={16}/>{submitting?'Queuing…':'Download'}</button></div>
  </dialog>
}
