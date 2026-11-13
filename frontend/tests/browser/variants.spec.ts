import AxeBuilder from '@axe-core/playwright';
import { test, expect, openIdentity, openCard } from './fixtures';
import { deploymentDraft } from '../../src/contracts';
import { defaultReasoningOptions } from '../../src/capabilityOptions';
import type { ModelCatalog } from '../../src/types';

for (const enabled of [true, false]) {
  test(`legacy Default stays editable without an exposure switch when saved enabled=${enabled}`, async ({
    page,
    fixture,
  }) => {
    fixture.registry.deployments.find(
      (d) => d.id === 'idle',
    )!.profile_snapshot!.catalog = {
      reasoning: {
        default_mode: 'default',
        presets: [
          { id: 'default', enabled, body: { reasoning_budget: 1024 } },
          {
            id: 'own-default',
            name: 'Default',
            enabled: true,
            body: { reasoning_effort: 'high' },
          },
        ],
      },
    };
    await page.goto('/#/deployments/idle/configuration');
    await openCard(page, 'variants');
    const section = page.getByRole('region', { name: 'Variants', exact: true });
    const row = section.locator('[data-variant="default"]');
    await expect(row.getByRole('switch')).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: 'Default variant actions', exact: true }),
    ).toBeVisible();
    await expect(
      section.locator('[data-variant="own-default"]').getByRole('switch'),
    ).toBeChecked();
    await row.getByRole('button', { name: 'Default', exact: true }).click();
    const drawer = page.getByRole('dialog', {
      name: 'Edit Default',
      exact: true,
    });
    await expect(
      drawer.getByLabel('Token budget', { exact: true }),
    ).toHaveValue('1024');
    await drawer.getByLabel('Token budget', { exact: true }).fill('2048');
    await drawer
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
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
    ).configuration!.catalog;
    expect(saved.reasoning?.default_mode).toBe('default');
    expect(
      saved.reasoning?.presets?.find((p) => p.id === 'default'),
    ).toMatchObject({ enabled, body: { reasoning_budget: 2048 } });
    await page.reload();
    await openCard(page, 'variants');
    await expect(row.getByRole('switch')).toHaveCount(0);
    await row.getByRole('button', { name: 'Default', exact: true }).click();
    await expect(
      drawer.getByLabel('Token budget', { exact: true }),
    ).toHaveValue('2048');
  });
}

test('selecting legacy blank Instant as default persists its configured thinking-off fallback', async ({
  page,
  fixture,
}) => {
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.catalog = {
    model: { capabilities: { reasoning: false } },
    reasoning: { presets: [{ id: 'instant', enabled: false, body: {} }] },
  };
  await page.goto('/#/deployments/idle/configuration');
  await openCard(page, 'variants');
  const section = page.getByRole('region', { name: 'Variants', exact: true });
  await expect(
    section.getByRole('switch', {
      name: 'Enable Instant variant',
      exact: true,
    }),
  ).toBeEnabled();
  await section.getByRole('button', { name: 'Instant', exact: true }).click();
  const drawer = page.getByRole('dialog', {
    name: 'Edit Instant',
    exact: true,
  });
  await expect(drawer.getByLabel('Thinking', { exact: true })).toHaveValue(
    'false',
  );
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .getByLabel('Default reasoning level', { exact: true })
    .selectOption('instant');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  const saved = deploymentDraft(
    fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!.body,
  ).configuration!.catalog;
  expect(
    saved.reasoning?.presets?.find((mode) => mode.id === 'instant'),
  ).toMatchObject({
    enabled: false,
    body: { chat_template_kwargs: { enable_thinking: false } },
  });
  expect(saved.reasoning?.default_mode).toBe('instant');
});

for (const width of [1440, 320]) {
  test(`Custom badges align to the name cell edge without displacing names or actions at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const name =
      'Research variant with a deliberately long name and no per-row configuration label';
    fixture.registry.deployments.find(
      (deployment) => deployment.id === 'idle',
    )!.profile_snapshot!.catalog = {
      model: { capabilities: { reasoning: true } },
      reasoning: {
        presets: [
          {
            id: 'research',
            name,
            enabled: true,
            body: { reasoning_effort: 'high' },
          },
          {
            id: 'notes',
            name: 'Notes',
            enabled: false,
            body: { reasoning_effort: 'low' },
          },
          { id: 'ultra', enabled: false, body: { reasoning_effort: 'ultra' } },
          { id: 'default', enabled: true, body: {} },
          {
            id: 'low',
            name: 'Renamed built-in',
            enabled: true,
            body: { reasoning_budget: 1024 },
          },
        ],
      },
    };
    await page.goto('/#/deployments/idle/configuration');
    await openCard(page, 'variants');
    const section = page.getByRole('region', { name: 'Variants', exact: true });
    const item = section.getByRole('listitem').first();
    const actions = item.locator('[data-slot="item-actions"]');
    await item.scrollIntoViewIfNeeded();
    await expect(actions.getByRole('switch')).toBeVisible();
    await expect(actions.getByRole('button')).toBeVisible();
    const box = await item.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await expect(section.locator('[data-slot="badge"]')).toHaveCount(3);
    const rightEdges: number[] = [];
    for (const id of ['research', 'notes', 'ultra']) {
      const row = section.locator(`[data-variant="${id}"]`);
      const content = row.locator('[data-slot="item-content"]');
      const badge = content.getByText('Custom', { exact: true });
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute('data-variant', 'secondary');
      await expect(
        row.locator('[data-slot="item-actions"] [data-slot="badge"]'),
      ).toHaveCount(0);
      const badgeBox = (await badge.boundingBox())!;
      const contentBox = (await content.boundingBox())!;
      const nameBox = (await content.getByRole('button').boundingBox())!;
      const actionsBox = (await row
        .locator('[data-slot="item-actions"]')
        .boundingBox())!;
      const right = badgeBox.x + badgeBox.width;
      expect(Math.abs(right - contentBox.x - contentBox.width)).toBeLessThan(1);
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(badgeBox.x);
      expect(right).toBeLessThan(actionsBox.x);
      rightEdges.push(right);
    }
    expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThan(1);
    for (const id of [
      'default',
      'instant',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
      await expect(
        section.locator(`[data-variant="${id}"] [data-slot="badge"]`),
      ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('variant-items-long-name.png'),
    });
    await item.getByRole('button', { name, exact: true }).click();
    const drawer = page.getByRole('dialog', {
      name: `Edit ${name}`,
      exact: true,
    });
    await expect(
      drawer.getByLabel('Variant name', { exact: true }),
    ).toHaveValue(name);
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(item.getByRole('button', { name, exact: true })).toBeFocused();
  });
}

test('new deployment members get common defaults and a nested Drawer without submitting the builder', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments');
  await page
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Multiple models', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Add model', exact: true })
    .click();
  await openCard(page, 'model');
  await openCard(page, 'variants');
  await expect(
    page
      .getByRole('group', { name: 'Capabilities', exact: true })
      .getByRole('button', { name: 'Reasoning', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  const section = page.getByRole('region', { name: 'Variants', exact: true });
  await expect(section.getByRole('switch', { checked: true })).toHaveCount(3);
  await expect(
    section.getByRole('switch', { name: 'Enable Instant variant' }),
  ).toBeEnabled();
  for (const name of ['XHigh', 'Max']) {
    await expect(
      section.getByRole('switch', {
        name: `Enable ${name} variant`,
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      section.getByRole('switch', {
        name: `Enable ${name} variant`,
        exact: true,
      }),
    ).not.toBeChecked();
  }
  await section.getByRole('button', { name: 'Low', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Edit Low', exact: true });
  await drawer.getByLabel('Effort value', { exact: true }).fill('minimal');
  await drawer.getByLabel('Effort value', { exact: true }).press('Enter');
  await expect(drawer).toBeHidden();
  await section.getByRole('button', { name: 'Low', exact: true }).click();
  await expect(drawer.getByLabel('Effort value', { exact: true })).toHaveValue(
    'minimal',
  );
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(
    fixture.writes.filter(
      (w) => w.path === '/api/deployments' || w.path === '/api/deployment-sets',
    ),
  ).toEqual([]);
});

test('guided destination changes and JSON preserve additional template controls', async ({
  page,
  fixture,
}) => {
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.catalog = {
    model: { capabilities: { reasoning: true } },
    reasoning: {
      presets: [
        {
          id: 'low',
          enabled: true,
          body: {
            reasoning_effort: 'low',
            reasoning_budget: 8192,
            chat_template_kwargs: { style: 'research' },
          },
        },
      ],
    },
  };
  await page.goto('/#/deployments/idle/configuration');
  await openCard(page, 'variants');
  await page
    .getByRole('region', { name: 'Variants', exact: true })
    .getByRole('button', { name: 'Low', exact: true })
    .click();
  const drawer = page.getByRole('dialog', { name: 'Edit Low', exact: true });
  await drawer.getByRole('button', { name: 'Effort', exact: true }).click();
  await drawer
    .getByLabel('Send through', { exact: true })
    .selectOption('template');
  await drawer.getByLabel('Effort value', { exact: true }).fill('max');
  await expect(
    drawer.getByLabel('Request overrides', { exact: true }),
  ).toHaveValue(
    JSON.stringify(
      {
        reasoning_budget: 8192,
        chat_template_kwargs: { style: 'research', reasoning_effort: 'max' },
      },
      null,
      2,
    ),
  );
  await drawer.getByRole('button', { name: 'Apply changes' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  expect(
    deploymentDraft(
      fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!
        .body,
    ).configuration!.catalog.reasoning!.presets![0].body,
  ).toEqual({
    reasoning_budget: 8192,
    chat_template_kwargs: { style: 'research', reasoning_effort: 'max' },
  });
});

for (const width of [1440, 576, 320]) {
  test(`variant Items and Drawer round-trip mappings at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    fixture.registry.deployments.find(
      (d) => d.id === 'idle',
    )!.profile_snapshot!.catalog = {
      model: { capabilities: { reasoning: true } },
      reasoning: { presets: defaultReasoningOptions() },
    };
    await page.goto('/#/deployments/idle/configuration');
    await openCard(page, 'variants');
    const section = page.getByRole('region', { name: 'Variants', exact: true });
    const variants = section.getByRole('list', { name: 'Variants' });
    const header = section.locator('summary');
    const add = section.getByRole('button', {
      name: 'Add variant',
      exact: true,
    });
    await expect(add).toBeVisible();
    await expect(
      section
        .locator('[data-slot="card-content"]')
        .getByRole('button', { name: 'Add variant', exact: true }),
    ).toHaveCount(0);
    await expect(
      section.locator(
        '[data-slot="card-description"], [data-slot="field-description"], .capability-hint',
      ),
    ).toHaveCount(0);
    await expect(
      section.getByText(
        /Named reasoning and prompt configurations|Used when a request does not select a variant|Switches expose variants to clients/,
      ),
    ).toHaveCount(0);
    const titleBox = (await header.boundingBox())!;
    const addBox = (await add.boundingBox())!;
    expect(addBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
    await add.click();
    const addDrawer = page.getByRole('dialog', {
      name: 'Add variant',
      exact: true,
    });
    await expect(addDrawer).toBeVisible();
    await addDrawer
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(add).toBeFocused();
    await expect(section.getByRole('table')).toHaveCount(0);
    await expect(variants.locator('[draggable]')).toHaveCount(0);
    await expect(
      variants.getByText(/Effort ·|Token budget ·|Custom request settings/),
    ).toHaveCount(0);
    await expect(variants.getByRole('listitem')).toHaveCount(6);
    await expect(variants.getByRole('switch')).toHaveCount(6);
    await expect(variants.locator('.variant-name')).toHaveText([
      'Instant',
      'Low',
      'Medium',
      'High',
      'XHigh',
      'Max',
    ]);
    await expect(
      variants.getByText('Configure to enable', { exact: true }),
    ).toHaveCount(0);
    await expect(variants.getByRole('switch', { checked: true })).toHaveCount(
      3,
    );
    for (const item of await variants.getByRole('listitem').all()) {
      const actions = item.locator('[data-slot="item-actions"]');
      await expect(actions.getByRole('switch')).toHaveCount(1);
      await expect(actions.getByRole('button')).toHaveCount(1);
    }
    await expect(
      variants.getByRole('switch', {
        name: 'Enable Instant variant',
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      variants.getByRole('switch', {
        name: 'Enable XHigh variant',
        exact: true,
      }),
    ).not.toBeChecked();
    await expect(variants.locator('[data-variant="xhigh"]')).toContainText(
      'XHigh',
    );

    await variants
      .getByRole('button', { name: 'Instant', exact: true })
      .click();
    let drawer = page.getByRole('dialog', {
      name: 'Edit Instant',
      exact: true,
    });
    await expect(drawer).toHaveAttribute(
      'data-swipe-direction',
      width < 768 ? 'down' : 'right',
    );
    await expect(
      drawer.getByLabel('Variant name', { exact: true }),
    ).toBeFocused();
    await drawer
      .getByRole('button', { name: 'Thinking toggle', exact: true })
      .click();
    await expect(drawer.getByLabel('Thinking', { exact: true })).toHaveValue(
      'false',
    );
    await drawer.getByRole('button', { name: 'Apply changes' }).click();
    await expect(drawer).toBeHidden();
    await expect(
      variants.getByRole('button', { name: 'Instant', exact: true }),
    ).toBeFocused();
    await variants
      .getByRole('switch', { name: 'Enable Instant variant' })
      .check();

    await variants.getByRole('button', { name: 'Medium', exact: true }).click();
    drawer = page.getByRole('dialog', { name: 'Edit Medium', exact: true });
    await drawer
      .getByRole('button', { name: 'Token budget', exact: true })
      .click();
    await drawer
      .getByLabel('Request field', { exact: true })
      .selectOption('thinking_budget');
    await drawer.getByLabel('Token budget', { exact: true }).fill('-1');
    await drawer.getByText('Prompt prefix', { exact: true }).click();
    await drawer
      .getByLabel('Prefix text', { exact: true })
      .fill('Think carefully.');
    await drawer.getByText('Request JSON', { exact: true }).click();
    await expect(
      drawer.getByLabel('Request overrides', { exact: true }),
    ).toHaveValue(JSON.stringify({ thinking_budget: -1 }, null, 2));
    await page.screenshot({
      path: testInfo.outputPath(`variant-drawer-${width}.png`),
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await drawer.getByRole('button', { name: 'Apply changes' }).click();

    await section.getByRole('button', { name: 'Add variant' }).click();
    drawer = page.getByRole('dialog', { name: 'Add variant', exact: true });
    await expect(drawer.getByLabel(/ID/)).toHaveCount(0);
    await drawer.getByLabel('Variant name', { exact: true }).fill('Research');
    await drawer.getByRole('button', { name: 'Custom', exact: true }).click();
    const composite = {
      reasoning_effort: 'high',
      reasoning_budget: 8192,
      chat_template_kwargs: { enable_thinking: true, style: 'research' },
    };
    await drawer
      .getByLabel('Request overrides', { exact: true })
      .fill(JSON.stringify(composite));
    await drawer.getByRole('button', { name: 'Apply changes' }).click();
    const custom = variants.getByRole('switch', {
      name: 'Enable Research variant',
      exact: true,
    });
    await custom.focus();
    await page.keyboard.press('Space');
    await expect(custom).toBeChecked();
    await variants
      .getByRole('button', { name: 'Research variant actions' })
      .click();
    await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
    await expect(variants.getByRole('listitem').nth(5)).toHaveAttribute(
      'data-variant',
      'research',
    );
    await page
      .getByLabel('Default reasoning level', { exact: true })
      .selectOption('research');
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
    ).configuration!.catalog;
    expect(saved.reasoning?.default_mode).toBe('research');
    expect(
      saved.reasoning?.presets?.find((mode) => mode.id === 'xhigh')?.body,
    ).toEqual({ reasoning_effort: 'xhigh' });
    expect(saved.reasoning?.presets?.[5]).toEqual({
      id: 'research',
      name: 'Research',
      enabled: true,
      body: composite,
    });
    expect(
      saved.reasoning?.presets?.find((p) => p.id === 'medium'),
    ).toMatchObject({
      body: { thinking_budget: -1 },
      prompt_prefix: 'Think carefully.',
    });
    await page.reload();
    await openCard(page, 'variants');
    await expect(variants.getByRole('listitem').nth(5)).toHaveAttribute(
      'data-variant',
      'research',
    );
    await expect(custom).toBeChecked();
    await variants
      .getByRole('button', { name: 'Research', exact: true })
      .click();
    drawer = page.getByRole('dialog', { name: 'Edit Research', exact: true });
    await expect(
      drawer.getByLabel('Request overrides', { exact: true }),
    ).toHaveValue(JSON.stringify(composite, null, 2));
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`variants-${width}.png`),
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
    await variants
      .getByRole('button', { name: 'Research variant actions' })
      .click();
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
    await expect(custom).toHaveCount(0);
    await expect(
      page.getByLabel('Default reasoning level', { exact: true }),
    ).toHaveValue('');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await openCard(page, 'variants');
    await expect(custom).toBeChecked();
  });
}

test('existing mappings, order, IDs and disabled default survive unrelated saves and drawer renaming', async ({
  page,
  fixture,
}) => {
  const catalog: ModelCatalog = {
    model: { capabilities: { reasoning: true } },
    reasoning: {
      default_mode: 'private-level',
      presets: [
        {
          id: 'private-level',
          name: 'Private level',
          enabled: false,
          body: {
            chat_template_kwargs: {
              enable_thinking: true,
              reasoning_effort: 'custom-value',
            },
          },
          prompt_prefix: '{custom}',
        },
        {
          id: 'default',
          name: 'Custom Default',
          enabled: true,
          body: { reasoning_budget: 1234 },
        },
        { id: 'instant', enabled: false, body: {} },
      ],
    },
  };
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.catalog = structuredClone(catalog);
  await page.goto('/#/deployments/idle/configuration');
  await openCard(page, 'variants');
  const section = page.getByRole('region', { name: 'Variants', exact: true });
  await expect(section.getByRole('listitem').first()).toHaveAttribute(
    'data-variant',
    'private-level',
  );
  await expect(
    page.getByLabel('Default reasoning level', { exact: true }),
  ).toHaveValue('private-level');
  // A resource preview can precede Save; select the saved request by endpoint.
  await expect
    .poll(() =>
      fixture.writes.some((write) => write.path === '/api/resources/preview'),
    )
    .toBe(true);
  await openIdentity(page);
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Preserved variants');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  expect(
    deploymentDraft(
      fixture.writes.find(
        (write) => write.path === '/api/deployments?expected=1',
      )!.body,
    ).configuration!.catalog.reasoning,
  ).toEqual(catalog.reasoning);
  await openCard(page, 'variants');
  await section
    .getByRole('button', { name: 'Private level', exact: true })
    .click();
  const drawer = page.getByRole('dialog', {
    name: 'Edit Private level',
    exact: true,
  });
  await drawer.getByLabel('Variant name', { exact: true }).fill('Renamed');
  await drawer.getByRole('button', { name: 'Apply changes' }).click();
  await expect(section.getByRole('listitem').first()).toHaveAttribute(
    'data-variant',
    'private-level',
  );
  await section.getByRole('button', { name: 'Renamed', exact: true }).click();
  await expect(
    page.getByLabel('Request overrides', { exact: true }),
  ).toHaveValue(JSON.stringify(catalog.reasoning!.presets![0].body, null, 2));
});

test('invalid JSON stays local, cancellation guards drafts, and prompt-only variants get collision-safe IDs', async ({
  page,
  fixture,
}) => {
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.catalog = {
    model: {
      capabilities: { reasoning: true },
      variants: [{ id: 'research', body: { temperature: 1 } }],
    },
    reasoning: { presets: defaultReasoningOptions() },
  };
  await page.goto('/#/deployments/idle/configuration');
  await openCard(page, 'variants');
  const section = page.getByRole('region', { name: 'Variants', exact: true });
  await section.getByRole('button', { name: 'Low', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Edit Low', exact: true });
  await drawer.getByText('Request JSON', { exact: true }).click();
  await drawer
    .getByLabel('Request overrides', { exact: true })
    .fill('{invalid');
  await drawer.getByText('Request JSON', { exact: true }).click();
  await expect(
    drawer.getByRole('button', { name: 'Apply changes' }),
  ).toBeDisabled();
  await expect(drawer.getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('alertdialog', { name: 'Discard variant changes?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(
    drawer.getByLabel('Request overrides', { exact: true }),
  ).toHaveValue('{invalid');
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click();
  await expect(drawer).toBeHidden();
  await section.getByRole('button', { name: 'Low', exact: true }).click();
  await expect(drawer.getByLabel('Effort value', { exact: true })).toHaveValue(
    'low',
  );
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await section.getByRole('button', { name: 'Add variant' }).click();
  const add = page.getByRole('dialog', { name: 'Add variant', exact: true });
  await add.getByLabel('Variant name', { exact: true }).fill('Research');
  await expect(add.getByLabel('Effort value', { exact: true })).toHaveValue(
    'medium',
  );
  await expect(
    add.getByRole('button', { name: 'Not configured', exact: true }),
  ).toHaveCount(0);
  await add.getByRole('button', { name: 'Custom', exact: true }).click();
  await add
    .getByLabel('Request overrides', { exact: true })
    .fill('{"chat_template_kwargs":{}}');
  await expect(
    add.getByRole('button', { name: 'Apply changes' }),
  ).toBeDisabled();
  await add.getByLabel('Request overrides', { exact: true }).fill('{}');
  await expect(
    add.getByRole('button', { name: 'Apply changes' }),
  ).toBeDisabled();
  await add.getByText('Prompt prefix', { exact: true }).click();
  await add
    .getByLabel('Prefix text', { exact: true })
    .fill('Explore alternatives.');
  await add.getByRole('button', { name: 'Apply changes' }).click();
  await expect(section.locator('[data-variant="research-2"]')).toContainText(
    'Research',
  );
  await section
    .getByRole('switch', { name: 'Enable Research variant' })
    .check();
  // Closing the nested editor must not remove the parent builder's navigation guard.
  await section.getByRole('button', { name: 'Research', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Edit Research', exact: true })
      .getByLabel('Prefix text', { exact: true }),
  ).toHaveValue('Explore alternatives.');
  await expect(
    page
      .getByRole('dialog', { name: 'Edit Research', exact: true })
      .getByLabel('Request overrides', { exact: true }),
  ).toHaveValue('{}');
  await page
    .getByRole('dialog', { name: 'Edit Research', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
});

test('overflow menus support keyboard reordering and preserve disabled variants', async ({
  page,
  fixture,
}) => {
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.catalog = {
    model: { capabilities: { reasoning: true } },
    reasoning: { presets: defaultReasoningOptions() },
  };
  await page.goto('/#/deployments/idle/configuration');
  await openCard(page, 'variants');
  const section = page.getByRole('region', { name: 'Variants', exact: true });
  const instantMenu = section.getByRole('button', {
    name: 'Instant variant actions',
    exact: true,
  });
  await instantMenu.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('menuitem', { name: 'Move up', exact: true }),
  ).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Move down', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(section.getByRole('listitem').nth(1)).toHaveAttribute(
    'data-variant',
    'instant',
  );
  await expect(instantMenu).toBeFocused();
  await expect(
    section.getByRole('switch', { name: 'Enable Instant variant' }),
  ).not.toBeChecked();
  await section
    .getByRole('button', { name: 'Max variant actions', exact: true })
    .click();
  await expect(
    page.getByRole('menuitem', { name: 'Move down', exact: true }),
  ).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
  await expect(section.getByRole('listitem').nth(4)).toHaveAttribute(
    'data-variant',
    'max',
  );
  await expect(
    section.getByRole('switch', { name: 'Enable Max variant' }),
  ).not.toBeChecked();
});
