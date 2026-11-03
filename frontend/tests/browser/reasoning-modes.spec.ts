import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { deploymentDraft } from '../../src/contracts';
import type { ModelCatalog } from '../../src/types';

for (const width of [1440, 576, 320]) {
  test(`reasoning uses compact standard and user-created toggles at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    fixture.registry.models[0].discovered_capabilities = {
      reasoning: true,
      thinking_toggle: true,
      reasoning_effort: ['spoon', 'einstein', 'xhigh'],
    };
    await page.goto('/#/deployments/idle/configuration');
    await page
      .getByRole('group', { name: 'Capabilities', exact: true })
      .getByRole('button', { name: 'Reasoning', exact: true })
      .click();
    const section = page.getByRole('region', {
      name: 'Reasoning options',
      exact: true,
    });
    const toggles = section.getByRole('group', {
      name: 'Reasoning options',
      exact: true,
    });
    await expect(toggles.getByRole('button')).toHaveText([
      'Instant',
      'Low',
      'Medium',
      'High',
    ]);
    for (const button of await toggles.getByRole('button').all())
      await expect(button).toBeDisabled();
    await expect(
      section.getByText('Model template suggestions', { exact: true }),
    ).toHaveCount(0);
    await expect(section.getByText(/spoon|einstein|xhigh/i)).toHaveCount(0);
    await expect(
      section.locator('[data-reasoning-mode="instant"]'),
    ).toHaveCount(1);
    await section
      .getByLabel('Instant control', { exact: true })
      .selectOption('template');
    await expect(
      section.getByLabel('Instant thinking', { exact: true }),
    ).toHaveValue('false');
    await toggles.getByRole('button', { name: 'Instant', exact: true }).click();
    await section
      .getByLabel('Low control', { exact: true })
      .selectOption('effort');
    await expect(section.getByLabel('Low effort', { exact: true })).toHaveValue(
      'low',
    );
    await section
      .getByLabel('Medium control', { exact: true })
      .selectOption('thinking_budget');
    await section.getByLabel('Medium token budget', { exact: true }).fill('-1');
    await section
      .getByLabel('High control', { exact: true })
      .selectOption('custom');
    const composite = {
      reasoning_effort: 'high',
      reasoning_budget: 8192,
      chat_template_kwargs: { enable_thinking: true, style: 'research' },
    };
    await section
      .getByLabel('High custom settings', { exact: true })
      .fill(JSON.stringify(composite));
    await section.getByText('Add custom level', { exact: true }).click();
    await section
      .getByLabel('New level name', { exact: true })
      .fill('Research');
    await section
      .getByLabel('New level ID', { exact: true })
      .fill('custom-research');
    await section
      .getByRole('button', { name: 'Add level', exact: true })
      .click();
    const custom = toggles.getByRole('button', {
      name: 'Research',
      exact: true,
    });
    await expect(custom).toBeDisabled();
    await section
      .getByLabel('Research control', { exact: true })
      .selectOption('custom');
    await section
      .getByLabel('Research custom settings', { exact: true })
      .fill(JSON.stringify(composite));
    await section
      .getByLabel('Research prompt prefix', { exact: true })
      .fill('{REASON:research}');
    await custom.focus();
    await page.keyboard.press('Space');
    await expect(custom).toHaveAttribute('aria-pressed', 'true');
    await expect(custom.locator('svg')).toHaveCount(0);
    await expect(
      section.getByText('Expose to clients', { exact: true }),
    ).toHaveCount(0);
    await section
      .getByLabel('Default reasoning mode', { exact: true })
      .selectOption('custom-research');
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
    expect(saved.reasoning?.default_mode).toBe('custom-research');
    expect(
      saved.reasoning?.presets?.find((p) => p.id === 'custom-research'),
    ).toEqual({
      id: 'custom-research',
      name: 'Research',
      enabled: true,
      body: composite,
      prompt_prefix: '{REASON:research}',
    });
    expect(
      saved.reasoning?.presets?.find((p) => p.id === 'medium')?.body,
    ).toEqual({ thinking_budget: -1 });
    expect(
      saved.reasoning?.presets?.find((p) => p.id === 'high')?.body,
    ).toEqual(composite);
    await page.reload();
    await expect(custom).toHaveAttribute('aria-pressed', 'true');
    await expect(
      section.getByLabel('Research custom settings', { exact: true }),
    ).toHaveValue(JSON.stringify(composite, null, 2));
    await custom.click();
    await expect(
      section.getByLabel('Default reasoning mode', { exact: true }),
    ).toHaveValue('custom-research');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(custom).toHaveAttribute('aria-pressed', 'true');
    await toggles.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`reasoning-toggles-${width}.png`),
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
    await section
      .getByRole('button', { name: 'Remove Research level', exact: true })
      .click();
    await expect(custom).toHaveCount(0);
    await expect(
      section.getByLabel('Default reasoning mode', { exact: true }),
    ).toHaveValue('');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(custom).toHaveAttribute('aria-pressed', 'true');
  });
}

test('saved custom levels and legacy Default keep their exact settings without creating other presets', async ({
  page,
  fixture,
}) => {
  const catalog: ModelCatalog = {
    model: { capabilities: { reasoning: true } },
    reasoning: {
      default_mode: 'private-level',
      presets: [
        {
          id: 'default',
          name: 'Custom Default',
          enabled: true,
          body: { reasoning_budget: 1234 },
        },
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
        { id: 'instant', enabled: false, body: {} },
      ],
    },
  };
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.catalog = structuredClone(catalog);
  await page.goto('/#/deployments/idle/configuration');
  const section = page.getByRole('region', {
    name: 'Reasoning options',
    exact: true,
  });
  await expect(
    section.getByLabel('Custom Default token budget', { exact: true }),
  ).toHaveValue('1234');
  await expect(
    section.getByLabel('Private level custom settings', { exact: true }),
  ).toHaveValue(JSON.stringify(catalog.reasoning!.presets![1].body, null, 2));
  await expect(
    section.getByLabel('Default reasoning mode', { exact: true }),
  ).toHaveValue('private-level');
  await expect(
    section
      .getByRole('group', { name: 'Reasoning options', exact: true })
      .getByRole('button', { name: 'Instant', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Preserved levels');
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
  ).toEqual(catalog.reasoning);
});

test('invalid custom drafts remain blocking independently; removal and discard recover correctly', async ({
  page,
  fixture,
}) => {
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.catalog = {
    model: { capabilities: { reasoning: true } },
    reasoning: {
      presets: ['one', 'two'].map((id) => ({ id, enabled: false, body: {} })),
    },
  };
  await page.goto('/#/deployments/idle/configuration');
  const section = page.getByRole('region', {
    name: 'Reasoning options',
    exact: true,
  });
  for (const name of ['One', 'Two']) {
    await section
      .getByLabel(name + ' control', { exact: true })
      .selectOption('custom');
    await section
      .getByLabel(name + ' custom settings', { exact: true })
      .fill('{invalid');
  }
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  await section
    .getByRole('button', { name: 'Remove One level', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section.locator('[data-reasoning-mode="one"]')).toHaveCount(1);
  await section.getByText('Add custom level', { exact: true }).click();
  await section.getByLabel('New level name', { exact: true }).fill('Duplicate');
  for (const id of ['one', 'instant', 'model-default']) {
    await section.getByLabel('New level ID', { exact: true }).fill(id);
    await expect(
      section.getByRole('button', { name: 'Add level', exact: true }),
    ).toBeDisabled();
  }
});
