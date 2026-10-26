// Read-only acceptance against the installed dashboard. Never loads or changes a model.
async page => {
  await page.unroute('**/api/**');
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', e => {if (e.type() === 'error') errors.push(e.text());});
  await page.route('**/api/**', route => {
    if (route.request().method() !== 'GET') {
      writes.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('http://127.0.0.1:8017/?product-smoke='+Date.now()+'#/overview');
  await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
  for (const section of ['Models','Deployments','Activity','Settings','Overview']) {
    await page.getByRole('navigation').getByRole('link',{name:section,exact:true}).click();
    await page.getByRole('heading',{name:section,exact:true}).waitFor();
    if (await page.getByRole('alert').count()) throw new Error(await page.getByRole('alert').innerText());
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    if (await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)) throw new Error(section+' mobile overflow');
    await page.setViewportSize({width:1440,height:1000});
  }
  await page.getByRole('button',{name:'Connect client'}).click();
  await page.getByRole('dialog').getByText(/http:\/\/127\.0\.0\.1:/).first().waitFor();
  await page.keyboard.press('Escape');
  await page.screenshot({path:'/tmp/opencode/menagerie-live-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/opencode/menagerie-live-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  if(errors.length || writes.length) throw new Error([...errors,...writes].join('\n'));
  return {pages:5,mobileOverflow:false,pageErrors:errors,mutations:writes.length};
}
