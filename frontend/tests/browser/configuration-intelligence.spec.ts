import { test, expect, openAdvanced, openIdentity } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

test('curated sections preserve omission and separate explicit automatic context', async ({
  page,
  fixture,
}) => {
  const deployment = fixture.registry.deployments.find(
    (entry) => entry.id === 'idle',
  )!;
  deployment.profile_snapshot!.config = {};
  fixture.registry.runtimes[0].capabilities!.schema!['ctx-size'].min = 0;
  fixture.registry.runtimes[0].capabilities!.schema!['ctx-size'].presentation =
    {
      category: 'resources-context',
      owner: 'runtime-process',
      inheritable: true,
      automatic_value: 0,
      request_overridable: false,
      provenance: 'adapter',
    };
  await page.goto('/#/deployments/idle/configuration');
  for (const title of [
    'Model & runtime',
    'Resources & context',
    'Generation',
    'Availability',
  ])
    await expect(
      page.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
  const source = page.getByLabel('ctx-size', { exact: true });
  await expect(source).toHaveValue('');
  await expect(
    page.getByRole('button', { name: 'Discard', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Automatic (0)', exact: true })
    .click();
  await expect(source).toHaveValue('0');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () =>
        fixture.registry.deployments.find((entry) => entry.id === 'idle')
          ?.revision,
    )
    .toBe(2);
  const saved = deploymentDraft(
    fixture.writes.find(
      (entry) => entry.path === '/api/model-setups?expected=1',
    )!.body,
  );
  expect(saved.configuration!.config).toEqual({ 'ctx-size': 0 });
});

test('capability warnings retain manual controls and recommendations need explicit application', async ({
  page,
  fixture,
}) => {
  const deployment = fixture.registry.deployments.find(
    (entry) => entry.id === 'idle',
  )!;
  deployment.profile_snapshot!.config = {};
  fixture.registry.runtimes[0].capabilities!.schema!.temp = {
    type: 'number',
    min: 0,
    max: 5,
    label: 'Temperature',
  };
  await page.route('**/api/capabilities/preview', (route) =>
    route.fulfill({
      json: {
        model: {
          input_image: {
            status: 'supported',
            evidence: [
              {
                source: 'artifact',
                confidence: 'high',
                detail: 'vision_config',
              },
            ],
          },
        },
        effective: {
          input_image: {
            status: 'unsupported',
            evidence: [
              {
                source: 'runtime',
                confidence: 'high',
                detail: 'Missing compatible projector',
              },
            ],
          },
        },
        warnings: ['Choose a compatible projector; launch remains available.'],
        recommendations: [
          {
            parameter: 'temp',
            value: 0.6,
            compatible: true,
            source: 'artifact',
            detail: 'Published generation_config.json',
          },
        ],
      },
    }),
  );
  await page.goto('/#/deployments/idle/configuration');
  await page.locator('[data-settings-section="model"] summary').click();
  await expect(
    page.getByText('Image input: unsupported', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Choose a compatible projector; launch remains available.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Discard', exact: true }),
  ).toBeDisabled();
  await page.locator('[data-settings-section="generation"] summary').click();
  await expect(
    page.getByText('Published generation_config.json', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Apply compatible recommendations' })
    .click();
  await expect(page.getByLabel('Temperature', { exact: true })).toHaveValue(
    '0.6',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () =>
        fixture.registry.deployments.find((entry) => entry.id === 'idle')
          ?.revision,
    )
    .toBe(2);
  expect(
    fixture.registry.deployments.find((entry) => entry.id === 'idle')
      ?.profile_snapshot!.config,
  ).toEqual({ temp: 0.6 });
});

test('retired Advanced route redirects to cards with raw arguments and identity', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments/idle/advanced');
  await expect(page).toHaveURL(/\/configuration$/);
  await expect(
    page.getByRole('radio', { name: 'Advanced', exact: true }),
  ).toHaveCount(0);
  await openIdentity(page);
  await expect(page.getByLabel('Display name', { exact: true })).toBeVisible();
  await openAdvanced(page);
  await expect(
    page.getByRole('button', { name: 'Add performance flags', exact: true }),
  ).toBeEnabled();
  await page.locator('[data-settings-section="diagnostics"] summary').click();
  await page
    .getByLabel('Engine arguments', { exact: true })
    .fill('["--vendor-option", "synthetic"]');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () =>
        fixture.registry.deployments.find((entry) => entry.id === 'idle')
          ?.revision,
    )
    .toBe(2);
  expect(
    fixture.registry.deployments.find((entry) => entry.id === 'idle')
      ?.profile_snapshot!.raw_args,
  ).toEqual(['--vendor-option', 'synthetic']);
});

test('filter reveals advanced matches without clearing edits; unsupported overrides remain counted', async ({
  page,
  fixture,
}) => {
  Object.assign(fixture.registry.runtimes[0].capabilities!.schema!, {
    'top-k': { type: 'integer', min: 0, max: 100, label: 'Top-k' },
  });
  const saved = fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!;
  Object.assign(saved.config, { 'top-k': 7, 'retired-option': 2 });
  await page.goto('/#/deployments/idle/configuration');
  const advanced = page.locator(
    '[data-settings-section="generation"] [data-card-advanced]',
  );
  await expect(advanced).toHaveAttribute('data-overrides', '1');
  await expect(page.getByLabel('Top-k', { exact: true })).toBeHidden();
  await page.getByLabel('Filter configuration', { exact: true }).fill('top-k');
  await expect(page.getByLabel('Top-k', { exact: true })).toBeVisible();
  await page.getByLabel('Top-k', { exact: true }).fill('8');
  await page
    .getByLabel('Filter configuration', { exact: true })
    .fill('threads');
  await expect(
    page.getByRole('button', { name: 'Add performance flags' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear filter', exact: true }).click();
  await page.locator('[data-settings-section="generation"] summary').click();
  await expect(page.getByLabel('Top-k', { exact: true })).toHaveValue('8');
  await page.locator('[data-settings-section="diagnostics"] summary').click();
  await expect(
    page.getByRole('heading', { name: 'Unsupported saved overrides' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reset retired-option' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  expect(
    fixture.registry.deployments.find((d) => d.id === 'idle')!.profile_snapshot!
      .config,
  ).toMatchObject({ 'top-k': 8 });
  expect(
    fixture.registry.deployments.find((d) => d.id === 'idle')!.profile_snapshot!
      .config,
  ).not.toHaveProperty('retired-option');
});

test('invalid identity inside a collapsed card opens and receives focus on submit', async ({
  page,
}) => {
  await page.goto('/#/deployments/idle/configuration');
  await openIdentity(page);
  const name = page.getByLabel('Display name', { exact: true });
  await name.fill('');
  await page.locator('[data-settings-section="identity"] summary').click();
  await expect(name).toBeHidden();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(name).toBeVisible();
  await expect(name).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: '1 issue' }),
  ).toBeVisible();
});

for (const { width, components } of [1440, 576, 320].flatMap((width) =>
  [false, true].map((components) => ({ width, components })),
)) {
  test(`closed cards stay ordered and within the primary-control budget at ${width}px, components=${components}`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    Object.assign(fixture.registry.runtimes[0].capabilities!.schema!, {
      temp: { type: 'number', min: 0, max: 5, label: 'Temperature' },
      fit: { type: 'boolean', label: 'Automatic fit' },
      'flash-attn': {
        type: 'enum',
        choices: ['auto', 'on', 'off'],
        label: 'Flash attention',
      },
      'top-k': { type: 'integer', min: 0, max: 100, label: 'Top-k' },
      ...(components
        ? { mmproj: { type: 'string' }, 'spec-type': { type: 'string' } }
        : {}),
    });
    await page.goto('/#/deployments/idle/configuration');
    const cards = page.locator('.configuration-grid > [data-settings-section]');
    await expect(cards).toHaveCount(7);
    expect(
      await cards.evaluateAll((elements) =>
        elements.map((element) =>
          element.getAttribute('data-settings-section'),
        ),
      ),
    ).toEqual([
      'identity',
      'model',
      'memory',
      'generation',
      'variants',
      'lifecycle',
      'diagnostics',
    ]);
    const grid = page.locator('.configuration-grid');
    const controls = grid
      .getByRole('spinbutton')
      .or(grid.getByRole('combobox'))
      .or(grid.getByRole('checkbox'))
      .or(grid.getByRole('switch'));
    expect(await controls.count()).toBeLessThanOrEqual(components ? 18 : 16);
    for (const card of await cards.all()) {
      expect(
        await card
          .getByRole('spinbutton')
          .or(card.getByRole('combobox'))
          .or(card.getByRole('checkbox'))
          .or(card.getByRole('switch'))
          .count(),
      ).toBeLessThanOrEqual(5);
      await expect(card.locator('details details')).toHaveCount(0);
    }
    const modelBox = (await grid
      .locator('[data-settings-section="model"]')
      .boundingBox())!;
    const memoryBox = (await grid
      .locator('[data-settings-section="memory"]')
      .boundingBox())!;
    // Sections stack in one column at every width: the memory card sits
    // directly below the model card, never beside it.
    expect(memoryBox.x).toBeCloseTo(modelBox.x, 0);
    expect(memoryBox.y).toBeGreaterThan(modelBox.y + modelBox.height);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(
        `configuration-closed-${width}-${components ? 'components' : 'standard'}.png`,
      ),
      fullPage: true,
    });
    await expect(
      page.getByRole('button', { name: 'Discard', exact: true }),
    ).toBeDisabled();
  });
}
