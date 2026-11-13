import AxeBuilder from '@axe-core/playwright';
import { test, expect, openCard, openIdentity } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

for (const width of [1440, 576, 320]) {
  test(`variants stay visible and editable independently of Reasoning at ${width}px`, async ({
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
    await page.goto('/#/deployments/idle/configuration');
    await openCard(page, 'model');
    await openCard(page, 'variants');
    await openIdentity(page);
    const panel = page.getByRole('region', {
      name: 'Modalities and capabilities',
      exact: true,
    });
    await expect(
      panel.locator(
        ':scope > fieldset > legend, :scope > .capability-heading > h3',
      ),
    ).toHaveText(['Input modalities', 'Output modalities', 'Capabilities']);
    const variants = page.getByRole('region', {
      name: 'Variants',
      exact: true,
    });
    await expect(variants).toBeVisible();
    await expect(
      variants.getByText('Configure to enable', { exact: true }),
    ).toHaveCount(0);
    await expect(
      variants.getByRole('switch', {
        name: 'Enable Instant variant',
        exact: true,
      }),
    ).toBeChecked();
    await expect(
      variants.getByRole('switch', { name: 'Enable Low variant', exact: true }),
    ).toBeEnabled();
    await variants.getByRole('button', { name: 'Low', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Edit Low', exact: true });
    await expect(
      drawer.getByLabel('Effort value', { exact: true }),
    ).toBeEnabled();
    await expect(
      drawer.getByLabel('Effort value', { exact: true }),
    ).toHaveValue('low');
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
    const reasoning = panel
      .getByRole('group', { name: 'Capabilities', exact: true })
      .getByRole('button', { name: 'Reasoning', exact: true });
    await reasoning.click();
    await expect(variants).toBeVisible();
    await reasoning.click();
    await expect(variants).toBeVisible();
    await page
      .getByLabel('Display name', { exact: true })
      .fill('Capability review');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Rename and update API model ID',
        exact: true,
      })
      .click();
    await expect
      .poll(
        () =>
          fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
      )
      .toBe(2);
    const saved = deploymentDraft(
      fixture.writes.find((w) => w.path === '/api/model-setups?expected=1')!
        .body,
    ).configuration!.catalog;
    expect(saved.reasoning).toEqual(original);
    expect(saved.model?.capabilities?.reasoning).toEqual({ supported: false });
    await page.reload();
    await expect(variants).toBeVisible();
    await variants.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`variants-reasoning-off-${width}.png`),
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
  });
}

test('variants can be edited, enabled and selected as default while Reasoning stays off; saved Ultra is custom', async ({
  page,
  fixture,
}) => {
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.catalog = {
    model: { capabilities: { reasoning: false } },
    reasoning: {
      presets: [
        {
          id: 'ultra',
          name: 'Ultra',
          enabled: false,
          body: { reasoning_effort: 'ultra' },
        },
      ],
    },
  };
  await page.goto('/#/deployments/idle/configuration');
  await openCard(page, 'variants');
  const section = page.getByRole('region', { name: 'Variants', exact: true });
  await section
    .getByRole('button', { name: 'Ultra variant actions', exact: true })
    .click();
  await expect(
    page.getByRole('menuitem', { name: 'Remove', exact: true }),
  ).toBeEnabled();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Edit Ultra', exact: true });
  await drawer
    .getByRole('button', { name: 'Token budget', exact: true })
    .click();
  await drawer.getByLabel('Token budget', { exact: true }).fill('8192');
  await drawer.getByRole('button', { name: 'Apply changes' }).click();
  await section
    .getByRole('switch', { name: 'Enable Ultra variant', exact: true })
    .check();
  await page
    .getByLabel('Default reasoning level', { exact: true })
    .selectOption('ultra');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  const saved = deploymentDraft(
    fixture.writes.find((w) => w.path === '/api/model-setups?expected=1')!.body,
  ).configuration!.catalog;
  expect(saved.model?.capabilities?.reasoning).toBe(false);
  expect(saved.reasoning?.default_mode).toBe('ultra');
  expect(saved.reasoning?.presets?.find((p) => p.id === 'ultra')).toMatchObject(
    { enabled: true, body: { reasoning_budget: 8192 } },
  );
});
