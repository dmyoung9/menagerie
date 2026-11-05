import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

for (const width of [1440, 576, 320]) {
  test(`Flash Attention uses Auto/On/Off radios with Auto default at ${width}px`, async ({
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
    await expect(
      page.getByRole('radiogroup', { name: 'Flash attention', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Discard', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: 'Add performance flags', exact: true })
      .click();
    const drawer = page.getByRole('dialog', {
      name: 'Add performance flags',
      exact: true,
    });
    await drawer
      .getByRole('checkbox', { name: 'Flash attention', exact: true })
      .check();
    await drawer.getByRole('button', { name: 'Add (1)', exact: true }).click();
    const radios = page.getByRole('radiogroup', {
      name: 'Flash attention',
      exact: true,
    });
    await expect(radios.getByRole('radio')).toHaveCount(3);
    const group = page.getByRole('group', {
      name: 'Performance flags',
      exact: true,
    });
    await expect(group).toHaveJSProperty('tagName', 'FIELDSET');
    await expect(group.locator(':scope > legend')).toHaveText(
      'Performance flags',
    );
    const field = page.locator('[data-runtime-flag="flash-attn"]');
    await expect(
      field.locator(':scope > div[data-slot="field-label"]'),
    ).toHaveText('Flash attention');
    await expect(
      field.locator(':scope > div[data-slot="field-label"] code'),
    ).toHaveCount(0);
    const syntax = field.locator(':scope > label[data-slot="field-label"]');
    await expect(syntax).toHaveText('(--flash-attn [on|off|auto])');
    await expect(syntax.locator(':scope > code')).toHaveText(
      '(--flash-attn [on|off|auto])',
    );
    await expect(radios).toHaveAccessibleDescription(
      '(--flash-attn [on|off|auto]) default: auto',
    );
    await expect(
      field.locator(':scope > [data-slot="field-description"]'),
    ).toHaveText('default: auto');
    expect(
      await field.evaluate((element) =>
        Array.from(element.children).map(
          (child) => child.getAttribute('data-slot') || 'controls',
        ),
      ),
    ).toEqual([
      'field-label',
      'field-label',
      'radio-group',
      'field-description',
    ]);
    const item = field.locator('..').locator('..');
    await expect(item).toHaveAttribute('data-slot', 'item');
    await expect(
      item.locator(':scope > [data-slot="item-actions"] > button'),
    ).toHaveAccessibleName('Remove Flash attention override');
    await expect(field.getByRole('button', { name: /Remove/ })).toHaveCount(0);
    const controlBox = await radios.boundingBox();
    const titleBox = await field
      .locator(':scope > div[data-slot="field-label"]')
      .boundingBox();
    const syntaxBox = await syntax.boundingBox();
    expect(syntaxBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height);
    expect(controlBox!.y).toBeGreaterThanOrEqual(
      syntaxBox!.y + syntaxBox!.height,
    );
    const descriptionBox = await field
      .locator(':scope > [data-slot="field-description"]')
      .boundingBox();
    expect(descriptionBox!.y).toBeGreaterThanOrEqual(
      controlBox!.y + controlBox!.height,
    );
    await expect(radios.locator('label')).toHaveText(['Auto', 'On', 'Off']);
    for (const name of ['Auto', 'On', 'Off'])
      await expect(
        radios.getByRole('radio', { name, exact: true }),
      ).toBeVisible();
    const auto = radios.getByRole('radio', { name: 'Auto', exact: true });
    await expect(auto).toBeChecked();
    await auto.focus();
    await page.keyboard.press('ArrowRight');
    await expect(
      radios.getByRole('radio', { name: 'On', exact: true }),
    ).toBeChecked();
    await page.keyboard.press('ArrowRight');
    await expect(
      radios.getByRole('radio', { name: 'Off', exact: true }),
    ).toBeChecked();
    await radios.getByText('Auto', { exact: true }).click();
    await expect(auto).toBeChecked();
    await radios.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`flash-attention-${width}.png`),
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
  });
}

for (const selected of ['auto', 'on', 'off']) {
  test(`saved Flash Attention ${selected} survives editing and discard`, async ({
    page,
    fixture,
  }) => {
    fixture.registry.runtimes[0].capabilities!.schema!['flash-attn'] = {
      type: 'enum',
      choices: ['auto', 'on', 'off'],
      default: 'auto',
      label: 'Flash attention',
    };
    fixture.registry.deployments.find(
      (d) => d.id === 'idle',
    )!.profile_snapshot!.config['flash-attn'] = selected;
    await page.goto('/#/deployments/idle/configuration');
    const radios = page.getByRole('radiogroup', {
      name: 'Flash attention',
      exact: true,
    });
    const name = (value: string) =>
      value === 'auto' ? 'Auto' : value === 'on' ? 'On' : 'Off';
    await expect(
      radios.getByRole('radio', { name: name(selected), exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole('button', { name: 'Discard', exact: true }),
    ).toBeDisabled();
    await radios
      .getByRole('radio', {
        name: selected === 'on' ? 'Auto' : 'On',
        exact: true,
      })
      .click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(
      radios.getByRole('radio', { name: name(selected), exact: true }),
    ).toBeChecked();
    await page.getByLabel('Display name', { exact: true }).fill('Renamed');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(
        () =>
          fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
      )
      .toBe(2);
    expect(
      deploymentDraft(
        fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!
          .body,
      ).configuration!.config['flash-attn'],
    ).toBe(selected);
  });
}

test('Flash Attention Off remains unavailable for quantized V cache and radios respect loaded read-only state', async ({
  page,
  fixture,
}) => {
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
      default: 'q8_0',
      label: 'V cache',
    },
  });
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.config['flash-attn'] = 'auto';
  await page.goto('/#/deployments/idle/configuration');
  const radios = page.getByRole('radiogroup', {
    name: 'Flash attention',
    exact: true,
  });
  const off = radios.getByRole('radio', { name: 'Off', exact: true });
  await expect(off).toBeDisabled();
  await page
    .getByRole('combobox', { name: 'V cache', exact: true })
    .selectOption('f16');
  await expect(off).toBeEnabled();
  await off.click();
  await expect(off).toBeChecked();
  await expect(
    page
      .getByRole('combobox', { name: 'V cache', exact: true })
      .getByRole('option', { name: 'q8_0', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.goto('/#/deployments/ready/configuration');
  for (const name of ['Auto', 'On', 'Off'])
    await expect(
      radios.getByRole('radio', { name, exact: true }),
    ).toBeDisabled();
});
