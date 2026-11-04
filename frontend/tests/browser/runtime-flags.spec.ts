import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

test('unrelated saves keep omitted flags absent and clearing a saved value stays dirty until discarded', async ({
  page,
  fixture,
}) => {
  fixture.registry.runtimes[0].capabilities!.schema!['top-k'] = {
    type: 'integer',
    label: 'Top-k',
    min: 0,
    max: 1048576,
  };
  fixture.registry.runtimes[0].capabilities!.schema!['top-p'] = {
    type: 'number',
    label: 'Top-p',
    min: 0,
    max: 1,
  };
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.config['top-p'] = 0.955;
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.config['top-k'] = 0;
  await page.goto('/#/deployments/idle/configuration');
  await page.getByLabel('Top-k', { exact: true }).fill('');
  await expect(
    page.getByRole('button', { name: 'Discard', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(
    fixture.writes.filter((w) => w.path.startsWith('/api/deployments?')),
  ).toHaveLength(0);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByLabel('Top-k', { exact: true })).toHaveValue('0');
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Renamed fixture');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  const saved = deploymentDraft(
    fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!.body,
  ).configuration!.config;
  expect(saved['top-k']).toBe(0);
  expect(saved['top-p']).toBe(0.955);
  expect(saved).not.toHaveProperty('threads');
});

test('saved thread counts above host concurrency remain editable and save unchanged', async ({
  page,
  fixture,
}) => {
  fixture.registry.runtimes[0].capabilities!.schema!.threads.label =
    'CPU threads';
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.config.threads = 16;
  await page.goto('/#/deployments/idle/configuration');
  await expect(page.getByLabel('CPU threads', { exact: true })).toHaveValue(
    '16',
  );
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Oversubscribed fixture');
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
    ).configuration!.config.threads,
  ).toBe(16);
});

for (const width of [1440, 576, 320]) {
  test(`flag picker and editable items preserve explicit settings at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    Object.assign(fixture.registry.runtimes[0].capabilities!.schema!, {
      'top-p': { type: 'number', label: 'Top-p', min: 0, max: 1 },
      'top-k': { type: 'integer', label: 'Top-k', min: 0, max: 1048576 },
      'repeat-penalty': {
        type: 'number',
        label: 'Repetition penalty',
        min: 0,
        max: 10,
      },
      'reasoning-budget': {
        type: 'integer',
        label: 'Default reasoning budget',
        min: -1,
        max: 1048576,
      },
    });
    const original = fixture.registry.deployments.find(
      (d) => d.id === 'idle',
    )!.profile_snapshot!;
    Object.assign(original.config, {
      'top-p': 0.95,
      'top-k': 0,
      extension: false,
    });
    await page.goto('/#/deployments/idle/configuration');
    const card = page.getByRole('region', { name: 'Generation', exact: true });
    const rows = card.locator('[data-slot="item"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute('data-size', 'sm');
    await expect(rows.first()).toContainText(
      '--top-p N · Engine default: 0.95, 1.0 = disabled',
    );
    await expect(
      page.getByRole('button', { name: 'Discard', exact: true }),
    ).toBeDisabled();
    const trigger = card.getByRole('button', {
      name: 'Add generation flags',
      exact: true,
    });
    await trigger.click();
    const drawer = page.getByRole('dialog', {
      name: 'Add generation flags',
      exact: true,
    });
    await expect(drawer.locator('[data-slot="item"]')).toHaveCount(2);
    await expect(drawer.locator('[data-slot="item"]').first()).toHaveAttribute(
      'data-size',
      'default',
    );
    await expect(
      drawer.getByRole('checkbox', { name: 'Top-p', exact: true }),
    ).toHaveCount(0);
    await expect(drawer.getByRole('spinbutton')).toHaveCount(0);
    await expect(drawer.getByRole('slider')).toHaveCount(0);
    await expect(
      drawer.getByRole('button', { name: 'Add (0)', exact: true }),
    ).toBeDisabled();
    await drawer
      .getByText('Penalize repeat sequence of tokens', { exact: true })
      .click();
    await expect(
      drawer.getByRole('checkbox', { name: 'Repetition penalty', exact: true }),
    ).toBeChecked();
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toBeFocused();
    await expect(rows).toHaveCount(2);
    await expect(
      page.getByRole('button', { name: 'Discard', exact: true }),
    ).toBeDisabled();
    await trigger.click();
    await expect(
      drawer.getByRole('checkbox', { name: 'Repetition penalty', exact: true }),
    ).not.toBeChecked();
    await drawer
      .getByRole('checkbox', { name: 'Repetition penalty', exact: true })
      .focus();
    await page.keyboard.press('Space');
    await drawer
      .getByRole('checkbox', { name: 'Default reasoning budget', exact: true })
      .check();
    await expect(
      drawer.getByRole('button', { name: 'Add (2)', exact: true }),
    ).toBeInViewport();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`flag-picker-${width}.png`),
    });
    await drawer.getByRole('button', { name: 'Add (2)', exact: true }).click();
    await expect(rows).toHaveCount(4);
    await expect(trigger).toBeDisabled();
    await expect(
      page.getByLabel('Default reasoning budget', { exact: true }),
    ).toHaveValue('-1');
    const input = page.getByLabel('Repetition penalty', { exact: true });
    await input.fill('');
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect(
      fixture.writes.filter((w) => w.path.startsWith('/api/deployments?')),
    ).toHaveLength(0);
    await input.fill('1.12');
    await page
      .getByRole('slider', { name: 'Repetition penalty range', exact: true })
      .focus();
    await page.keyboard.press('ArrowRight');
    await expect(input).toHaveValue('1.13');
    await page
      .getByRole('button', { name: 'Remove Top-k override', exact: true })
      .click();
    await expect(page.getByLabel('Top-k', { exact: true })).toHaveCount(0);
    await trigger.click();
    await expect(
      drawer.getByRole('checkbox', { name: 'Top-k', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`flag-items-${width}.png`),
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
    expect(saved).toMatchObject({
      'top-p': 0.95,
      'repeat-penalty': 1.13,
      'reasoning-budget': -1,
      extension: false,
    });
    expect(saved).not.toHaveProperty('top-k');
    await page
      .getByRole('button', { name: 'Remove Top-p override', exact: true })
      .click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByLabel('Top-p', { exact: true })).toHaveValue('0.95');
    await page.reload();
    await expect(
      page.getByLabel('Repetition penalty', { exact: true }),
    ).toHaveValue('1.13');
    await page.goto('/#/deployments/ready/configuration');
    await expect(
      page.getByRole('button', { name: 'Add performance flags', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Remove Top-p override', exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel('Top-p', { exact: true })).toBeDisabled();
  });
}
