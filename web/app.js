'use strict';
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v, digits=0) => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(undefined,{maximumFractionDigits:digits});
const date = (t) => t ? new Date(t*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
const short = (id) => id.replace('-qwen38-trial','').replace('-qat-gguf','').replace('-lab','').replace(/^handy-computer\//,'');
let status = null, artifacts = [], events = [], active = 'shelf', refreshing = false;
async function api(path) { const r = await fetch(path); if (!r.ok) throw new Error(`${r.status}: ${path}`); return r.json(); }
function stat(label,value,unit,sub,cls='') {return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value ${cls}">${esc(value)}<small>${esc(unit)}</small></div><div class="stat-sub">${esc(sub)}</div></div>`;}
function fact(label,value) { return `<div><span class="fact-label">${esc(label)}</span><span class="fact-value">${esc(value)}</span></div>`; }
function chart(target,rows,key,{threshold=null,unit='',color='mint'}={}) {
  const el=$(target), data=rows.filter(r=>r[key]!=null);
  if(!data.length){el.innerHTML='<div class="empty">No measured history in this window.</div>';return;}
  const width=900,height=215,left=60,right=18,top=22,bottom=33;
  const lo=0, hi=Math.max(...data.map(r=>r[key]),threshold||0,1)*1.15;
  const start=data[0].ts,end=Math.max(data.at(-1).ts,start+1);
  const x=t=>left+(t-start)/(end-start)*(width-left-right);
  const y=v=>height-bottom-(v-lo)/(hi-lo)*(height-top-bottom);
  // Split missing stretches instead of claiming uninterrupted measurements.
  const gaps=Math.max(900,(end-start)/data.length*5);
  let paths=[], points=[];
  data.forEach((r,i)=>{if(i&&r.ts-data[i-1].ts>gaps){paths.push(points);points=[];}points.push([x(r.ts),y(r[key])]);});
  if(points.length) paths.push(points);
  const path=pts=>pts.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
  let svg=`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(key)} history in ${esc(unit)}"><title>${esc(key)}: ${num(data.at(-1)[key])} ${esc(unit)} latest</title>`;
  for(let i=0;i<4;i++){const v=hi*i/3;svg+=`<line class="grid" x1="${left}" y1="${y(v)}" x2="${width-right}" y2="${y(v)}"/><text x="${left-10}" y="${y(v)+3}" text-anchor="end">${num(v)}</text>`;}
  paths.forEach(pts=>{svg+=`<path class="area" d="${path(pts)} L${pts.at(-1)[0]},${height-bottom} L${pts[0][0]},${height-bottom} Z"/><path class="series" d="${path(pts)}"/>`;});
  if(threshold!=null)svg+=`<line class="threshold" x1="${left}" x2="${width-right}" y1="${y(threshold)}" y2="${y(threshold)}"/><text x="${width-right}" y="${y(threshold)-6}" text-anchor="end">GUARD ${num(threshold)} ${esc(unit)}</text>`;
  for(let i=0;i<3;i++){const t=start+(end-start)*i/2;svg+=`<text x="${x(t)}" y="${height-6}" text-anchor="${i===0?'start':i===2?'end':'middle'}">${esc(date(t))}</text>`;}
  svg+=data.map(r=>`<circle cx="${x(r.ts)}" cy="${y(r[key])}" r="5" fill="transparent"><title>${esc(date(r.ts))}: ${num(r[key],1)} ${esc(unit)}</title></circle>`).join('');
  el.innerHTML=svg+'</svg>';
}
function renderStatus(){
  if(!status)return;
  const gpu=status.gpu||{},mem=status.memory||{},models=status.models||[],resident=models.filter(m=>m.state==='loaded');
  const age=status.ts?Math.max(0,Math.floor(Date.now()/1000-status.ts)):null;
  $('#connection').innerHTML=`<span class="dot"></span>${age!=null?`Sample ${age}s ago`:'Awaiting collector'} · 10s cadence`;
  const warnings=Object.entries(status.errors||{}).map(([k,v])=>`${k}: ${v}`);
  if(status.configuration_job)warnings.unshift(`Configuration ${status.configuration_job.status.replaceAll('_',' ')}: ${status.configuration_job.detail} See Preset editor.`);
  if(age>45)warnings.unshift(`Collector data is stale (${age}s old). These are not live readings.`);
  if(status.router && status.router.build_info!=='b10777-e3de71522')warnings.push('Unreviewed Prism build: metrics polling disabled for safety.');
  if(status.missing_presets?.length)warnings.push(`Presets missing from router: ${status.missing_presets.join(', ')}`);
  $('#alert').hidden=!warnings.length;$('#alert').textContent=warnings.join(' · ');
  $('#overview').innerHTML=stat('Models in collection',models.length,'models',`${models.filter(m=>m.source==='preset').length} presets · ${models.filter(m=>m.source!=='preset').length} discovered`)+stat('Resident now',resident.length,'loaded',models.filter(m=>m.state==='sleeping').length+' sleeping',resident.length?'good':'')+stat('Free VRAM',num(gpu.free/1024,1),'GiB',`${num(gpu.free-2048)} MiB above guard`,gpu.free<2048?'bad':'good')+stat('GPU temperature',num(gpu.temperature),'°C',`${num(gpu.power)} W · ${num(gpu.utilization)}% utilization`);
  $('#model-count').textContent=models.length;
  $('#models').innerHTML=models.map((m,i)=>{
    const o=m.options,d=m.derived||{},parallel=Number(o.parallel||1),ctx=Number(o['ctx-size']||0);
    return `<button class="model-card ${esc(m.state)}" data-model="${i}"><div class="card-top"><span class="model-icon">${m.id.includes('bonsai')?'♧':m.id.includes('gemma')?'◇':m.id.includes('parakeet')?'♫':'◈'}</span><span class="state ${esc(m.state)}">${m.state==='loaded'?'● ':m.state==='sleeping'?'◌ ':'○ '}${esc(m.state)}</span></div><h3>${esc(short(m.id))}</h3><div class="model-id">${esc(m.id)}</div><div class="model-facts">${fact('CONTEXT / SLOT',ctx?num(Math.floor(ctx/parallel)):'Not exposed')}${fact('KV CACHE',o['cache-type-k']||'Runtime default')}${fact('PARALLEL SLOTS',parallel)}${fact('DECODE · PROCESS AVG',d.decode_tok_s!=null?num(d.decode_tok_s,1)+' tok/s':'Not measured')}</div><div class="card-bottom"><span>${m.drift.length?`<span class="warn">${m.drift.length} config differences</span>`:m.source==='preset'?'Preset matches disk':esc(m.source)+' · outside shelf.ini'}</span><span>Inspect ↗</span></div></button>`;
  }).join('')||'<p class="empty">The router is unavailable. History remains accessible.</p>';
  $('#models').querySelectorAll('[data-model]').forEach(b=>b.onclick=()=>modelDetail(models[Number(b.dataset.model)]));
  $('#build-note').textContent=`Prism ${status.router?.build_info||'unavailable'} · Maximum residents: ${status.router?.max_instances??'—'} · Metrics use autoload=false; slot requests disabled. Rates are process-lifetime averages, not instantaneous throughput.`;
  $('#gpu-stats').innerHTML=stat('Free VRAM',num(gpu.free),'MiB','Guard floor: 2,048 MiB',gpu.free<2048?'bad':'good')+stat('Available RAM',num(mem.available_mib/1024,1),'GiB','Guard floor: 4 GiB',mem.available_mib<4096?'bad':'')+stat('GPU temperature',num(gpu.temperature),'°C','Guard ceiling: 85 °C',gpu.temperature>=85?'bad':'')+stat('System swap used',num(mem.swap_used_mib/1024,1),'GiB','Not runtime-owned swap; different from guard');
  $('#processes').innerHTML=(gpu.processes||[]).map(p=>`<tr><td>${esc(p.name)}</td><td>${p.pid}</td><td>${p.shelf?'<span class="good">Shelf process</span>':'Other / unassigned'}</td><td>${num(p.used_mib)} MiB</td></tr>`).join('')||'<tr><td colspan="4">No compute processes reported.</td></tr>';
  $('#history-note').textContent=`History begins ${date(status.history_start)} · ${num(status.db_bytes/1048576,1)} MiB stored · ${status.artifact_count} imported artifacts. GPU samples retained 90 days; model snapshots seven days. Sparse periods are shown as gaps.`;
}
function modelDetail(m){
  const o=m.options,d=m.derived||{},metrics=m.metrics||{};
  $('#model-detail').innerHTML=`<h1>${esc(short(m.id))}</h1><p class="muted">${esc(m.id)} · ${esc(m.state)} · ${esc(m.source)}</p><div class="stats">${stat('Prefill',num(d.prefill_tok_s,1),'tok/s','Process-lifetime average')}${stat('Decode',num(d.decode_tok_s,1),'tok/s','Process-lifetime average')}${stat('Cached / processed',d.cache_ratio!=null?num(d.cache_ratio*100,1):'—','%', 'Counter ratio, not a hit probability')}${stat('MTP acceptance',d.mtp_acceptance!=null?num(d.mtp_acceptance*100,1):'—','%','Accepted / drafted tokens')}</div><div class="callout">${esc(m.metrics_error||m.metrics_note||'No live metrics: model unloaded or build not reviewed. No request was made to wake it.')} Individual slot polling is disabled because it can wake the model.</div><h3>Configuration differences</h3>${m.drift.length?`<table><thead><tr><th>Setting</th><th>On disk</th><th>Effective</th></tr></thead><tbody>${m.drift.map(v=>`<tr><td>${esc(v.key)}</td><td>${esc(v.disk)}</td><td>${esc(v.effective??'Not exposed')}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">'+(m.disk?'No differences in declared shelf settings.':'Not managed by shelf.ini.')+'</p>'}<h3>Effective settings</h3><table class="option-table"><tbody>${Object.entries(o).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table><details><summary>Resolved launch arguments</summary><pre>${esc(m.argv.join('\n'))}</pre></details><details><summary>Raw counters and gauges</summary><pre>${esc(JSON.stringify(metrics,null,2))}</pre></details>`;
  $('#model-dialog').showModal();
  const smoke=artifacts.filter(a=>a.kind==='smoke').flatMap(a=>a.data.rows.filter(r=>r.model===m.id).map(r=>({file:a.name,modified:a.modified,...r})));
  $('#model-detail').insertAdjacentHTML('beforeend',`<h3>Historical shelf smoke checks</h3><p class="muted">Short-prompt measurements, not sustained benchmarks. Build/config provenance incomplete.</p><div class="table-wrap"><table><thead><tr><th>Source / modified</th><th>Outcome</th><th>Decode</th><th>Minimum free</th></tr></thead><tbody>${smoke.map(r=>`<tr><td>${esc(r.file)}<br>${esc(date(r.modified))}</td><td class="${r.ok?'good':'warn'}">${r.ok?'PASS':esc(r.error||'FAILED')}</td><td>${num(r.decode_tok_s,1)} tok/s</td><td>${num(r.min_free_mib)} MiB</td></tr>`).join('')||'<tr><td colspan="4">No imported smoke checks for this model.</td></tr>'}</tbody></table></div><h3>Observed history · last 24 hours</h3><div id="model-history-chart"></div><div id="model-transitions" class="muted">Loading recorded state changes…</div>`);
  api('/api/model-history?id='+encodeURIComponent(m.id)).then(h=>{
    if(!$('#model-dialog').open||$('#model-detail h1').textContent!==short(m.id))return;
    chart('#model-history-chart',h.rows,'decode',{unit:'tok/s (process average)'});
    $('#model-transitions').innerHTML='<p>Rates are process-lifetime averages. State/config changes below reflect observations, not every intervening event.</p>'+h.transitions.map(t=>`<p>${esc(date(t.ts))} · ${esc(t.state)} · config <code>${esc(t.config)}</code> · ${esc(t.build)}</p>`).join('');
  }).catch(err=>{if($('#model-transitions'))$('#model-transitions').textContent=String(err);});
}
async function history(){
  const hours=Number($('#hours').value),h=await api('/api/history?hours='+hours);
  chart('#gpu-chart',h.rows,'free_min',{threshold:2048,unit:'MiB'});
  chart('#temperature-chart',h.rows,'temperature',{threshold:85,unit:'°C'});
  chart('#power-chart',h.rows,'power',{unit:'W'});
  const day=hours===24?h:await api('/api/history?hours=24');
  chart('#shelf-chart',day.rows,'free_min',{threshold:2048,unit:'MiB'});
}
function renderResults(){
  const query=$('#result-search').value.toLowerCase(), include=$('#show-artifacts').checked;
  const rows=artifacts.filter(r=>r.kind==='evaluation'&&(include||!r.warning)&&`${r.name} ${r.data.model||''} ${r.data.label||''}`.toLowerCase().includes(query));
  $('#result-count').textContent=`${rows.length} arms`;
  $('#result-list').innerHTML=rows.map(r=>{
    const d=r.data,summary=Object.entries(d.summary),passed=summary.reduce((s,[,v])=>s+(v.passed||0),0),total=summary.reduce((s,[,v])=>s+(v.of||0),0);
    return `<details class="result"><summary><strong>${esc(d.label||r.name)}</strong><small>${esc(r.name)}</small><span class="score ${passed===total?'good':'warn'}">${passed} / ${total} passed</span></summary><div class="result-body"><div class="provenance">${esc(r.warning||r.provenance)} · File modified ${esc(date(r.modified))}</div><div class="muted">Model: ${esc(d.model||'not recorded')} · Temperature: ${esc(d.temperature??'not recorded')} · Reasoning: ${esc(d.reasoning_effort??'not recorded')} · System prompt: ${d.system_prompt?`${num(d.system_prompt_chars)} chars · ${esc(d.system_prompt_source||'source not recorded')}`:'delivery not recorded'} · SHA ${r.sha.slice(0,12)}</div><div class="probe-grid">${summary.map(([k,v])=>`<span class="probe ${v.passed===v.of?'':'failed'}">${esc(k)}${v.critical?' ⚑':''} · ${v.passed}/${v.of}</span>`).join('')}</div><h3>Individual trials</h3>${(d.results||[]).map(t=>`<details><summary><span class="${t.passed?'good':'bad'}">${t.passed?'PASS':'FAIL'}</span><strong>${esc(t.probe)}</strong><small>rep ${Number(t.rep||0)+1} · ${num(t.elapsed_s,2)}s · ${num(t.usage?.completion_tokens)} output tokens</small></summary><p class="muted">${esc(t.detail)}</p><pre class="answer">${esc(t.answer||'(no final answer)')}</pre></details>`).join('')}</div></details>`;
  }).join('')||'<div class="panel empty">No matching evaluation arms.</div>';
}
function renderEvents(){
  const kind=$('#event-kind').value;
  $('#event-list').innerHTML=events.filter(e=>!kind||e.kind===kind).map(e=>`<div class="event"><time>${esc(date(e.ts))}</time><span class="kind ${esc(e.kind)}">${esc(e.kind)}</span><code>${esc(e.message)}</code></div>`).join('')||'<div class="empty">No collected events of this kind.</div>';
}
async function loadEvents(){
  events=await api('/api/events?kind='+encodeURIComponent($('#event-kind').value));
  renderEvents();
}
async function loadArtifacts(){
  const loaded=await api('/api/results');
  if(artifacts.length&&loaded.map(a=>a.sha).join()===artifacts.map(a=>a.sha).join())return;
  artifacts=loaded; renderResults();
  const fit=$('#fit'),previous=fit.value;
  fit.innerHTML=artifacts.filter(a=>a.kind==='kv-fit').map(a=>`<option value="${a.sha}">${esc(a.data.model)} · ${esc(a.data.kv)} · ${esc(a.name)}</option>`).join('');
  if(previous)fit.value=previous;
}
let estimateSeq=0;
async function calculate(e){
  e?.preventDefault();
  const seq=++estimateSeq;
  $('#ctx-label').textContent=num($('#context').value)+' tokens';
  if(!$('#estimate-form').checkValidity()||!$('#fit').value)return;
  const q=new URLSearchParams({fit:$('#fit').value,context:$('#context').value,other:$('#other').value,total:$('#total').value});
  try{
    const r=await api('/api/estimate?'+q);if(seq!==estimateSeq)return;
    const total=Number($('#total').value),fit=artifacts.find(a=>a.sha===$('#fit').value);
    $('#estimate-result').innerHTML=`<div class="eyebrow">PROJECTED FREE VRAM</div><div class="projection ${r.margin_mib<0?'bad':'good'}">${num(r.free_mib)} <small>MiB</small></div><p class="muted">${num(Math.abs(r.margin_mib))} MiB ${r.margin_mib<0?'below':'above'} the 2,048 MiB guard floor</p><div class="allocation"><span class="weights"></span><span class="other"></span></div><div class="estimate-lines"><div><span>Model allocation</span><strong>${num(r.model_mib)} MiB</strong></div><div><span>Other allocations</span><strong>${num(r.other_mib)} MiB</strong></div><div><span>Context per slot</span><strong>${num(Math.floor(Number($('#context').value)/Number($('#parallel').value)))} tokens</strong></div><div><span>Fit slope</span><strong>${num(fit.data.mib_per_1k,2)} MiB / 1,024 tokens</strong></div><div><span>Measured context range</span><strong>${fit.data.points.map(p=>num(p[0])).join(' → ')}</strong></div></div><div class="callout"><strong>${r.extrapolated?'Outside measured range':'Within measured range · still an estimate'}</strong>${esc(r.warning)}</div>`;
    $('.allocation .weights').style.width=Math.min(100,r.model_mib/total*100)+'%';
    $('.allocation .other').style.width=Math.min(100,r.other_mib/total*100)+'%';
  }catch(err){$('#estimate-result').textContent=String(err);}
}
function route(){
  const name=location.hash.slice(1)||'shelf';active=['shelf','config','gpu','estimator','results','events'].includes(name)?name:'shelf';
  document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==active);
  document.querySelectorAll('nav a').forEach(a=>{a.classList.toggle('active',a.dataset.view===active);if(a.dataset.view===active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  document.title=`Menagerie · ${active==='shelf'?'Model shelf':active[0].toUpperCase()+active.slice(1)}`;
}
async function refresh(){
  if(refreshing)return;refreshing=true;
  try{status=await api('/api/status');renderStatus();await history();await loadEvents();}
  catch(err){$('#alert').hidden=false;$('#alert').textContent='Dashboard connection lost. Displayed data may be stale. '+String(err);$('#connection').textContent='Disconnected';}
  finally{refreshing=false;}
}
$('#close-dialog').onclick=()=>$('#model-dialog').close();
$('#model-dialog').addEventListener('click',e=>{if(e.target===$('#model-dialog')&&e.offsetX<0)$('#model-dialog').close();});
$('#hours').onchange=()=>history().catch(console.error);
$('#result-search').oninput=renderResults;$('#show-artifacts').onchange=renderResults;
$('#event-kind').onchange=()=>loadEvents().catch(console.error);
$('#estimate-form').onsubmit=calculate;
$('#estimate-form').oninput=calculate;
window.addEventListener('hashchange',route);
route();refresh();
loadArtifacts().then(()=>calculate()).catch(err=>{$('#result-list').textContent=String(err);});
setInterval(()=>{if(!document.hidden)refresh();},10000);
setInterval(()=>{if(!document.hidden)loadArtifacts().catch(console.error);},60000);
