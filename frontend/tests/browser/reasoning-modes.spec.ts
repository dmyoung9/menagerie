import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

for (const width of [1440, 576, 320]) {
  test(`custom reasoning modes compose settings, defaults and exposure at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/#/deployments/idle/configuration');
    await page
      .getByRole('group', { name: 'Capabilities', exact: true })
      .getByRole('button', { name: 'Reasoning', exact: true })
      .click();
    const section = page.getByRole('region', {
      name: 'Reasoning modes',
      exact: true,
    });
    await expect(section.locator('[data-reasoning-mode]')).toHaveCount(0);
    await expect(
      section.getByLabel('Default reasoning mode', { exact: true }),
    ).toHaveValue('');
    await expect(
      section.getByRole('button', { name: /Instant|Low|Medium|High/ }),
    ).toHaveCount(0);
    await section
      .getByLabel('New mode name', { exact: true })
      .fill('Research 8K');
    await section.getByLabel('New mode ID', { exact: true }).fill('spoon');
    await section
      .getByRole('button', { name: 'Add mode', exact: true })
      .click();
    const mode = section.locator('[data-reasoning-mode="spoon"]');
    await mode
      .getByLabel('Research 8K thinking', { exact: true })
      .selectOption('true');
    await mode
      .getByLabel('Research 8K native effort', { exact: true })
      .fill('xhigh');
    await mode
      .getByLabel('Research 8K template effort', { exact: true })
      .fill('spoon');
    await mode
      .getByLabel('Research 8K reasoning budget mode', { exact: true })
      .selectOption('custom');
    await mode
      .getByLabel('Research 8K reasoning tokens', { exact: true })
      .fill('8192');
    await mode
      .getByLabel('Research 8K thinking budget mode', { exact: true })
      .selectOption('unlimited');
    await mode
      .getByLabel('Research 8K prompt prefix', { exact: true })
      .fill('{REASON:spoon}');
    await mode
      .getByRole('button', {
        name: 'Expose Research 8K to clients',
        exact: true,
      })
      .click();
    await section
      .getByLabel('Default reasoning mode', { exact: true })
      .selectOption('spoon');
    await mode.getByText('Resolved request changes', { exact: true }).click();
    await expect(mode.locator('pre')).toContainText(
      '"reasoning_effort": "xhigh"',
    );
    await expect(mode.locator('pre')).toContainText('"reasoning_budget": 8192');
    await expect(mode.locator('pre')).toContainText('"thinking_budget": -1');
    await expect(mode.locator('pre')).toContainText('"enable_thinking": true');
    await mode.getByRole('button', { name: 'Duplicate', exact: true }).click();
    const copy = section.locator('[data-reasoning-mode="spoon-copy"]');
    await expect(
      copy.getByRole('button', {
        name: 'Expose Research 8K copy to clients',
        exact: true,
      }),
    ).toHaveAttribute('aria-pressed', 'false');
    await copy
      .getByLabel('Research 8K copy thinking', { exact: true })
      .selectOption('false');
    await copy
      .getByLabel('Research 8K copy template effort', { exact: true })
      .fill('ispoon');
    await copy
      .getByRole('button', { name: 'Move Research 8K copy up', exact: true })
      .click();
    await expect(
      section.locator('[data-reasoning-mode]').first(),
    ).toHaveAttribute('data-reasoning-mode', 'spoon-copy');
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
    expect(saved.reasoning?.default_mode).toBe('spoon');
    expect(saved.reasoning?.presets?.map((p) => p.id)).toEqual([
      'spoon-copy',
      'spoon',
    ]);
    expect(saved.reasoning?.presets?.[1]).toEqual({
      id: 'spoon',
      name: 'Research 8K',
      enabled: true,
      body: {
        chat_template_kwargs: {
          enable_thinking: true,
          reasoning_effort: 'spoon',
        },
        reasoning_effort: 'xhigh',
        reasoning_budget: 8192,
        thinking_budget: -1,
      },
      prompt_prefix: '{REASON:spoon}',
    });
    await page.reload();
    await expect(
      section.getByLabel('Default reasoning mode', { exact: true }),
    ).toHaveValue('spoon');
    await expect(
      mode.getByLabel('Research 8K reasoning tokens', { exact: true }),
    ).toHaveValue('8192');
    await copy.getByRole('button', { name: 'Remove', exact: true }).click();
    await mode.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`reasoning-modes-${width}.png`),
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
    await mode.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(
      section.getByLabel('Default reasoning mode', { exact: true }),
    ).toHaveValue('');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(section.locator('[data-reasoning-mode]')).toHaveCount(2);
    await expect(
      section.getByLabel('Default reasoning mode', { exact: true }),
    ).toHaveValue('spoon');
  });
}

test('template suggestions are explicit, disabled for client exposure and cannot overwrite saved modes', async ({
  page,
  fixture,
}) => {
  fixture.registry.models[0].discovered_capabilities = {
    reasoning: true,
    thinking_toggle: true,
    reasoning_effort: ['spoon', 'xhigh'],
  };
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.catalog = {
    model: { capabilities: { reasoning: true } },
    reasoning: {
      presets: [
        {
          id: 'spoon',
          name: 'Saved Spoon',
          enabled: false,
          body: { reasoning_budget: 1234 },
        },
      ],
    },
  };
  await page.goto('/#/deployments/idle/configuration');
  const section = page.getByRole('region', {
    name: 'Reasoning modes',
    exact: true,
  });
  await expect(
    section.getByRole('button', { name: 'Add Spoon', exact: true }),
  ).toHaveCount(0);
  await expect(section.locator('[data-reasoning-mode]')).toHaveCount(1);
  await section.getByRole('button', { name: 'Add Xhigh', exact: true }).click();
  await expect(
    section
      .locator('[data-reasoning-mode="xhigh"]')
      .getByLabel('Xhigh template effort', { exact: true }),
  ).toHaveValue('xhigh');
  await expect(
    section.getByRole('button', {
      name: 'Expose Xhigh to clients',
      exact: true,
    }),
  ).toHaveAttribute('aria-pressed', 'false');
  await section
    .getByRole('button', { name: 'Add Thinking off', exact: true })
    .click();
  await expect(
    section
      .locator('[data-reasoning-mode="thinking-off"]')
      .getByLabel('Thinking off thinking', { exact: true }),
  ).toHaveValue('false');
  await section
    .getByLabel('New mode name', { exact: true })
    .fill('Duplicate ID');
  await section.getByLabel('New mode ID', { exact: true }).fill('spoon');
  await expect(
    section.getByRole('button', { name: 'Add mode', exact: true }),
  ).toBeDisabled();
  await section
    .getByLabel('New mode ID', { exact: true })
    .fill('model-default');
  await expect(
    section.getByRole('button', { name: 'Add mode', exact: true }),
  ).toBeDisabled();
  await expect(
    section.getByLabel('Saved Spoon reasoning tokens', { exact: true }),
  ).toHaveValue('1234');
});

test('removing one invalid JSON draft does not hide another invalid mode, and discard resets drafts', async ({
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
    name: 'Reasoning modes',
    exact: true,
  });
  for (const name of ['One', 'Two']) {
    await section
      .getByText(name + ' template arguments (JSON)', { exact: true })
      .click();
    await section
      .getByLabel(name + ' template arguments (JSON)', { exact: true })
      .fill('{invalid');
  }
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  await section
    .locator('[data-reasoning-mode="one"]')
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section.locator('[data-reasoning-mode]')).toHaveCount(2);
});

test('template changes replace suggestions and ignore stale hint responses', async ({
  page,
  fixture,
}) => {
  fixture.registry.models[0].templates = [
    {
      id: 'custom-template',
      kind: 'custom',
      artifact_id: 'model',
      name: 'Custom',
      sha256: 'fixture-hash',
      repo: null,
      source_revision: null,
      file_path: '/templates/custom.jinja',
      relative_path: null,
      size_bytes: 128,
      error: null,
      status: 'available',
    },
  ];
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.catalog = {
    model: { capabilities: { reasoning: true } },
  };
  let initialRequested = false;
  let releaseInitial = () => {};
  const held = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  await page.route('**/api/models/*/reasoning-hints**', async (route) => {
    if (!new URL(route.request().url()).searchParams.has('template_source')) {
      initialRequested = true;
      await held;
      await route.fulfill({
        json: { reasoning_effort: ['stale'], thinking_toggle: true },
      });
    } else await route.fulfill({ json: { reasoning_effort: ['current'] } });
  });
  await page.goto('/#/deployments/idle/configuration');
  await expect.poll(() => initialRequested).toBe(true);
  await page
    .getByLabel('Chat template', { exact: true })
    .selectOption('custom-template');
  const section = page.getByRole('region', {
    name: 'Reasoning modes',
    exact: true,
  });
  await expect(
    section.getByRole('button', { name: 'Add Current', exact: true }),
  ).toBeVisible();
  const oldResponse = page.waitForResponse((response) =>
    response.url().endsWith('/reasoning-hints'),
  );
  releaseInitial();
  await (await oldResponse).finished();
  await section
    .getByRole('button', { name: 'Add Current', exact: true })
    .click();
  await expect(
    section.getByRole('button', { name: 'Add Stale', exact: true }),
  ).toHaveCount(0);
  await expect(
    section.getByRole('button', { name: 'Add Thinking off', exact: true }),
  ).toHaveCount(0);
  await expect(section.locator('[data-reasoning-mode]')).toHaveCount(1);
});
