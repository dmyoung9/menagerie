// Run using the existing Playwright CLI:
// playwright-cli -s=menagerie run-code --filename=/absolute/path/smoke_browser.js
// The app must already be running. No inference or model mutation is performed.
async page => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if(e.type()==='error') errors.push(e.text()); });
  const assert = (condition, message) => { if(!condition) throw new Error(message); };
  await page.goto('http://127.0.0.1:8017');
  await page.locator('#models button').first().waitFor();
  const count = await page.locator('#models button').count();
  assert(count > 0, 'No models');
  await page.locator('#models button').first().click();
  await page.locator('#model-transitions').waitFor();
  assert(await page.locator('#model-dialog').isVisible(), 'Model dialog not visible');
  assert((await page.locator('#model-detail').innerText()).includes('Effective settings'), 'No configuration');
  await page.keyboard.press('Escape');
  await page.locator('nav a[data-view="estimator"]').click();
  await page.locator('#fit option').first().waitFor({state:'attached'});
  await page.locator('#parallel').selectOption('2');
  await page.locator('#other').fill('99999');
  await page.locator('#estimate-form button').click();
  await page.locator('#estimate-result .projection.bad').waitFor();
  assert((await page.locator('#estimate-result').innerText()).includes('32,768 tokens'), 'Parallel slots not dividing context');
  await page.locator('#other').fill('1500');
  await page.locator('#estimate-form button').click();
  await page.locator('nav a[data-view="results"]').click();
  await page.locator('#result-list details').first().waitFor();
  const validArms = await page.locator('#result-list > details').count();
  await page.locator('#show-artifacts').check();
  const allArms = await page.locator('#result-list > details').count();
  assert(allArms > validArms, 'Invalid artifacts not distinguishable');
  await page.locator('#result-search').fill('this-will-not-match-any-arm');
  assert((await page.locator('#result-list').innerText()).includes('No matching'), 'Filter failed');
  await page.locator('#result-search').fill('');
  await page.locator('#result-list > details > summary').first().click();
  assert(await page.locator('.result[open] .provenance').isVisible(), 'No provenance');
  await page.locator('nav a[data-view="gpu"]').click();
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/history?hours=2160')),
    page.locator('#hours').selectOption('2160')
  ]);
  await page.locator('#gpu-chart svg').waitFor();
  await page.locator('nav a[data-view="events"]').click();
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/events?kind=sleep')),
    page.locator('#event-kind').selectOption('sleep')
  ]);
  assert(await page.locator('#event-list .event').count() > 0, 'Sleep evidence missing');
  const layouts = [];
  for(const size of [{width:1280,height:800},{width:768,height:1024},{width:390,height:844}]) {
    await page.setViewportSize(size);
    for(const view of ['shelf','gpu','estimator','results','events']) {
      await page.locator(`nav a[data-view="${view}"]`).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert(!overflow, `${view} overflows at ${size.width}px`);
    }
    layouts.push(size.width);
  }
  // Simulate an unavailable dashboard API, without touching the real shelf.
  assert(errors.length===0, errors.join('\n'));
  await page.route('**/api/status', route => route.fulfill({status:503,body:'offline'}));
  await page.evaluate(() => refresh());
  assert((await page.locator('#alert').innerText()).includes('connection lost'), 'Outage warning missing');
  await page.unroute('**/api/status');
  await page.evaluate(() => refresh());
  assert(!await page.locator('#alert').isVisible(), 'Outage did not recover');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('nav a[data-view="shelf"]').click();
  await page.screenshot({path:'/tmp/opencode/menagerie-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/opencode/menagerie-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  assert(errors.filter(e=>!e.includes('503')).length===0, errors.join('\n'));
  return {models:count,validArms,allArms,layouts,checks:'model detail, estimates, filters, provenance, history, events, outage, no overflow'};
}
