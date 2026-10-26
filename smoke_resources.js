// Isolated static frontend at :8038. All APIs intercepted; no live runtime changes.
async page => {
  await page.unroute('**/api/**');
  const assert = (ok, text) => {if (!ok) throw new Error(text);};
  const errors = [], drafts = [], writes = [];
  page.on('pageerror', e => errors.push(String(e)));
  const host = {ts:Date.now()/1000,cpu_count:8,cpu_percent:12,ram_total_mib:32768,ram_available_mib:20000,swap_used_mib:0,gpus:[{index:0,name:'Example GPU',total_mib:16384,used_mib:4096,free_mib:12288,utilization:18}],deployments:{running:{gpu_mib:3072}}};
  const running = {id:'running',name:'Loaded model',alias:'loaded',gpu:0,state:'READY',enabled:true,residency:'pinned',lifecycle:{serving:true}};
  const runtime = {id:'engine',name:'Engine',engine:'llama.cpp',capabilities:{formats:['gguf'],schema:{'ctx-size':{type:'integer',min:512,max:131072,default:8192},parallel:{type:'integer',min:1,max:8,default:1},threads:{type:'integer',min:1,max:128,default:16},'gpu-layers':{type:'string',default:'all'}}}};
  const registry = {models:[{id:'model',name:'Example model',format:'gguf'}],runtimes:[runtime],profiles:[],deployments:[running],jobs:[]};
  await page.route('**/api/**', async route => {
    const req = route.request(), path = req.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const send = body => route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(path === '/api/status') return send({csrf_token:'fixture',host,settings:{gpu_headroom_mib:2048,ram_headroom_mib:4096},deployments:[running]});
    if(path.startsWith('/api/registry/')) return send(registry[path.split('/').at(-1)] || []);
    if(path === '/api/integration/opencode') return send({endpoint:'http://127.0.0.1:8001/v1'});
    if(path === '/api/events/stream') return route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'});
    if(path.startsWith('/api/history/')) return send([]);
    if(path === '/api/resources/preview') {
      const payload = req.postDataJSON(); drafts.push(payload);
      const members = payload.members.map((m,i) => {
        const c=m.configuration.config, kv=(c['ctx-size'] || 8192)/8;
        return {key:String(i),name:m.name,gpu:m.gpu,estimate:{peak_mib:3072+kv,components:{Weights:2048,'KV cache':kv,'Runtime overhead':1024},reservation_mib:m.reservation_mib || 3072+kv,confidence:'low',provenance:'Fixture generic estimate'},recommendation:{context_key:'ctx-size',context_recommended_max:payload.members.length>1?8192:32768,context_default:8192,gpu_layers_max:32,reason:'Estimated with peers and desktop reserve'}};
      });
      const needed=members.reduce((n,m)=>n+m.estimate.peak_mib,0), remaining=16384-4096-2048-needed;
      return send({members,gpus:[{...host.gpus[0],reserve_mib:2048,draft_mib:needed,remaining_mib:remaining,verdict:remaining<0?'Over budget':'Fits estimate'}],sample_ts:host.ts,ram_available_mib:20000,ram_reserve_mib:4096,note:'Preview only; launch rechecks capacity.'});
    }
    if(req.method() === 'POST') writes.push(path);
    return route.fulfill({status:500,body:JSON.stringify({error:'Unexpected '+path})});
  });
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('http://127.0.0.1:8038/#/overview');
  await page.reload();
  await page.getByRole('heading',{name:'Where your resources go'}).waitFor();
  await page.getByRole('button',{name:'Loaded model: 3 GiB',exact:false}).click();
  assert(await page.getByRole('link',{name:'Open deployment →'}).count()===1,'Observed tile cannot drill into deployment');
  await page.screenshot({path:'/tmp/opencode/menagerie-resources-overview.png',fullPage:true});
  await page.getByRole('navigation').getByRole('link',{name:'Deployments',exact:true}).click();
  await page.getByRole('button',{name:'New deployment',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Add model',exact:true}).click();
  await dialog.getByRole('heading',{name:'Resource preview',exact:true}).waitFor();
  await dialog.getByText('Fits estimate',{exact:false}).waitFor();
  assert(await dialog.getByLabel('threads',{exact:true}).inputValue()==='8','New default exceeds CPU count');
  await dialog.getByLabel('ctx-size',{exact:true}).fill('32768');
  await dialog.getByRole('button',{name:'Example model · KV cache: 4 GiB',exact:false}).waitFor();
  await dialog.getByRole('button',{name:'Add model',exact:true}).click();
  await dialog.getByText('Suggested pool ceiling: 8,192 tokens.',{exact:false}).filter({visible:true}).waitFor();
  await dialog.getByLabel('ctx-size',{exact:true}).filter({visible:true}).fill('131072');
  await dialog.getByText('Over budget',{exact:false}).waitFor();
  assert(drafts.at(-1).members.length===2,'Preview omitted peer model');
  const layerSection=dialog.getByText('Memory & GPU',{exact:true}).filter({visible:true});
  await layerSection.click();
  await dialog.getByLabel('GPU layer mode',{exact:true}).filter({visible:true}).selectOption('custom');
  await dialog.getByText('32 model layers available',{exact:true}).filter({visible:true}).waitFor();
  assert(await dialog.getByLabel('GPU layer count',{exact:true}).filter({visible:true}).getAttribute('max')==='32','Layer control ignores model bound');
  const previewRect = await dialog.locator('.draft-resources').boundingBox();
  assert(previewRect.x > 900 && previewRect.y >= 70 && previewRect.y < 300,'Preview is not visible beside the scrolled editor');
  await page.screenshot({path:'/tmp/opencode/menagerie-resources-editor.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Page overflows mobile viewport');
  assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),'Dialog overflows mobile viewport');
  await page.screenshot({path:'/tmp/opencode/menagerie-resources-mobile.png',fullPage:true});
  assert(!writes.length,'Preview caused persistent writes: '+writes);
  assert(!errors.length,errors.join('\n'));
  return {result:'passed',checks:['observed GPU/RAM maps','deployment drill-down','host-aware defaults','context-driven preview','whole-deployment budget','over-budget feedback','model layer bound','mobile layout','no persistent writes']};
}
