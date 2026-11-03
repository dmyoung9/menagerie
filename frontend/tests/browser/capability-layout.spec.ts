import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

for (const width of [1440, 576, 320]) {
  test(`modalities precede capabilities and disabled reasoning stays hidden at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const catalog = fixture.registry.deployments.find((d) => d.id === 'idle')!
      .profile_snapshot!.catalog;
    Object.assign(catalog, {
      model: {
        capabilities: {
          tools: true,
          input: ['text'],
          output: ['text'],
          reasoning: { supported: false },
        },
      },
      reasoning: {
        presets: [
          { id: 'default', enabled: true, body: {} },
          {
            id: 'instant',
            enabled: true,
            body: { chat_template_kwargs: { enable_thinking: false } },
          },
          { id: 'low', enabled: false, body: { reasoning_effort: 'low' } },
          { id: 'high', enabled: true, body: { thinking_budget: 4096 } },
        ],
      },
    });
    const original = structuredClone(catalog.reasoning);
    fixture.registry.runtimes[0].capabilities!.schema!['reasoning-budget'] = {
      type: 'integer',
      min: -1,
      max: 1048576,
      engine_default: -1,
      label: 'Default reasoning budget',
    };
    await page.goto('/#/deployments/idle/configuration');
    const panel = page.getByRole('region', {
      name: 'Capabilities and reasoning',
      exact: true,
    });
    await expect(
      panel.locator(
        ':scope > fieldset > legend, :scope > .capability-heading > h3',
      ),
    ).toHaveText(['Input modalities', 'Output modalities', 'Capabilities']);
    await expect(
      page.getByText('Available to clients', { exact: true }),
    ).toHaveCount(0);
    const options = panel.getByRole('region', {
      name: 'Reasoning modes',
      exact: true,
    });
    await expect(options).toHaveCount(0);
    await expect(
      panel.getByLabel('Default reasoning budget', { exact: true }),
    ).toHaveCount(0);
    const reasoning = panel
      .getByRole('group', { name: 'Capabilities', exact: true })
      .getByRole('button', { name: 'Reasoning', exact: true });
    await reasoning.click();
    await expect(options).toBeVisible();
    await expect(
      options.getByRole('combobox', { name: 'Instant thinking', exact: true }),
    ).toHaveValue('false');
    await expect(
      options.getByRole('combobox', {
        name: 'High thinking budget mode',
        exact: true,
      }),
    ).toHaveValue('custom');
    await expect(
      options.getByRole('button', {
        name: 'Expose Low to clients',
        exact: true,
      }),
    ).toHaveAttribute('aria-pressed', 'false');
    await reasoning.click();
    await expect(options).toHaveCount(0);
    await page
      .getByLabel('Display name', { exact: true })
      .fill('Capability review');
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
    expect(saved.reasoning).toEqual(original);
    expect(saved.model?.capabilities?.reasoning).toEqual({ supported: false });
    await page.reload();
    await expect(options).toHaveCount(0);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`capabilities-off-${width}.png`),
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
    await reasoning.click();
    await expect(options).toBeVisible();
    await expect(
      options.getByRole('combobox', { name: 'Instant thinking', exact: true }),
    ).toHaveValue('false');
    await expect(
      options.getByRole('combobox', {
        name: 'High thinking budget mode',
        exact: true,
      }),
    ).toHaveValue('custom');
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(options).toHaveCount(0);
  });
}

test('turning reasoning off clears hidden mapping errors without deleting saved mappings', async ({
  page,
  fixture,
}) => {
  const catalog = fixture.registry.deployments.find((d) => d.id === 'idle')!
    .profile_snapshot!.catalog;
  Object.assign(catalog, {
    model: {
      capabilities: {
        tools: false,
        input: ['text'],
        output: ['text'],
        reasoning: { supported: true },
      },
    },
    reasoning: {
      presets: [
        { id: 'default', enabled: true, body: {} },
        { id: 'instant', enabled: true, body: { reasoning_effort: 'none' } },
        { id: 'high', enabled: true, body: { reasoning_effort: 'high' } },
      ],
    },
  });
  const original = structuredClone(catalog.reasoning);
  await page.goto('/#/deployments/idle/configuration');
  const section = page.getByRole('region', {
    name: 'Reasoning modes',
    exact: true,
  });
  for (const name of ['Instant', 'High']) {
    await section
      .getByText(name + ' template arguments (JSON)', { exact: true })
      .click();
    await section
      .getByRole('textbox', {
        name: name + ' template arguments (JSON)',
        exact: true,
      })
      .fill('{invalid');
  }
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  const reasoning = page
    .getByRole('group', { name: 'Capabilities', exact: true })
    .getByRole('button', { name: 'Reasoning', exact: true });
  await reasoning.click();
  await expect(section).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeEnabled();
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
    ).configuration!.catalog.reasoning,
  ).toEqual(original);
});

test('legacy boolean Reasoning enabled displays its options', async ({
  page,
  fixture,
}) => {
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.catalog.model = { capabilities: { reasoning: true } };
  await page.goto('/#/deployments/idle/configuration');
  await expect(
    page
      .getByRole('group', { name: 'Capabilities', exact: true })
      .getByRole('button', { name: 'Reasoning', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('region', { name: 'Reasoning modes', exact: true }),
  ).toBeVisible();
});
