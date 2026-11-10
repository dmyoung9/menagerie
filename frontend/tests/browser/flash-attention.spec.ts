import AxeBuilder from '@axe-core/playwright';
import { test, expect, openCard, openIdentity } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

for (const width of [1440, 576, 320]) {
  test(`attention and cache share one disclosure without seeding defaults at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    Object.assign(fixture.registry.runtimes[0].capabilities!.schema!, {
      'flash-attn': {
        type: 'enum',
        choices: ['auto', 'on', 'off'],
        default: 'auto',
        label: 'Flash attention',
      },
      'cache-type-v': {
        type: 'enum',
        choices: ['f16', 'q8_0'],
        default: 'f16',
        label: 'V cache',
      },
    });
    await page.goto('/#/deployments/idle/configuration');
    const attention = page.getByRole('combobox', {
      name: 'Flash attention',
      exact: true,
    });
    await expect(attention).toBeHidden();
    await openCard(page, 'memory');
    await expect(attention).toHaveValue('');
    await expect(
      page.getByRole('button', { name: 'Discard', exact: true }),
    ).toBeDisabled();
    for (const value of ['on', 'off', 'auto']) {
      await attention.selectOption(value);
      await expect(attention).toHaveValue(value);
    }
    await attention.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`attention-${width}.png`),
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
    );
    expect(saved.configuration!.config['flash-attn']).toBe('auto');
    expect(saved.configuration!.config).not.toHaveProperty('cache-type-v');
  });
}

for (const selected of ['auto', 'on', 'off']) {
  test(`saved attention ${selected} is counted while closed and survives discard`, async ({
    page,
    fixture,
  }) => {
    fixture.registry.runtimes[0].capabilities!.schema!['flash-attn'] = {
      type: 'enum',
      choices: ['auto', 'on', 'off'],
      label: 'Flash attention',
    };
    fixture.registry.deployments.find(
      (d) => d.id === 'idle',
    )!.profile_snapshot!.config['flash-attn'] = selected;
    await page.goto('/#/deployments/idle/configuration');
    await expect(
      page.locator('[data-settings-section="memory"] [data-card-advanced]'),
    ).toHaveAttribute('data-overrides', '1');
    await openCard(page, 'memory');
    const attention = page.getByLabel('Flash attention', { exact: true });
    await expect(attention).toHaveValue(selected);
    await attention.selectOption(selected === 'on' ? 'auto' : 'on');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await openCard(page, 'memory');
    await expect(attention).toHaveValue(selected);
    await openIdentity(page);
    await page.getByLabel('Display name', { exact: true }).fill('Renamed');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(
        () =>
          fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
      )
      .toBe(2);
    expect(
      fixture.registry.deployments.find((d) => d.id === 'idle')
        ?.profile_snapshot!.config['flash-attn'],
    ).toBe(selected);
  });
}

test('quantized V cache and attention Off stay mutually exclusive; loaded controls are read-only', async ({
  page,
  fixture,
}) => {
  Object.assign(fixture.registry.runtimes[0].capabilities!.schema!, {
    'flash-attn': {
      type: 'enum',
      choices: ['auto', 'on', 'off'],
      label: 'Flash attention',
    },
    'cache-type-v': {
      type: 'enum',
      choices: ['f16', 'q8_0'],
      default: 'q8_0',
      label: 'V cache',
    },
  });
  await page.goto('/#/deployments/idle/configuration');
  await openCard(page, 'memory');
  const attention = page.getByLabel('Flash attention', { exact: true });
  await expect(
    attention.getByRole('option', { name: 'off', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('V cache', { exact: true }).selectOption('f16');
  await attention.selectOption('off');
  await expect(
    page
      .getByLabel('V cache', { exact: true })
      .getByRole('option', { name: 'q8_0', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.goto('/#/deployments/ready/configuration');
  await openCard(page, 'memory');
  await expect(attention).toBeDisabled();
  await expect(page.getByLabel('V cache', { exact: true })).toBeDisabled();
});
