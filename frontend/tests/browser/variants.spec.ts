import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { deploymentDraft } from '../../src/contracts';
import { defaultReasoningOptions } from '../../src/capabilityOptions';
import type { ModelCatalog } from '../../src/types';

test('new deployment members get common defaults and a nested Drawer without submitting the builder', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments');
  await page
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Add model', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'Capabilities', exact: true })
    .getByRole('button', { name: 'Reasoning', exact: true })
    .click();
  const section = page.getByRole('region', { name: 'Variants', exact: true });
  await expect(section.getByRole('switch', { checked: true })).toHaveCount(3);
  await expect(
    section.getByRole('switch', { name: 'Enable Instant variant' }),
  ).toBeDisabled();
  for (const name of ['XHigh', 'Max', 'Ultra']) {
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
  await expect(section.locator('[data-variant="low"]')).toContainText(
    'minimal',
  );
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
  test(`variant table and drawer round-trip mappings at ${width}px`, async ({
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
    const section = page.getByRole('region', { name: 'Variants', exact: true });
    const table = section.getByRole('table', { name: 'Variants' });
    await expect(table.getByRole('switch')).toHaveCount(7);
    await expect(table.getByRole('switch', { checked: true })).toHaveCount(3);
    await expect(
      table.getByRole('switch', {
        name: 'Enable Instant variant',
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      table.getByRole('switch', { name: 'Enable XHigh variant', exact: true }),
    ).not.toBeChecked();
    await expect(table.locator('[data-variant="xhigh"]')).toContainText(
      'Effort · Request field · xhigh',
    );

    await table.getByRole('button', { name: 'Instant', exact: true }).click();
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
      table.getByRole('button', { name: 'Instant', exact: true }),
    ).toBeFocused();
    await table.getByRole('switch', { name: 'Enable Instant variant' }).check();

    await table.getByRole('button', { name: 'Medium', exact: true }).click();
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
    const custom = table.getByRole('switch', {
      name: 'Enable Research variant',
      exact: true,
    });
    await custom.focus();
    await page.keyboard.press('Space');
    await expect(custom).toBeChecked();
    await table
      .getByRole('button', { name: 'Research variant actions' })
      .click();
    await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
    await expect(table.locator('tbody tr').nth(6)).toHaveAttribute(
      'data-variant',
      'research',
    );
    await section
      .getByLabel('Default variant', { exact: true })
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
    expect(saved.reasoning?.presets?.[6]).toEqual({
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
    await expect(table.locator('tbody tr').nth(6)).toHaveAttribute(
      'data-variant',
      'research',
    );
    await expect(custom).toBeChecked();
    await table.getByRole('button', { name: 'Research', exact: true }).click();
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
    await table
      .getByRole('button', { name: 'Research variant actions' })
      .click();
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
    await expect(custom).toHaveCount(0);
    await expect(
      section.getByLabel('Default variant', { exact: true }),
    ).toHaveValue('');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
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
  const section = page.getByRole('region', { name: 'Variants', exact: true });
  await expect(section.locator('tbody tr').first()).toHaveAttribute(
    'data-variant',
    'private-level',
  );
  await expect(
    section.getByLabel('Default variant', { exact: true }),
  ).toHaveValue('private-level');
  // A resource preview can precede Save; select the saved request by endpoint.
  await expect
    .poll(() =>
      fixture.writes.some((write) => write.path === '/api/resources/preview'),
    )
    .toBe(true);
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
  await section
    .getByRole('button', { name: 'Private level', exact: true })
    .click();
  const drawer = page.getByRole('dialog', {
    name: 'Edit Private level',
    exact: true,
  });
  await drawer.getByLabel('Variant name', { exact: true }).fill('Renamed');
  await drawer.getByRole('button', { name: 'Apply changes' }).click();
  await expect(section.locator('tbody tr').first()).toHaveAttribute(
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
  await expect(section.locator('[data-variant="low"]')).toContainText(
    'Effort · Request field · low',
  );
  await section.getByRole('button', { name: 'Add variant' }).click();
  const add = page.getByRole('dialog', { name: 'Add variant', exact: true });
  await add.getByLabel('Variant name', { exact: true }).fill('Research');
  await add.getByText('Prompt prefix', { exact: true }).click();
  await add
    .getByLabel('Prefix text', { exact: true })
    .fill('Explore alternatives.');
  await add.getByRole('button', { name: 'Apply changes' }).click();
  await expect(section.locator('[data-variant="research-2"]')).toContainText(
    'Prompt prefix only',
  );
  await section
    .getByRole('switch', { name: 'Enable Research variant' })
    .check();
  // Closing the nested editor must not remove the parent builder's navigation guard.
  await section.getByRole('button', { name: 'Research', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Edit Research', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
});

test('drag and keyboard ordering preserve disabled variants', async ({
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
  const section = page.getByRole('region', { name: 'Variants', exact: true });
  await section
    .getByRole('button', { name: 'Reorder Ultra', exact: true })
    .dragTo(section.locator('[data-variant="instant"]'));
  await expect(section.locator('tbody tr').first()).toHaveAttribute(
    'data-variant',
    'ultra',
  );
  await section
    .getByRole('button', { name: 'Reorder Ultra', exact: true })
    .focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(section.locator('tbody tr').nth(1)).toHaveAttribute(
    'data-variant',
    'ultra',
  );
  await expect(
    section.getByRole('switch', { name: 'Enable Ultra variant' }),
  ).not.toBeChecked();
});
