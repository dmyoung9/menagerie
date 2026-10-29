// Fixture callback for a fresh browser context against Vite :8042.
// All APIs mocked; never changes live inference or registry state.
async page => {
  await page.context().route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:8042' ? route.continue() : route.abort());
  await page.unroute('**/api/**');
  const assert = (ok, text) => {if (!ok) throw new Error(text);};
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(String(e)));
  const schema = {
    'ctx-size': {type:'integer',label:'Context pool',min:512,max:131072,default:8192},
    parallel: {type:'integer',label:'Parallel slots',min:1,max:8,default:1},
    threads: {type:'integer',label:'CPU threads',min:1,max:256,default:6},
    'gpu-layers': {type:'string',label:'GPU layers',default:'all'},
    'flash-attn': {type:'enum',label:'Flash attention',choices:['on','off','auto'],default:'on'},
  };
  const data = {models:[{id:'model',name:'Test Model',format:'gguf'}], runtimes:[{id:'engine',name:'Test engine',capabilities:{formats:['gguf'],schema}}], profiles:[], deployments:[], jobs:[]};
  let serving = [];
  await page.route('**/api/**', async route => {
    const path = route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const send = body => route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if (path === '/api/status') return send({csrf_token:'test',host:{cpu_count:12,gpus:[{index:0,name:'Test GPU'}]},serving_deployments:serving,settings:{}});
    if (path.startsWith('/api/registry/')) return send(data[path.split('/').at(-1)] || []);
    if (path === '/api/events/stream') return route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'});
    if (path === '/api/integration/opencode') return send({endpoint:'http://localhost/v1'});
    if (path.startsWith('/api/history/')) return send([]);
    if (path.endsWith('/engine-recommendation')) return send({});
    if (path === '/api/resources/preview') return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Telemetry unavailable in this form fixture'})});
    if (path === '/api/deployment-sets') {
      const v = route.request().postDataJSON(); writes.push(v);
      const members = v.members.map((m,i) => ({...m,id:m.id || 'm'+i,profile_snapshot:m.configuration,state:'STOPPED'}));
      const saved = {...v,id:'unit',revision:writes.length,members,member_ids:members.map(m=>m.id),multi_model:true,state:'STOPPED',lifecycle:{serving:true}};
      serving = [saved]; data.deployments = members; return send(saved);
    }
    throw new Error('Unmocked API: '+path);
  });
  await page.setViewportSize({width:390,height:844});
  await page.goto('http://127.0.0.1:8042/#/deployments');
  await page.reload();
  await page.getByText('No enabled deployments',{exact:true}).waitFor();
  await page.getByRole('button',{name:'New deployment',exact:true}).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Name',{exact:true}).fill('My pair');
  await d.getByRole('button',{name:'Add model',exact:true}).click();
  await d.getByLabel('Context pool',{exact:true}).fill('24576');
  await d.getByText('Memory & GPU',{exact:true}).click();
  await d.getByLabel('GPU layer mode').selectOption('custom');
  await d.getByLabel('GPU layer count').fill('20');
  await d.getByRole('button',{name:'Auto',exact:true}).click();
  await d.getByText('Performance',{exact:true}).click();
  assert(await d.getByRole('spinbutton',{name:'CPU threads',exact:true}).getAttribute('max') === '12','CPU limit must use host capacity');
  await d.getByRole('spinbutton',{name:'CPU threads',exact:true}).fill('8');
  await d.getByRole('button',{name:'Add model',exact:true}).click();
  await d.locator('[data-model-index="1"]:not([hidden])').waitFor();
  assert(await d.getByLabel('Model display name',{exact:true}).filter({visible:true}).count() === 1,'Only one model editor should be visible');
  const secondAlias = await d.getByLabel('API model ID',{exact:true}).filter({visible:true}).inputValue();
  const firstAlias = await d.getByLabel('API model ID',{exact:true}).first().inputValue();
  await d.getByLabel('API model ID',{exact:true}).filter({visible:true}).fill(firstAlias);
  assert(await d.getByRole('button',{name:'Save deployment',exact:true}).isDisabled(),'Duplicate aliases must block saving');
  await d.getByRole('alert').filter({hasText:'already in use'}).filter({visible:true}).waitFor();
  await d.getByLabel('API model ID',{exact:true}).filter({visible:true}).fill(secondAlias);
  await d.getByLabel('Context pool',{exact:true}).filter({visible:true}).fill('16384');
  await d.getByText('Memory & GPU',{exact:true}).filter({visible:true}).click();
  await d.getByRole('button',{name:'Off',exact:true}).click();
  await d.getByRole('button',{name:'Test Model',exact:true}).first().click();
  assert(await d.getByLabel('Context pool',{exact:true}).filter({visible:true}).inputValue() === '24576','Switching models lost draft');
  assert(await d.getByRole('button',{name:'Auto',exact:true}).getAttribute('aria-pressed')==='true','Model option groups interfere with one another');
  const geometry = await d.evaluate(el => {const input = [...el.querySelectorAll('input')].find(i=>i.getAttribute('aria-label')==='Context pool' && i.offsetWidth); const r=el.getBoundingClientRect(); return {width:r.width,input:input.getBoundingClientRect().width,overflow:el.scrollWidth>r.width};});
  assert(geometry.width === 390 && geometry.input > 100 && !geometry.overflow,'Mobile editing is squeezed or overflowing');
  await d.getByRole('button',{name:'Save deployment',exact:true}).click();
  await d.waitFor({state:'hidden'});
  assert(writes[0].members.length===2,'Atomic creation lost members');
  assert(writes[0].members[0].configuration.config['ctx-size']===24576,'Exact context was lost');
  assert(writes[0].members[0].configuration.config['gpu-layers']==='20','GPU layer count was lost');
  assert(writes[0].members[0].configuration.config['flash-attn']==='auto','Flash attention was lost');
  assert(writes[0].members[1].configuration.config['flash-attn']==='off','Second model radio value was lost');
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await d.getByLabel('Name',{exact:true}).fill('Unsaved');
  await d.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'Keep editing'}).click();
  assert(await d.isVisible(),'Dirty editor closed without consent');
  await d.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'Discard changes'}).click();
  await d.waitFor({state:'hidden'});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  assert(await d.getByLabel('Name',{exact:true}).inputValue()==='My pair','Discarded changes leaked into saved state');
  await d.getByRole('button',{name:'Save deployment',exact:true}).click();
  await d.waitFor({state:'hidden'});
  assert(writes[1].members[1].configuration.config['ctx-size']===16384,'Editing lost unselected member');
  assert(!errors.length,errors.join('\n'));
  const result = {result:'passed',checks:['mobile full-width editor','model draft navigation','host-aware threads','GPU layer count','flash attention radios','exact context','atomic save','discard protection','desktop edit round-trip']};
  await page.evaluate(result => {window.formAuditResult = result;}, result);
  console.log(JSON.stringify(result));
  return result;
}
