async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if(message.type()==='error') errors.push(message.text()); });
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('http://127.0.0.1:8017/');
  await page.getByText('Bonsai', {exact:false}).first().waitFor();
  for (const tab of ['Models','Runtimes','Profiles','Deployments','History','Settings','Overview']) {
    await page.locator('nav').getByRole('button',{name:tab,exact:tab!=='Deployments'}).click();
    if (await page.getByRole('alert').count()) throw new Error(await page.getByRole('alert').innerText());
  }
  await page.screenshot({path:'/tmp/opencode/menagerie-desktop.png',fullPage:true});
  await page.locator('nav').getByRole('button',{name:'Profiles',exact:true}).click();
  await page.getByRole('button',{name:'Clone',exact:true}).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Display name',{exact:true}).fill('Disposable UI acceptance profile');
  await dialog.getByLabel(/Context pool/).fill('20480');
  await dialog.getByRole('button',{name:'Save revision',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  const row = page.getByRole('row').filter({hasText:'Disposable UI acceptance profile'});
  await row.waitFor();
  if (!(await row.innerText()).includes('20,480')) throw new Error('Typed profile context was not saved');
  await row.getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Remove',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Remove registry entry',exact:true}).click();
  await row.waitFor({state:'hidden'});
  await page.locator('nav').getByRole('button',{name:'Overview',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  if (await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)) throw new Error('Mobile page overflow');
  await page.screenshot({path:'/tmp/opencode/menagerie-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  if(errors.length) throw new Error(errors.join('\n'));
  return {pages:7,profileCreateAndDelete:'passed',typedContext:'passed',mobileOverflow:false,pageErrors:errors};
}
