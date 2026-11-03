import { test, expect } from './fixtures';
import { deploymentDraft } from '../../src/contracts';
import AxeBuilder from '@axe-core/playwright';

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

for (const width of [1440, 576, 320]) {
  test(`draft-token bounds share one accessible range slider at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const legacy = width === 576;
    const keys = legacy
      ? ['draft-min', 'draft-max']
      : ['spec-draft-n-min', 'spec-draft-n-max'];
    Object.assign(fixture.registry.models[0], {
      metadata: {
        'example.block_count': 32,
        'example.nextn_predict_layers': 1,
      },
    });
    Object.assign(fixture.registry.runtimes[0].capabilities!.schema!, {
      'spec-type': { type: 'string' },
      [keys[0]]: {
        type: 'integer',
        min: 0,
        max: 1048576,
        engine_default: 0,
        label: 'Minimum draft tokens',
      },
      [keys[1]]: {
        type: 'integer',
        min: 1,
        max: 1048576,
        engine_default: 3,
        label: 'Maximum draft tokens',
      },
      'top-p': {
        type: 'number',
        min: 0,
        max: 1,
        engine_default: 0.95,
        label: 'Top-p',
      },
      'min-p': {
        type: 'number',
        min: 0,
        max: 1,
        engine_default: 0.05,
        label: 'Min-p',
      },
    });
    await page.goto('/#/deployments/idle/configuration');
    const range = page.getByRole('group', {
      name: 'Draft tokens',
      exact: true,
    });
    const minimum = range.getByRole('slider', {
      name: 'Minimum draft tokens range',
      exact: true,
    });
    const maximum = range.getByRole('slider', {
      name: 'Maximum draft tokens range',
      exact: true,
    });
    const minInput = range.getByRole('spinbutton', {
      name: 'Minimum draft tokens',
      exact: true,
    });
    const maxInput = range.getByRole('spinbutton', {
      name: 'Maximum draft tokens',
      exact: true,
    });
    await expect(range.locator('[data-slot="slider"]')).toHaveCount(1);
    await expect(minimum).toBeDisabled();
    await expect(maximum).toBeDisabled();
    await expect(minInput).toHaveValue('0');
    await expect(maxInput).toHaveValue('3');
    await expect(
      page.getByRole('button', { name: 'Discard', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('combobox', { name: 'MTP head', exact: true })
      .selectOption('embedded');
    await minimum.focus();
    await page.keyboard.press('ArrowRight');
    await expect(minInput).toHaveValue('1');
    await expect(maxInput).toHaveValue('3');
    await maximum.focus();
    await page.keyboard.press('ArrowRight');
    await expect(maxInput).toHaveValue('4');
    await minInput.fill('2');
    await expect(minimum).toHaveAttribute('aria-valuenow', '2');
    await maximum.focus();
    await page.keyboard.press('Home');
    await expect(maxInput).toHaveValue('2');
    await maxInput.fill('5');
    await minimum.focus();
    await page.keyboard.press('End');
    await expect(minInput).toHaveValue('5');
    await minInput.fill('6');
    await expect(range.getByRole('alert')).toBeVisible();
    await expect(minInput).toBeVisible();
    await expect(maxInput).toBeVisible();
    const writesBefore = fixture.writes.filter(
      (w) => w.path === '/api/deployments?expected=1',
    ).length;
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect(
      fixture.writes.filter((w) => w.path === '/api/deployments?expected=1'),
    ).toHaveLength(writesBefore);
    await minInput.fill('1');
    await maxInput.fill('8');
    await expect(minimum).toHaveAttribute('aria-valuenow', '1');
    await expect(maximum).toHaveAttribute('aria-valuenow', '8');
    await range.scrollIntoViewIfNeeded();
    await expect(range.locator('[data-slot="slider-range"]')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`draft-range-${width}.png`),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await expect(
      page.getByRole('slider', { name: 'Top-p range', exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole('slider', { name: 'Min-p range', exact: true }),
    ).toHaveCount(1);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(
        () =>
          fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
      )
      .toBe(2);
    const saved = deploymentDraft(
      fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!
        .body,
    ).configuration!.config;
    expect(saved).toMatchObject({ [keys[0]]: 1, [keys[1]]: 8 });
    await page
      .getByRole('combobox', { name: 'MTP head', exact: true })
      .selectOption('');
    await expect(minimum).toBeDisabled();
    await expect(maximum).toBeDisabled();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(minInput).toHaveValue('1');
    await expect(maxInput).toHaveValue('8');
    await expect(minimum).toBeEnabled();
  });
}
