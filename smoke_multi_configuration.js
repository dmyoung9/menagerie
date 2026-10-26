// Isolated frontend at :8038; every API call intercepted, no live changes.
async page => {
  await page.unroute('**/api/**');
  const assert = (ok, message) => {if (!ok) throw new Error(message);};
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(String(e)));
  const runtime = {id:'engine',name:'Engine',engine:'llama.cpp',capabilities:{formats:['gguf'],schema:{'ctx-size':{type:'integer',min:512,max:131072,default:8192},parallel:{type:'integer',min:1,max:8,default:1}}}};
  const registry = {models:[{id:'gemma',name:'Gemma Four',format:'gguf'}],runtimes:[runtime],profiles:[],deployments:[],jobs:[]};
  let serving = [];
  await page.route('**/api/**', async route => {
    const req=route.request(), path=req.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const send = body => route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/api/status') return send({csrf_token:'fixture',host:{gpus:[]},settings:{},serving_deployments:serving,deployments:registry.deployments});
    if(path.startsWith('/api/registry/')) return send(registry[path.split('/').at(-1)] || []);
    if(path==='/api/integration/opencode') return send({endpoint:'http://127.0.0.1:8001/v1'});
    if(path==='/api/events/stream') return route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'});
    if(path.startsWith('/api/history/')) return send([]);
    if(path==='/api/deployment-sets' && req.method()==='POST') {
      const payload=req.postDataJSON(); writes.push(payload);
      const id=payload.id || 'set-'+writes.length;
      const members=payload.members.map((m,i)=>({...m,id:m.id||id+'-member-'+i,profile_snapshot:m.configuration,state:'STOPPED',revision:1,lifecycle:{serving:true}}));
      const saved={...payload,id,members,member_ids:members.map(m=>m.id),multi_model:true,state:'STOPPED',revision:writes.length,lifecycle:{serving:true}};
      serving=[...serving.filter(u=>u.id!==id),saved]; registry.deployments=serving.flatMap(u=>u.members);
      return send(saved);
    }
    return route.fulfill({status:500,body:'Unmocked '+path});
  });
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('http://127.0.0.1:8038/#/deployments');
  await page.reload();
  await page.getByText('No enabled deployments',{exact:true}).waitFor();
  const dialog=page.getByRole('dialog');
  async function create(name) {
    await page.getByRole('button',{name:'New deployment',exact:true}).click();
    await dialog.getByLabel('Name',{exact:true}).fill(name);
    await dialog.getByRole('button',{name:'Add model',exact:true}).click();
    await dialog.getByRole('button',{name:'Add model',exact:true}).click();
    assert(await dialog.getByLabel('Model display name',{exact:true}).count()===2,'Cannot configure multiple members directly');
    await dialog.getByRole('button',{name:'Gemma Four',exact:true}).first().click();
    await dialog.getByLabel('ctx-size',{exact:true}).filter({visible:true}).fill('16384');
    await dialog.getByRole('button',{name:'Save deployment',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    await page.getByRole('heading',{name,exact:true}).waitFor();
  }
  await create('Pair One');
  await page.getByRole('navigation').getByRole('link',{name:'Deployments',exact:true}).click();
  await create('Pair Two');
  assert(writes.length===2,'Creation should use one atomic request per deployment');
  assert(writes.every(w=>w.members.length===2&&w.members.every(m=>m.configuration.artifact_id==='gemma'&&!m.id&&!m.profile_id)),'Weights were not reusable as independent members');
  const aliases=writes.flatMap(w=>w.members.map(m=>m.alias));
  assert(new Set(aliases).size===4,'Suggested aliases must be distinct');
  const ports=writes.flatMap(w=>w.members.map(m=>m.port));
  assert(new Set(ports).size===4,'Suggested ports must be distinct');
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await dialog.getByLabel('Model display name',{exact:true}).first().fill('Gemma custom');
  await dialog.getByLabel('ctx-size',{exact:true}).filter({visible:true}).fill('32768');
  await dialog.getByRole('button',{name:'Save deployment',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  assert(writes[2].members[0].name==='Gemma custom'&&writes[2].members[0].configuration.config['ctx-size']===32768,'Multi-member editing lost configuration');
  assert(writes[0].members[0].configuration.config['ctx-size']===16384,'Editing another deployment changed its settings');
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Multi-model form overflows mobile viewport');
  await page.keyboard.press('Escape');
  assert(!errors.length,errors.join('\n'));
  return {result:'passed',checks:['create multi-model deployment from installed weights','same weights in two deployments','independent aliases and ports','edit member settings in deployment','atomic requests','mobile layout']};
}
