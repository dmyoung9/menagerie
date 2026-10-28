async (page) => {
  const errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.goto('http://127.0.0.1:8017/');
  await page.locator('nav').getByRole('link',{name:'Models',exact:true}).click();
  await page.getByRole('button',{name:'Discover',exact:true}).click();
  const catalog=page.getByRole('region',{name:'Model catalog',exact:true});
  const dialog=page.getByRole('dialog');

  // Hugging Face catalog: badges and a supplier link on the model card.
  await catalog.getByLabel('Catalog search').fill('unsloth/Qwen3.8-27B-GGUF');
  await catalog.getByRole('button',{name:'Search catalog',exact:true}).click();
  const hfCard=catalog.locator('[data-slot="card"]').filter({hasText:'unsloth/Qwen3.8-27B-GGUF'});
  await hfCard.waitFor({timeout:45000});
  const hfChips=await hfCard.locator('[data-slot="badge"]').allInnerTexts();
  if(!hfChips.includes('GGUF')||!hfChips.includes('27B')) throw new Error('Model card lacks format/parameter chips');
  if(await hfCard.getByRole('link',{name:/Open unsloth\/Qwen3.8-27B-GGUF/}).getAttribute('href')!=='https://huggingface.co/unsloth/Qwen3.8-27B-GGUF') throw new Error('Wrong supplier link');

  // The variant chooser is a Base UI modal, with hierarchical chip selection.
  await hfCard.getByRole('button',{name:'Choose variant'}).click();
  await dialog.locator('.variant-loading').waitFor({state:'detached',timeout:45000});
  if(await dialog.getAttribute('aria-modal')!=='true') throw new Error('Variant dialog is not modal');
  const quant=dialog.locator('fieldset').filter({hasText:'Quantization'});
  const suffix=dialog.locator('fieldset').filter({hasText:'Size / quality suffix'});
  if(!(await quant.getByRole('button',{name:'Q5_0',exact:true}).isDisabled())) throw new Error('Unavailable quantization is not disabled');
  await quant.getByRole('button',{name:'IQ4',exact:true}).click();
  if(await suffix.getByRole('button',{name:'XS',exact:true}).getAttribute('aria-pressed')!=='true') throw new Error('Single suffix was not auto-selected');
  if(await dialog.getByRole('button',{name:/Download/}).isDisabled()) throw new Error('Download is disabled for a complete single-shard variant');
  if(!(await dialog.locator('.variant-summary').innerText()).includes('IQ4_XS')) throw new Error('Selection summary is wrong');
  await quant.getByRole('button',{name:'Q8_K',exact:true}).click();
  if(!(await suffix.getByRole('button',{name:'M',exact:true}).isDisabled())) throw new Error('Invalid suffix is not disabled');
  if(!(await dialog.getByRole('button',{name:/Download/}).isDisabled())) throw new Error('Download is enabled without a complete selection');
  await suffix.getByRole('button',{name:'XL',exact:true}).click();

  // A split GGUF is one variant: submitting it sends the full shard set to the backend.
  await quant.getByRole('button',{name:'BF16',exact:true}).click();
  const bf16Summary=await dialog.locator('.variant-summary').innerText();
  if(!bf16Summary.includes('2 of 2 shards')||!bf16Summary.includes('2 files included')) throw new Error('Split GGUF was not described as a complete variant');
  let submitted=null;
  await page.route('**/api/downloads',async route=>{
    submitted=route.request().postDataJSON();
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:'job-test',state:'QUEUED',name:'Download model'})});
  });
  await dialog.getByRole('button',{name:/Download/}).click();
  await dialog.waitFor({state:'detached',timeout:15000});
  await page.unroute('**/api/downloads');
  if(!submitted?.filename?.match(/00001-of-00002\.gguf$/)||!submitted?.revision?.match(/^[a-f0-9]{40}$/)) throw new Error('Wrong split download submission');
  if(await page.evaluate(()=>document.body.style.overflow)!=='') throw new Error('Body scrolling was not restored');

  // A repository with one variant auto-selects it and disables the alternatives.
  await catalog.getByLabel('Catalog search').fill('ggml-org/gemma-3-270m-qat-GGUF');
  await catalog.getByRole('button',{name:'Search catalog',exact:true}).click();
  const singleCard=catalog.locator('[data-slot="card"]').filter({hasText:'ggml-org/gemma-3-270m-qat-GGUF'});
  await singleCard.getByRole('button',{name:'Choose variant'}).click();
  await dialog.locator('.variant-loading').waitFor({state:'detached',timeout:45000});
  if(await dialog.locator('fieldset').filter({hasText:'Quantization'}).getByRole('button',{name:'Q4_0',exact:true}).getAttribute('aria-pressed')!=='true') throw new Error('Single variant was not auto-selected');
  if(!(await dialog.locator('fieldset').filter({hasText:'Quantization'}).getByRole('button',{name:'IQ1',exact:true}).isDisabled())) throw new Error('Single variant alternatives are not disabled');
  if(await dialog.getByRole('button',{name:/Download/}).isDisabled()) throw new Error('Single variant download is disabled');
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});

  // Mobile: the modal fits the viewport and does not create page overflow.
  await page.setViewportSize({width:390,height:844});
  await page.reload();
  await page.getByRole('button',{name:'Toggle Sidebar'}).click();
  await page.locator('nav').getByRole('link',{name:'Models',exact:true}).click();
  await page.getByRole('button',{name:'Discover',exact:true}).click();
  await catalog.getByLabel('Catalog search').fill('ggml-org/gemma-3-270m-qat-GGUF');
  await catalog.getByRole('button',{name:'Search catalog',exact:true}).click();
  await catalog.locator('[data-slot="card"]').filter({hasText:'ggml-org/gemma-3-270m-qat-GGUF'}).getByRole('button',{name:'Choose variant'}).click();
  await dialog.locator('.variant-loading').waitFor({state:'detached',timeout:45000});
  const box=await dialog.boundingBox();
  if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)) throw new Error('Mobile overflow');
  if(!box||box.x<0||box.y<0||box.x+box.width>390||box.y+box.height>844) throw new Error('Modal exceeds the mobile viewport');
  await page.keyboard.press('Escape');
  if(errors.length)throw new Error(errors.join('\n'));
  return {hfCardChips:hfChips,splitShards:submitted,mobileModal:true,pageErrors:errors};
}
