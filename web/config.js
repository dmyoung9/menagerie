'use strict';
let cfgData=null, reviewDraft=null, cfgBusy=false, editorBaseSha=null, editorValues={};
const activeJobStates=['queued','preflight','stopping','writing','starting','verifying','rolling_back'];
function configError(error){$('#config-error').hidden=!error;$('#config-error').textContent=error?String(error):'';}
async function configPost(path,body){
  const r=await fetch('/api/config/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Menagerie-Token':cfgData.csrf_token},body:JSON.stringify(body)});
  const data=await r.json();if(!r.ok)throw new Error(data.error||`Request failed: ${r.status}`);return data;
}
function renderEditor(){
  const model=$('#config-model').value,values=cfgData.models[model]||{};
  editorBaseSha=cfgData.base_sha;editorValues={...values};
  $('#config-revision').textContent='On-disk file revision '+cfgData.base_sha.slice(0,12)+' · reload if you edit the file elsewhere';
  $('#config-source-mode').hidden=!cfgData.read_only;
  $('#config-source-mode').textContent=cfgData.read_only?`Read-only: the authoritative model files are in ${cfgData.source_directory}. Edit a model file, run python3 ~/ai/qwen38-trials/shelf_config.py check, then apply while the shelf is idle. Legacy INI drafts cannot be applied.`:'';
  $('#config-form h2 .unit').textContent=cfgData.read_only?'per-model TOML · read-only':'shelf.ini · per-model overrides';
  $('#config-form button[type="submit"]').disabled=!!cfgData.read_only;
  for(const id of ['legacy-edit-hint','legacy-apply-note','legacy-client-note'])$('#'+id).hidden=!!cfgData.read_only;
  $('#config .page-heading p').textContent=cfgData.read_only?'Inspect per-model TOML settings here. Edit and apply changes with the shelf configuration command.':'Draft one model’s settings, review the exact diff, then choose whether to apply.';
  const rows=Object.fromEntries(Object.entries(cfgData.fields).filter(([key])=>key!=='n-cpu-moe'||key in values).map(([key,spec])=>{
    const id='setting-'+key,current=values[key]??'';
    const input=spec.type==='enum'?`<select id="${id}" data-setting="${key}" aria-label="${esc(spec.label)} value" disabled required><option value="">Runtime default / unset</option>${spec.choices.map(v=>`<option ${current===v?'selected':''}>${esc(v)}</option>`).join('')}</select>`:`<input id="${id}" data-setting="${key}" aria-label="${esc(spec.label)} value" type="number" value="${esc(current)}" placeholder="Runtime default / unset" min="${spec.min}" max="${spec.max}" step="${spec.step}" required disabled>`;
    return [key,`<div class="edit-setting"><label for="enable-${key}"><input id="enable-${key}" type="checkbox" data-enable="${key}" aria-label="Edit ${esc(spec.label)}"> ${esc(spec.label)}<code>${esc(key)}</code></label><label class="sr-only" for="${id}">${esc(spec.label)} value</label>${input}</div>`];
  }));
  const groups=[['Context & residency',['ctx-size','parallel','cache-type-k','cache-type-v','n-cpu-moe']],['Performance & caching',['batch-size','ubatch-size','threads','threads-batch','cache-ram','ctx-checkpoints','sleep-idle-seconds']],['Reasoning & sampling',['reasoning-budget','temp','top-p','top-k','min-p','presence-penalty','repeat-penalty']]];
  $('#config-fields').innerHTML=groups.map(([name,keys],i)=>`<details class="settings-group" id="settings-group-${i}" ${i===0?'open':''}><summary>${esc(name)}<small>${keys.filter(k=>k in rows).length} settings</small></summary>${keys.map(k=>rows[k]||'').join('')}</details>`).join('');
  $('#config-fields').querySelectorAll('[data-enable]').forEach(box=>box.onchange=()=>{
    $('#setting-'+box.dataset.enable).disabled=!box.checked;editorContext();
  });
  if(cfgData.read_only)$('#config-fields').querySelectorAll('input,select').forEach(input=>input.disabled=true);
  editorContext();
}
function editorContext(){
  const values=editorValues;
  const value=key=>$('#enable-'+key)?.checked?$('#setting-'+key).value:values[key];
  const ctx=Number(value('ctx-size')),slots=Number(value('parallel')||1);
  $('#editor-context-summary').textContent=ctx&&slots?`${num(ctx)} total context tokens ÷ ${slots} slots = ${num(Math.floor(ctx/slots))} tokens per slot. Extra slot overhead is not predicted.`:'Context allocation is not available.';
}
function enableApply(){
  const b=$('#apply-reviewed');if(!b)return;
  b.disabled=cfgBusy||cfgData?.read_only||!cfgData?.apply_available||reviewDraft?.status!=='draft'||$('#apply-confirm')?.value!=='RESTART SHELF'||!$('#clients-paused')?.checked||!!cfgData.attention||cfgData.jobs.some(j=>activeJobStates.includes(j.status));
}
function reviewIdentity(d){
  $('#job-identity').textContent=`Full job ID: ${d.id}`+(d.snapshot?`\nSaved original: ${d.snapshot}`:'');
  $('#recovery-help').textContent=d.status==='recovery_required'?
    `Pause clients and inspect the saved/current files and worker journal. After deliberately resolving any conflict/resource issue, retry:\npython3 ~/Projects/menagerie/config_control.py retry ${d.id}`:'';
}
function renderReview(){
  if(!reviewDraft)return;
  const d=reviewDraft;
  // Polls update status, not a typed confirmation or keyboard focus.
  const sameDraft=$('#config-review').dataset.draft===d.id;
  if(sameDraft){
    $('#job-status').textContent=d.status.replaceAll('_',' ');$('#job-detail').textContent=d.detail;
    $('#job-evidence').textContent=d.evidence?JSON.stringify(d.evidence,null,2):'';
    $('#apply-controls').hidden=d.status!=='draft'||!!cfgData.read_only;reviewIdentity(d);enableApply();return;
  }
  $('#config-review').dataset.draft=d.id;
  $('#config-review').innerHTML=`<div class="eyebrow">${d.parent?'REVERT REVIEW':'PROPOSED CHANGE'} · ${esc(d.id.slice(0,8))}</div><h3>${esc(d.model)}</h3><div class="review-state"><span id="job-status" class="badge">${esc(d.status.replaceAll('_',' '))}</span><p id="job-detail" class="muted">${esc(d.detail)}</p></div><pre class="config-diff">${esc(d.diff)}</pre><p class="hint">${esc(d.base_sha.slice(0,12))} → ${esc(d.candidate_sha.slice(0,12))}</p><div id="apply-controls" ${d.status==='draft'?'':'hidden'}><div class="callout"><strong>This restarts the whole shelf.</strong> KV caches are discarded. A short request loads this model. The worker temporarily pauses the watchdog to prevent competing recovery, then restores its prior active state. The existing safety supervisor remains in force. Failed verification attempts to restore the saved file and preset; conflicting external edits are never overwritten.</div><label class="pause-confirm"><input type="checkbox" id="clients-paused"> I have paused every model client and accept the maintenance interruption.</label><label>Type RESTART SHELF to confirm<input id="apply-confirm" type="text" autocomplete="off" spellcheck="false" placeholder="RESTART SHELF"></label><button id="apply-reviewed" type="button" disabled>Apply reviewed change ↗</button><button id="discard-draft" class="secondary" type="button">Discard this draft</button><p class="hint">${cfgData.apply_available?'Apply runs in an isolated, short-lived user-service worker.':'Apply worker unavailable. Drafting is safe; no live apply is possible.'}</p></div><pre id="job-evidence" class="config-evidence">${esc(d.evidence?JSON.stringify(d.evidence,null,2):'')}</pre>`;
  const identity=document.createElement('p');identity.id='job-identity';identity.className='footnote';
  $('#apply-controls').hidden=d.status!=='draft'||!!cfgData.read_only;
  $('.review-state').append(identity);
  const help=document.createElement('pre');help.id='recovery-help';help.className='config-evidence warn';
  $('#config-review').append(help);reviewIdentity(d);
  if(!sameDraft&&d.status==='draft'){
    $('#clients-paused').setAttribute('aria-label','All model clients paused; maintenance interruption accepted');
    $('#apply-confirm').setAttribute('aria-label','Restart confirmation');
    $('#apply-confirm').value='';$('#clients-paused').checked=false;
    $('#apply-confirm').oninput=enableApply;$('#clients-paused').onchange=enableApply;
    $('#apply-reviewed').onclick=applyReview;
    $('#discard-draft').onclick=async()=>{
      try{reviewDraft=await configPost('discard',{id:reviewDraft.id});await loadConfig();configError(null);}catch(e){configError(e);}
    };
  }
  enableApply();
}
function renderConfigJobs(){
  $('#config-jobs').innerHTML=cfgData.jobs.map(j=>`<div class="panel config-job"><div><span class="badge ${j.status==='recovery_required'?'amber':''}">${esc(j.status.replaceAll('_',' '))}</span><strong>${esc(j.model)}</strong><p class="muted">${esc(date(j.created))} · ${esc(j.id.slice(0,8))} · ${esc(j.detail)}</p></div><div class="job-actions"><button type="button" data-review="${j.id}">View diff</button>${j.status==='succeeded'?`<button type="button" data-revert="${j.id}">Review revert</button>`:''}</div></div>`).join('')||'<div class="panel empty">No configuration drafts yet.</div>';
  $('#config-jobs').querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>{reviewDraft=cfgData.jobs.find(j=>j.id===b.dataset.review);renderReview();$('#config-review').scrollIntoView({behavior:'smooth',block:'start'});});
  $('#config-jobs').querySelectorAll('[data-revert]').forEach(b=>b.onclick=async()=>{
    try{reviewDraft=await configPost('revert',{id:b.dataset.revert});await loadConfig();configError(null);$('#config-review').scrollIntoView({behavior:'smooth',block:'start'});}catch(e){configError(e);}
  });
}
async function loadConfig(reset=false){
  const incoming=await api('/api/config'),initial=!cfgData;cfgData=incoming;
  if(reset||initial){
    const previous=$('#config-model').value;
    $('#config-model').innerHTML=Object.keys(cfgData.models).map(id=>`<option value="${esc(id)}">${esc(id)}</option>`).join('');
    if(previous in cfgData.models)$('#config-model').value=previous;
    renderEditor();
  }
  if(reviewDraft)reviewDraft=cfgData.jobs.find(j=>j.id===reviewDraft.id)||reviewDraft;
  renderReview();renderConfigJobs();
}
async function applyReview(){
  if(cfgBusy)return;cfgBusy=true;enableApply();configError(null);
  try{
    reviewDraft=await configPost('apply',{id:reviewDraft.id,confirmation:$('#apply-confirm').value,quiescent:$('#clients-paused').checked});
    await loadConfig();
  }catch(e){configError(e);}finally{cfgBusy=false;enableApply();}
}
$('#config-model').onchange=renderEditor;
$('#config-form').addEventListener('input',editorContext);
$('#config-form').onsubmit=async e=>{
  e.preventDefault();configError(null);
  if(!cfgData||cfgData.read_only)return;
  const changes={};$('#config-fields').querySelectorAll('[data-enable]:checked').forEach(box=>{changes[box.dataset.enable]=$('#setting-'+box.dataset.enable).value;});
  try{reviewDraft=await configPost('draft',{model:$('#config-model').value,base_sha:editorBaseSha,changes});await loadConfig();}catch(err){configError(err);}
};
$('#reload-config').onclick=()=>loadConfig(true).then(()=>configError(null)).catch(configError);
loadConfig().catch(configError);
setInterval(()=>{if(!document.hidden&&location.hash==='#config')loadConfig().catch(configError);},3000);
