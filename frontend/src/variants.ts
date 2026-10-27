export type CatalogFile = {name:string;size:number|null;sha256?:string|null};
export type Variant = {id:string;label:string;format:string;quant:string;suffix:string;parameters:string;files:CatalogFile[];bytes:number|null;complete:boolean;note?:string};
export const QUANTS=['IQ1','IQ2','IQ3','IQ4','Q2_K','Q3_K','Q4_0','Q4_1','Q4_K','Q5_0','Q5_1','Q5_K','Q6_K','Q8_0','Q8_K','F16','BF16','F32'];
export const SUFFIXES=['XXS','XS','S','M','L','XL','None'];
export const parameterSize=(text:string)=>text.match(/(?:^|[-_/:])(\d+(?:\.\d+)?[BM])(?=[-_.:/]|$)/i)?.[1].toUpperCase()||'Unspecified';
export const byteSize=(bytes:number|null)=>bytes==null?'Size not reported':`${(bytes/1024**3).toLocaleString(undefined,{maximumFractionDigits:2})} GiB`;

export function quantization(name:string):{quant:string;suffix:string}{
  const stem=name.replace(/\.gguf$/i,'').replace(/-\d{5}-of-\d{5}$/i,'');
  const match=stem.match(/(?:^|[-_:/])((?:IQ\d|Q\d+_K|Q\d+_[01]|PQ\d+_[01]|TQ\d_[01]|BF16|FP16|F16|F32))(?:_(XXS|XS|XL|NL|S|M|L))?$/i);
  return match?{quant:match[1].toUpperCase().replace('FP16','F16'),suffix:match[2]?.toUpperCase()||'None'}:{quant:'Other / default',suffix:'None'};
}

export function hfVariants(files:CatalogFile[]):Variant[]{
  const grouped=new Map<string,CatalogFile[]>();
  for(const file of files){
    if(!file.name.toLowerCase().endsWith('.gguf'))continue;
    // Projectors, importance matrices and draft heads are not primary model variants.
    if(/(?:^|\/)(?:mmproj|imatrix|mtp)(?:[-_./]|$)/i.test(file.name))continue;
    const key=file.name.replace(/-\d{5}-of-\d{5}\.gguf$/i,'.gguf');
    grouped.set(key,[...(grouped.get(key)||[]),file]);
  }
  const result:Variant[]=[];
  for(const [key,unsorted] of grouped){
    const entries=[...unsorted].sort((a,b)=>a.name.localeCompare(b.name));
    const split=entries[0].name.match(/-(\d{5})-of-(\d{5})\.gguf$/i);
    const complete=!split||entries.length===Number(split[2])&&entries.every((f,i)=>f.name.endsWith(`-${String(i+1).padStart(5,'0')}-of-${split[2]}.gguf`));
    result.push({id:entries[0].name,label:key.split('/').at(-1)!,format:'GGUF',...quantization(key),parameters:parameterSize(key),files:entries,bytes:entries.some(f=>f.size==null)?null:entries.reduce((n,f)=>n+f.size!,0),complete,note:split?`${entries.length} of ${Number(split[2])} shards`:undefined});
  }
  if(files.some(f=>f.name.endsWith('.safetensors'))){
    const snapshot=files.filter(f=>/\.(safetensors|json|model|tiktoken|txt|jinja)$/.test(f.name));
    result.push({id:'__safetensors__',label:'Complete safetensors snapshot',format:'Safetensors',quant:'As published',suffix:'None',parameters:'Unspecified',files:snapshot,bytes:snapshot.some(f=>f.size==null)?null:snapshot.reduce((n,f)=>n+f.size!,0),complete:true});
  }
  return result;
}

export const dimensions=['format','parameters','quant','suffix'] as const;
export type Dimension=typeof dimensions[number];
export type Selection=Partial<Record<Dimension,string>>;
export function candidates(variants:Variant[],selection:Selection){return variants.filter(v=>dimensions.every(d=>!selection[d]||v[d]===selection[d]))}
// Choices are hierarchical: changing a parent clears incompatible child choices.
// A single remaining option is selected automatically; no arbitrary variant wins.
export function reconcile(variants:Variant[],previous:Selection={}):Selection{
  const selection:Selection={};let rows=variants;
  for(const dimension of dimensions){
    const values=[...new Set(rows.map(v=>v[dimension]))];
    const value=values.includes(previous[dimension]||'')?previous[dimension]:values.length===1?values[0]:undefined;
    if(value){selection[dimension]=value;rows=rows.filter(v=>v[dimension]===value)}
  }
  return selection;
}
export function choose(variants:Variant[],selection:Selection,dimension:Dimension,value:string){
  const next:Selection={};
  for(const d of dimensions){if(d===dimension)break;next[d]=selection[d]}
  next[dimension]=value;return reconcile(variants,next);
}
export function optionsFor(variants:Variant[],selection:Selection,dimension:Dimension){
  const preceding=dimensions.slice(0,dimensions.indexOf(dimension));
  return new Set(variants.filter(v=>preceding.every(d=>!selection[d]||v[d]===selection[d])).map(v=>v[dimension]));
}
