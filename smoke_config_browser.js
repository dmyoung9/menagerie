// Exercises the real draft/discard API only. NEVER clicks Apply.
// Run from the Playwright CLI session directory with --filename=/absolute/path.
async page => {
  const jsErrors=[],consoleErrors=[],applies=[];
  page.on('pageerror',e=>jsErrors.push(e.message));
  page.on('console',e=>{if(e.type()==='error')consoleErrors.push(e.text());});
  page.on('request',r=>{if(r.url().endsWith('/api/config/apply'))applies.push(r.url());});
  const assert=(ok,msg)=>{if(!ok)throw new Error(msg);};
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('http://127.0.0.1:8017/#config');
  await page.locator('#config-model option').first().waitFor({state:'attached'});
  const baseline=await page.evaluate(()=>({sha:cfgData.base_sha,models:Object.keys(cfgData.models).length}));
  if(await page.evaluate(()=>!!cfgData.read_only)){
    assert(await page.locator('#config-source-mode').isVisible(),'Per-model source notice missing');
    assert(await page.locator('#config-form button[type=submit]').isDisabled(),'Legacy draft submission remains enabled');
    assert(await page.locator('#config-fields [data-enable]').evaluateAll(boxes=>boxes.every(box=>box.disabled)),'Legacy field editing remains enabled');
    assert(!await page.evaluate(()=>cfgData.apply_available),'Legacy apply remains advertised');
    const current=await page.evaluate(async()=> (await (await fetch('/api/config')).json()).base_sha);
    assert(current===baseline.sha,'Configuration changed during read-only inspection');
    assert(applies.length===0,'Unexpected live apply request');
    assert(jsErrors.length===0,jsErrors.join('\n'));
    return {models:baseline.models,changedLivePreset:false,applyRequests:0,checks:'per-model source notice, disabled legacy editing/apply, unchanged source revision'};
  }
  assert(await page.locator('#setting-ctx-size').isDisabled(),'Unselected setting is editable');
  await page.locator('#enable-ctx-size').check();
  const oldContext=Number(await page.locator('#setting-ctx-size').inputValue());
  const nextContext=oldContext===131072?65536:131072;
  await page.locator('#setting-ctx-size').fill(String(nextContext));
  await page.locator('#enable-parallel').check();
  await page.locator('#setting-parallel').fill('2');
  await Promise.all([
    page.waitForResponse(r=>r.url().endsWith('/api/config/draft')&&r.status()===200),
    page.locator('#config-form button[type=submit]').click()
  ]);
  await page.locator('#apply-reviewed').waitFor();
  const diff=await page.locator('.config-diff').innerText();
  assert(diff.includes(`+ctx-size = ${nextContext}`),'Context change absent from diff');
  assert(diff.includes('+parallel = 2'),'Inherited override absent from diff');
  assert(await page.locator('#apply-reviewed').isDisabled(),'Apply lacks confirmation guard');
  await page.locator('#clients-paused').check();
  assert(await page.locator('#apply-reviewed').isDisabled(),'Apply enabled without phrase');
  await page.locator('#apply-confirm').fill('yes');
  assert(await page.locator('#apply-reviewed').isDisabled(),'Wrong phrase accepted');
  await page.locator('#apply-confirm').fill('RESTART SHELF');
  assert(await page.locator('#apply-reviewed').isEnabled(),'Valid confirmation not accepted');
  // Refresh must retain the typed phrase and the original editor base revision.
  await page.evaluate(()=>loadConfig());
  assert(await page.locator('#apply-confirm').inputValue()==='RESTART SHELF','Polling erased confirmation');
  await page.screenshot({path:'/tmp/opencode/menagerie-preset-review.png',fullPage:true});
  assert(jsErrors.length===0&&consoleErrors.length===0,[...jsErrors,...consoleErrors].join('\n'));
  // Simulate an outside edit only in the browser's GET response. Do not edit
  // shelf.ini, and intercept the resulting POST so it cannot create another job.
  const config=await page.evaluate(()=>cfgData);
  await page.route('**/api/config',r=>r.fulfill({json:{...config,base_sha:'0'.repeat(64)}}));
  await page.evaluate(()=>loadConfig());
  let submittedSha=null;
  await page.route('**/api/config/draft',r=>{
    submittedSha=r.request().postDataJSON().base_sha;
    return r.fulfill({status:409,json:{error:'Fixture: stale draft; reload the file'}});
  });
  await page.locator('#config-form button[type=submit]').click();
  await page.locator('#config-error').filter({hasText:'stale draft'}).waitFor();
  assert(submittedSha===baseline.sha,'Polling silently rebased the pending edit');
  await page.unroute('**/api/config');await page.unroute('**/api/config/draft');
  await page.evaluate(()=>loadConfig());
  await Promise.all([
    page.waitForResponse(r=>r.url().endsWith('/api/config/discard')&&r.status()===200),
    page.locator('#discard-draft').click()
  ]);
  await page.locator('#job-status').filter({hasText:'discarded'}).waitFor();
  for(const width of [1280,768,390]){
    await page.setViewportSize({width,height:900});
    await page.locator('nav a[data-view=config]').click();
    assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),`Config view overflows ${width}px`);
  }
  await page.locator('#reload-config').click();
  await page.screenshot({path:'/tmp/opencode/menagerie-preset-mobile.png',fullPage:true});
  const current=await page.evaluate(async()=> (await (await fetch('/api/config')).json()).base_sha);
  assert(current===baseline.sha,'Live preset changed while drafting');
  assert(applies.length===0,'Unexpected live apply request');
  assert(jsErrors.length===0,jsErrors.join('\n'));
  assert(consoleErrors.every(e=>e.includes('409')),consoleErrors.join('\n'));
  await page.setViewportSize({width:1440,height:1000});
  return {models:baseline.models,changedLivePreset:false,applyRequests:applies.length,checks:'draft/diff, confirmation gates, poll retention, stale edit, discard, responsive layouts'};
}
