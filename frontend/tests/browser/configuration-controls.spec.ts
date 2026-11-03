import { test, expect } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

test('projectors and MTP heads use matching inventory and None clears both draft aliases', async ({
  page,
  fixture,
}) => {
  const model = fixture.registry.models[0];
  Object.assign(model, {
    repo: 'fixture/model',
    source_revision: 'a'.repeat(40),
    metadata: {
      'example.block_count': 32,
      'example.nextn_predict_layers': 1,
      projector: { name: 'Matching projector', path: '/models/projector.gguf' },
    },
  });
  fixture.registry.models.push(
    {
      ...model,
      id: 'head',
      name: 'Matching head',
      local_path: '/models/head.gguf',
      metadata: { 'example.block_count': 1, 'example.nextn_predict_layers': 1 },
    },
    {
      ...model,
      id: 'unrelated',
      name: 'Unrelated head',
      source_revision: 'b'.repeat(40),
      local_path: '/models/other.gguf',
      metadata: { 'example.block_count': 1, 'example.nextn_predict_layers': 1 },
    },
  );
  const schema = fixture.registry.runtimes[0].capabilities!.schema!;
  Object.assign(schema, {
    mmproj: { type: 'string' },
    'spec-type': { type: 'string' },
    'spec-draft-model': { type: 'string' },
    'model-draft': { type: 'string' },
    'spec-draft-n-max': {
      type: 'integer',
      min: 1,
      max: 1048576,
      engine_default: 3,
      label: 'Maximum draft tokens',
    },
    'spec-draft-n-min': {
      type: 'integer',
      min: 0,
      max: 1048576,
      engine_default: 0,
      label: 'Minimum draft tokens',
    },
  });
  const config = fixture.registry.deployments.find((d) => d.id === 'idle')!
    .profile_snapshot!.config;
  Object.assign(config, {
    'spec-type': 'draft-mtp',
    'spec-draft-model': '/old/custom.gguf',
    'model-draft': '/old/alias.gguf',
    extension: 'keep',
  });
  await page.goto('/#/deployments/idle/configuration');
  const head = page.getByRole('combobox', { name: 'MTP head', exact: true });
  const projector = page.getByRole('combobox', {
    name: 'Projector',
    exact: true,
  });
  await expect(head).toHaveValue('/old/custom.gguf');
  await expect(head.locator('option')).toHaveText([
    'None',
    'Embedded',
    'Configured head (not in matching inventory)',
    'Matching head',
  ]);
  await expect(projector).toHaveValue('');
  await projector.selectOption('/models/projector.gguf');
  await head.selectOption('/models/head.gguf');
  await expect(
    page.getByLabel('Maximum draft tokens', { exact: true }),
  ).toBeEnabled();
  await head.selectOption('embedded');
  await expect(
    page.getByLabel('Maximum draft tokens', { exact: true }),
  ).toHaveValue('3');
  await head.selectOption('');
  await expect(
    page.getByLabel('Maximum draft tokens', { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel('Minimum draft tokens', { exact: true }),
  ).toBeDisabled();
  await projector.selectOption('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  const saved = deploymentDraft(
    fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!.body,
  ).configuration!.config;
  expect(saved).toMatchObject({ 'spec-type': 'none', extension: 'keep' });
  for (const key of [
    'spec-draft-model',
    'model-draft',
    'mmproj',
    'spec-draft-n-min',
    'spec-draft-n-max',
  ])
    expect(saved).not.toHaveProperty(key);
});

test('a model name containing MTP does not offer Embedded without GGUF evidence', async ({
  page,
  fixture,
}) => {
  fixture.registry.models[0].name = 'Example MTP';
  Object.assign(fixture.registry.runtimes[0].capabilities!.schema!, {
    'spec-type': { type: 'string' },
    'spec-draft-model': { type: 'string' },
  });
  await page.goto('/#/deployments/idle/configuration');
  await expect(
    page
      .getByRole('combobox', { name: 'MTP head', exact: true })
      .locator('option'),
  ).toHaveText(['None']);
});

test('numeric engine defaults are real values, editable by sliders, and stay implicit until edited', async ({
  page,
  fixture,
}) => {
  const schema = fixture.registry.runtimes[0].capabilities!.schema!;
  Object.assign(schema, {
    temp: {
      type: 'number',
      min: 0,
      max: 5,
      default: 1,
      engine_default: 0.8,
      label: 'Temperature',
    },
    'top-p': {
      type: 'number',
      min: 0,
      max: 1,
      engine_default: 0.95,
      label: 'Top-p',
    },
    'batch-size': {
      type: 'integer',
      min: 1,
      max: 8192,
      default: 512,
      engine_default: 2048,
      label: 'Batch size',
    },
    'ubatch-size': {
      type: 'integer',
      min: 1,
      max: 8192,
      default: 256,
      engine_default: 512,
      label: 'Physical batch',
    },
    threads: {
      type: 'integer',
      min: 1,
      max: 256,
      default: 6,
      engine_default: -1,
      label: 'CPU threads',
    },
    'threads-batch': {
      type: 'integer',
      min: 1,
      max: 256,
      default: 6,
      default_from: 'threads',
      label: 'Batch threads',
    },
  });
  await page.goto('/#/deployments/idle/configuration');
  for (const [label, value] of [
    ['Temperature', '0.8'],
    ['Top-p', '0.95'],
    ['Batch size', '2048'],
    ['Physical batch', '512'],
    ['CPU threads', '-1'],
    ['Batch threads', '-1'],
  ]) {
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
    await expect(
      page.getByRole('slider', { name: label + ' range', exact: true }),
    ).toBeEnabled();
  }
  await expect(
    page.getByRole('button', { name: 'Discard', exact: true }),
  ).toBeDisabled();
  const temp = page.getByRole('slider', {
    name: 'Temperature range',
    exact: true,
  });
  await temp.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('Temperature', { exact: true })).toHaveValue(
    '0.81',
  );
  await page.getByLabel('CPU threads', { exact: true }).fill('4');
  await expect(page.getByLabel('Batch threads', { exact: true })).toHaveValue(
    '4',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  const saved = deploymentDraft(
    fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!.body,
  ).configuration!.config;
  expect(saved).toMatchObject({ temp: 0.81, threads: 4 });
  for (const key of ['threads-batch', 'batch-size', 'ubatch-size', 'top-p'])
    expect(saved).not.toHaveProperty(key);
});
