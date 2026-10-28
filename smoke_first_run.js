// Fixture-only acceptance. Run with Vite on :8037; never contacts a live daemon.
async page => {
  await page.unroute('**/api/**');
  await page.unroute('**/v1/chat/completions');
  const assert = (condition, text) => {if (!condition) throw Error(text);};
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  let ready = false, fail = false;
  const deployment = {id:'starter',name:'Starter',alias:'starter',enabled:true,state:'READY',residency:'on-demand',lifecycle:{serving:true},profile_snapshot:{config:{},catalog:{}}};
  await page.route('**/api/**', route => {
    const path = route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    let body = [];
    if (path === '/api/status') body = {csrf_token:'fixture',host:{gpus:[],ram_available_mib:null},settings:{},gateway_url:'http://127.0.0.1:8001/v1'};
    if (path === '/api/registry/deployments') body = ready ? [deployment] : [];
    if (path === '/api/engines/releases') body = {engines:[]};
    if (path === '/api/integration/opencode') body = {endpoint:'http://127.0.0.1:8001/v1'};
    if (path === '/api/events/stream') return route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'});
    return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.route('**/v1/chat/completions', route => {
    const body = route.request().postDataJSON();
    assert(body.model === 'starter' && body.stream && body.max_tokens === 128, 'Wrong gateway test payload');
    return fail ? route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Runtime ran out of memory'}})}) : route.fulfill({contentType:'text/event-stream',body:'data: {"choices":[{"delta":{"content":"Hello friend"}}]}\n\ndata: [DONE]\n\n'});
  });
  await page.goto('http://127.0.0.1:8037/');
  await page.getByText('GPU telemetry unavailable. A CPU engine', {exact:false}).waitFor();
  assert(await page.getByRole('button',{name:'Send test prompt'}).isDisabled(), 'Unloaded deployment must not be tested');
  assert(await page.getByRole('link',{name:'Use an existing model / Add from File'}).count() === 1, 'Existing-model path missing');
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'First-use content overflows mobile');
  ready = true; await page.reload();
  await page.getByText('Get your first response',{exact:true}).click();
  await page.getByRole('button',{name:'Send test prompt'}).click();
  await page.getByLabel('Test response').filter({hasText:'Hello friend'}).waitFor();
  fail = true; await page.getByRole('button',{name:'Send test prompt'}).click();
  await page.getByRole('alert').filter({hasText:'Runtime ran out of memory'}).waitFor();
  fail = false; await page.getByRole('button',{name:'Send test prompt'}).click();
  await page.getByLabel('Test response').filter({hasText:'Hello friend'}).waitFor();
  assert(errors.length === 0, errors.join('\n'));
  return 'PASS: missing GPU/RAM telemetry, existing model route, disabled pre-ready request, mobile layout, streamed response, actionable failure and retry';
}
