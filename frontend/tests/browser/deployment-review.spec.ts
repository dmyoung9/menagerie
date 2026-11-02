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
        label: 'Maximum draft tokens',
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
    await page.goto('/#/deployments/idle/configuration');
    const config = page.locator('form.configuration-editor');
    for (const title of [
      'Identity',
      'Model & engine',
      'Memory & placement',
      'Performance',
      'Generation',
      'Capabilities & reasoning',
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
    await expect(
      config.getByLabel('Default reasoning budget', { exact: true }),
    ).toBeVisible();
    const inputs = config.getByRole('group', {
      name: 'Input capabilities',
      exact: true,
    });
    await expect(
      inputs.getByRole('button', { name: 'Text', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await inputs.getByRole('button', { name: 'Images', exact: true }).click();
    await inputs.getByRole('button', { name: 'Text', exact: true }).click();
    await inputs
      .getByRole('button', { name: 'Reasoning', exact: true })
      .click();
    const outputs = config.getByRole('group', {
      name: 'Output formats',
      exact: true,
    });
    await outputs.getByRole('button', { name: 'Image', exact: true }).click();
    await outputs.getByRole('button', { name: 'Text', exact: true }).click();
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
      .getByLabel('Speculative decoding type (MTP)', { exact: true })
      .fill('draft-mtp');
    await config
      .getByLabel('MTP / draft model path', { exact: true })
      .fill('/models/example-mtp.gguf');
    await config.getByLabel('Maximum draft tokens', { exact: true }).fill('3');
    await config
      .getByLabel('MoE expert layers on CPU', { exact: true })
      .fill('4');
    await config
      .getByLabel('Default reasoning budget', { exact: true })
      .fill('8192');
    await expect(
      page.getByRole('complementary', { name: 'Deployment resource preview' }),
    ).toContainText('GPU 0');
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
      'spec-draft-n-max': 3,
      'n-cpu-moe': 4,
      'reasoning-budget': 8192,
      extension: 'preserved',
    });
    expect(saved.configuration!.catalog.model?.capabilities).toMatchObject({
      input: ['image'],
      output: ['image'],
      reasoning: { supported: true },
    });
  });
}

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
