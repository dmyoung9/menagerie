import { test, expect } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { deploymentDraft } from '../../src/contracts';

for (const width of [1440, 576, 320]) {
  test(`open configuration groups preserve tuning and capabilities at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const engine = fixture.registry.runtimes[0];
    engine.capabilities!.schema = {
      ...engine.capabilities!.schema,
      mmproj: { type: 'string', label: 'Multimodal projector path' },
      'spec-type': { type: 'string', label: 'Speculative decoding type (MTP)' },
      'spec-draft-model': { type: 'string', label: 'MTP / draft model path' },
      'spec-draft-n-max': {
        type: 'integer',
        min: 1,
        max: 32,
        engine_default: 3,
        label: 'Maximum draft tokens',
      },
      'spec-draft-n-min': {
        type: 'integer',
        min: 0,
        max: 32,
        engine_default: 0,
        label: 'Minimum draft tokens',
      },
      'n-cpu-moe': {
        type: 'integer',
        min: 0,
        max: 64,
        label: 'MoE expert layers on CPU',
      },
      'cache-type-k': {
        type: 'enum',
        choices: ['f16', 'q8_0'],
        label: 'K cache',
      },
      'reasoning-budget': {
        type: 'integer',
        min: -1,
        max: 1048576,
        label: 'Default reasoning budget',
      },
      ...Object.fromEntries(
        [
          'temp',
          'top-p',
          'top-k',
          'min-p',
          'presence-penalty',
          'repeat-penalty',
        ].map((key) => [
          key,
          {
            type: key === 'top-k' ? 'integer' : 'number',
            min: 0,
            max: key === 'top-k' ? 100 : 2,
            label: key,
          },
        ]),
      ),
    };
    const idle = fixture.registry.deployments.find((d) => d.id === 'idle')!;
    idle.profile_snapshot!.config.extension = 'preserved';
    fixture.registry.models[0].metadata = {
      ...fixture.registry.models[0].metadata,
      'example.block_count': 32,
      'example.nextn_predict_layers': 1,
      projector: {
        name: 'example-mmproj.gguf',
        path: '/models/example-mmproj.gguf',
      },
    };
    await page.route('**/api/models/model/engine-recommendation', (route) =>
      route.fulfill({
        json: {
          engine: 'prism',
          reason:
            'This ternary artifact needs specialized kernels; use the Prism build rather than stock llama.cpp.',
        },
      }),
    );
    await page.goto('/#/deployments/idle/configuration');
    const config = page.locator('form.configuration-editor');
    for (const title of [
      'Identity',
      'Model & engine',
      'Memory & placement',
      'Performance',
      'Generation',
      'Modalities & capabilities',
      'Lifecycle',
      'Networking',
    ]) {
      await expect(
        config.getByRole('heading', { name: title, exact: true }),
      ).toBeVisible();
    }
    await expect(config.locator('summary')).toHaveText([
      'Advanced model settings',
      'Runtime options (JSON)',
      'Engine arguments',
      'Client capabilities (JSON)',
    ]);
    await expect(page.getByText('Model metadata', { exact: true })).toHaveCount(
      0,
    );
    await expect(config.getByText(/^Effective:/)).toHaveCount(0);
    await expect(
      config.getByText(
        'Deployment override, then model default, then engine default.',
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(
      config.getByText(/This ternary artifact needs specialized kernels/),
    ).toHaveCount(0);
    const model = config.locator('[data-settings-section="model"]');
    const engineField = model.locator('[data-slot="field"]').filter({
      has: page.getByRole('combobox', { name: 'Engine', exact: true }),
    });
    await expect(
      engineField.getByRole('button', {
        name: 'Install an engine',
        exact: true,
      }),
    ).toBeVisible();
    const multimodal = model.getByRole('group', {
      name: 'Multimodal',
      exact: true,
    });
    const mtp = model.getByRole('group', { name: 'MTP', exact: true });
    await expect(
      multimodal.getByRole('combobox', { name: 'Projector', exact: true }),
    ).toBeVisible();
    await expect(
      multimodal.getByLabel('Speculative decoding type (MTP)', { exact: true }),
    ).toHaveCount(0);
    await expect(
      mtp.getByRole('combobox', { name: 'MTP head', exact: true }),
    ).toBeVisible();
    await expect(
      mtp.getByLabel('Multimodal projector path', { exact: true }),
    ).toHaveCount(0);
    await expect(multimodal.getByRole('button')).toHaveCount(0);
    await multimodal
      .getByRole('combobox', { name: 'Projector', exact: true })
      .selectOption('/models/example-mmproj.gguf');
    await expect(
      multimodal.getByRole('combobox', { name: 'Projector', exact: true }),
    ).toHaveValue('/models/example-mmproj.gguf');
    await expect(
      mtp.getByRole('combobox', { name: 'MTP head', exact: true }),
    ).toHaveValue('');
    await expect(
      mtp.getByLabel('Maximum draft tokens', { exact: true }),
    ).toHaveValue('3');
    await expect(
      mtp.getByLabel('Minimum draft tokens', { exact: true }),
    ).toHaveValue('0');
    await expect(
      mtp.getByLabel('Maximum draft tokens', { exact: true }),
    ).toBeDisabled();
    await expect(
      mtp.getByRole('slider', {
        name: 'Maximum draft tokens range',
        exact: true,
      }),
    ).toBeDisabled();
    expect(
      await model
        .getByRole('button', { name: 'Install an engine', exact: true })
        .evaluate(
          (button) =>
            !!(
              button.compareDocumentPosition(
                button
                  .closest('[data-settings-section="model"]')!
                  .querySelector('select[id]:not([required])')!,
              ) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ),
    ).toBe(true);
    await expect(
      config.getByLabel('Default reasoning budget', { exact: true }),
    ).toHaveCount(0);
    const inputs = config
      .getByRole('group', {
        name: 'Input modalities',
        exact: true,
      })
      .first();
    const capabilities = config.getByRole('group', {
      name: 'Capabilities',
      exact: true,
    });
    await expect(inputs.getByRole('button')).toHaveCount(4);
    await expect(
      inputs.getByRole('button', { name: 'Tools', exact: true }),
    ).toHaveCount(0);
    await expect(
      inputs.getByRole('button', { name: 'Reasoning', exact: true }),
    ).toHaveCount(0);
    await expect(
      inputs.getByRole('button', { name: 'Text', exact: true }),
    ).toBeDisabled();
    await expect(
      inputs.getByRole('button', { name: 'Text', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await inputs.getByRole('button', { name: 'Images', exact: true }).click();
    await expect(
      inputs.getByRole('button', { name: 'Text', exact: true }),
    ).toBeEnabled();
    await inputs.getByRole('button', { name: 'Text', exact: true }).click();
    await expect(
      inputs.getByRole('button', { name: 'Images', exact: true }),
    ).toBeDisabled();
    await capabilities
      .getByRole('button', { name: 'Tools', exact: true })
      .click();
    await capabilities
      .getByRole('button', { name: 'Reasoning', exact: true })
      .click();
    await expect(
      config.getByLabel('Default reasoning budget', { exact: true }),
    ).toBeVisible();
    await expect(
      inputs.getByRole('button', { name: 'Images', exact: true }),
    ).toBeDisabled();
    const outputs = config
      .getByRole('group', {
        name: 'Output modalities',
        exact: true,
      })
      .first();
    await outputs.getByRole('button', { name: 'Image', exact: true }).click();
    await outputs.getByRole('button', { name: 'Text', exact: true }).click();
    await expect(
      outputs.getByRole('button', { name: 'Image', exact: true }),
    ).toBeDisabled();
    for (const [key, value] of Object.entries({
      temp: '0.8',
      'top-p': '0.9',
      'top-k': '40',
      'min-p': '0.05',
      'presence-penalty': '0.2',
      'repeat-penalty': '1.1',
    })) {
      await config.getByLabel(key, { exact: true }).fill(value);
    }
    await config
      .getByRole('combobox', { name: 'MTP head', exact: true })
      .selectOption('embedded');
    await expect(
      config.getByLabel('MTP / draft model path', { exact: true }),
    ).toHaveCount(0);
    await config.getByLabel('Maximum draft tokens', { exact: true }).fill('4');
    await config
      .getByLabel('MoE expert layers on CPU', { exact: true })
      .fill('4');
    await config
      .getByLabel('Default reasoning budget', { exact: true })
      .fill('8192');
    await expect(
      page.getByRole('complementary', { name: 'Deployment resource preview' }),
    ).toContainText('GPU 0');
    const footer = config.locator('.configuration-save-bar');
    const padding = await footer.evaluate((el) => ({
      left: parseFloat(getComputedStyle(el).paddingLeft),
      right: parseFloat(getComputedStyle(el).paddingRight),
    }));
    expect(padding.left).toBeGreaterThanOrEqual(16);
    expect(padding.right).toBeGreaterThanOrEqual(16);
    if (width < 1100) {
      const networkBox = (await config
        .locator('[data-settings-section="network"]')
        .boundingBox())!;
      const resourceBox = (await config
        .locator('.configuration-resources')
        .boundingBox())!;
      expect(
        resourceBox.y - networkBox.y - networkBox.height,
      ).toBeGreaterThanOrEqual(16);
    }
    await page.getByRole('button', { name: 'Identity', exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath(`configuration-${width}.png`),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(axe.violations).toEqual([]);
    await config.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(
        () =>
          fixture.writes.filter((w) => w.path === '/api/deployments?expected=1')
            .length,
      )
      .toBe(1);
    const saved = deploymentDraft(
      fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!
        .body,
    );
    expect(saved.configuration!.config).toMatchObject({
      'top-p': 0.9,
      'top-k': 40,
      'min-p': 0.05,
      'presence-penalty': 0.2,
      'repeat-penalty': 1.1,
      'spec-type': 'draft-mtp',
      'spec-draft-n-max': 4,
      'n-cpu-moe': 4,
      'reasoning-budget': 8192,
      extension: 'preserved',
      mmproj: '/models/example-mmproj.gguf',
    });
    expect(saved.configuration!.catalog.model?.capabilities).toMatchObject({
      input: ['image'],
      output: ['image'],
      reasoning: { supported: true },
      tools: true,
    });
  });
}

test('template defaults stay quiet while missing selected templates remain actionable', async ({
  page,
  fixture,
}) => {
  fixture.registry.deployments.find((d) => d.id === 'idle')!.template_override =
    { source: 'custom', asset_id: 'missing-template' };
  await page.goto('/#/deployments/idle/configuration');
  const warning = page
    .getByRole('alert')
    .filter({ hasText: 'Selected template is unavailable.' });
  await expect(warning).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Chat template', exact: true })
    .selectOption('inherit-model');
  await expect(warning).toHaveCount(0);
  await expect(page.getByText(/^Effective:/)).toHaveCount(0);
  await expect(
    page.getByText(
      'Deployment override, then model default, then engine default.',
      { exact: true },
    ),
  ).toHaveCount(0);
});

test('discard resets typed controls, invalid raw edits and the navigation guard', async ({
  page,
}) => {
  await page.goto('/#/deployments/idle/configuration');
  await page.getByLabel('Display name', { exact: true }).fill('Changed');
  await page.getByText('Advanced model settings', { exact: true }).click();
  await page.getByText('Runtime options (JSON)', { exact: true }).click();
  await page
    .getByLabel('Runtime options (JSON)', { exact: true })
    .fill('{broken');
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    'Example idle',
  );
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('resource tooltips use allocation names and loaded configuration remains read-only', async ({
  page,
}) => {
  await page.goto('/#/deployments/idle/configuration');
  const preview = page.getByRole('complementary', {
    name: 'Deployment resource preview',
  });
  await expect(preview).toContainText('GPU 0');
  await preview.locator('.recharts-bar-rectangle').first().hover();
  const tooltip = preview.locator('.recharts-tooltip-wrapper').first();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('Current use');
  await expect(tooltip).toContainText('GiB');
  await expect(tooltip).not.toContainText(/\bs\d+\b/);
  await page.goto('/#/deployments/ready/configuration');
  await expect(page.getByLabel('Display name', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
});

test('deployment rows separate request counts, move failure links and remove duplicate actions', async ({
  page,
  fixture,
}) => {
  const idle = fixture.registry.deployments.find((d) => d.id === 'idle')!;
  idle.state = 'FAILED';
  idle.inflight = 2;
  idle.historical_requests = 17;
  await page.goto('/#/deployments');
  const row = page.getByRole('row').filter({
    has: page.getByRole('link', { name: 'Example idle', exact: true }),
  });
  await expect(page.getByRole('columnheader').first()).toHaveText('Status');
  await expect(
    page.getByRole('columnheader', { name: 'Active requests', exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole('cell').nth(1).getByRole('link', { name: 'View logs' }),
  ).toHaveAttribute('href', '#/deployments/idle/logs');
  await expect(row.getByRole('cell').nth(4)).toHaveText('2');
  await expect(row.getByRole('cell').nth(5)).toHaveText('17');
  await row.getByRole('button', { name: 'Actions for Example idle' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Edit',
    'Duplicate',
    'Logs',
    'Disable',
  ]);
  await expect(
    menu.getByRole('menuitem', { name: 'Edit', exact: true }),
  ).toHaveAttribute('href', '#/deployments/idle/configuration');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Disabled (1)', exact: true }),
  ).toBeVisible();
  await row.getByRole('cell').nth(2).click();
  await expect(page).toHaveURL(/\/deployments\/idle$/);
});
