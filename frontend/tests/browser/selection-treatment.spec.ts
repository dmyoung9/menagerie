import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function primaryColors(page: Page) {
  return page.evaluate(() => {
    const sample = document.createElement('span');
    sample.style.backgroundColor = 'var(--primary)';
    sample.style.color = 'var(--primary-foreground)';
    document.body.append(sample);
    const style = getComputedStyle(sample);
    const colors = {
      background: style.backgroundColor,
      foreground: style.color,
    };
    sample.remove();
    return colors;
  });
}

async function expectPrimary(
  button: Locator,
  colors: Awaited<ReturnType<typeof primaryColors>>,
) {
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveCSS('background-color', colors.background);
  await expect(button).toHaveCSS('color', colors.foreground);
}

for (const width of [1440, 576, 320]) {
  test(`catalog variant selections use primary color without checkmarks at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route('**/api/catalog/hf/files?*', (route) =>
      route.fulfill({
        json: {
          revision: 'fixture-primary-commit',
          files: [
            'model-7B-Q4_K_M.gguf',
            'model-7B-Q4_K_S.gguf',
            'model-14B-Q8_0.gguf',
            'model.safetensors',
            'config.json',
          ].map((name) => ({ name, size: 1024 })),
        },
      }),
    );
    await page.goto('/#/models/discover');
    await page.getByRole('textbox', { name: 'Catalog search' }).fill('fixture');
    await page.getByRole('button', { name: 'Search catalog' }).click();
    await page.getByRole('button', { name: 'Choose variant' }).click();
    const dialog = page.getByRole('dialog');
    const colors = await primaryColors(page);
    const format = dialog.getByRole('group', { name: 'Format', exact: true });
    const parameters = dialog.getByRole('group', {
      name: 'Parameter size',
      exact: true,
    });
    const quant = dialog.getByRole('group', {
      name: 'Quantization',
      exact: true,
    });
    const suffix = dialog.getByRole('group', {
      name: 'Size / quality suffix',
      exact: true,
    });
    const download = dialog.getByRole('button', {
      name: 'Download',
      exact: true,
    });
    await expect(download).toBeDisabled();
    await expect(
      quant.getByRole('button', { name: 'Q4_K', exact: true }),
    ).toBeDisabled();
    await format.getByRole('button', { name: 'GGUF', exact: true }).click();
    await parameters.getByRole('button', { name: '7B', exact: true }).click();
    await expect(download).toBeDisabled();
    const medium = suffix.getByRole('button', { name: 'M', exact: true });
    await medium.focus();
    await page.keyboard.press('Space');
    await page.mouse.move(0, 0);
    await expect(download).toBeEnabled();
    const selected = dialog.locator('button[aria-pressed="true"]');
    await expect(selected).toHaveCount(4);
    for (const button of await selected.all())
      await expectPrimary(button, colors);
    await expect(
      dialog.locator('[data-slot="toggle-group-item"] svg'),
    ).toHaveCount(0);
    await expect(
      quant.getByRole('button', { name: 'Q5_K', exact: true }),
    ).toBeDisabled();
    await parameters.getByRole('button', { name: '14B', exact: true }).click();
    await page.mouse.move(0, 0);
    await expectPrimary(
      quant.getByRole('button', { name: 'Q8_0', exact: true }),
      colors,
    );
    await expectPrimary(
      suffix.getByRole('button', { name: 'No suffix', exact: true }),
      colors,
    );
    await expect(
      quant.getByRole('button', { name: 'Q4_K', exact: true }),
    ).not.toHaveCSS('background-color', colors.background);
    await expect(medium).toBeDisabled();
    await format
      .getByRole('button', { name: 'Safetensors', exact: true })
      .click();
    await page.mouse.move(0, 0);
    for (const button of await selected.all())
      await expectPrimary(button, colors);
    await expectPrimary(
      quant.getByRole('button', { name: 'As published', exact: true }),
      colors,
    );
    await expect(download).toBeEnabled();
    await expect(download).toHaveCSS('opacity', '1');
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`primary-catalog-variant-${width}.png`),
    });
    await download.click();
    await expect(dialog).toBeHidden();
    expect(
      fixture.writes.find((w) => w.path === '/api/downloads')?.body,
    ).toMatchObject({
      repo: 'fixture/model',
      revision: 'fixture-primary-commit',
      filename: '__safetensors__',
    });
  });

  test(`capability selections use primary color without checkmarks at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    fixture.registry.deployments.find(
      (d) => d.id === 'idle',
    )!.profile_snapshot!.catalog = {
      model: {
        capabilities: {
          tools: true,
          input: ['text'],
          output: ['text'],
          reasoning: { supported: true },
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
        ],
      },
    };
    await page.goto('/#/deployments/idle/configuration');
    const panel = page.getByRole('region', {
      name: 'Modalities and capabilities',
      exact: true,
    });
    const colors = await primaryColors(page);
    const selected = panel.locator('button[aria-pressed="true"]');
    await expect(selected).toHaveCount(4);
    for (const button of await selected.all())
      await expectPrimary(button, colors);
    await expect(panel.locator('.lucide-check')).toHaveCount(0);
    const inputs = panel.getByRole('group', {
      name: 'Input modalities',
      exact: true,
    });
    const text = inputs.getByRole('button', { name: 'Text', exact: true });
    await expect(text).toBeDisabled();
    await expect(text.locator('svg')).toHaveCount(1);
    const image = inputs.getByRole('button', { name: 'Images', exact: true });
    await expect(image).not.toHaveCSS('background-color', colors.background);
    await image.focus();
    await page.keyboard.press('Space');
    await page.mouse.move(0, 0);
    await expectPrimary(image, colors);
    await expect(text).toBeEnabled();
    await text.click();
    await expect(text).toHaveAttribute('aria-pressed', 'false');
    await expect(text).not.toHaveCSS('background-color', colors.background);
    await expect(image).toBeDisabled();
    const options = page.getByRole('region', {
      name: 'Variants',
      exact: true,
    });
    const instant = options.getByRole('switch', {
      name: 'Enable Instant variant',
      exact: true,
    });
    await expect(instant).toBeChecked();
    await instant.uncheck();
    await expect(instant).not.toBeChecked();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expectPrimary(text, colors);
    await expect(instant).toBeChecked();
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`primary-capabilities-${width}.png`),
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

  test(`installed quantization choices use primary color without icons at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    fixture.registry.models = ['Q4_K_M', 'Q4_K_S', 'Q8_0'].map((quant, i) => ({
      ...fixture.registry.models[0],
      id: `model-${i}`,
      name: `Example-${quant}.gguf`,
      repo: 'example/model',
      quantization: quant,
    }));
    await page.goto('/#/models/installed');
    await page
      .getByRole('button', { name: 'Details', exact: true })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    const quants = dialog.getByRole('group', {
      name: 'Installed quant',
      exact: true,
    });
    const suffixes = dialog.getByRole('group', {
      name: 'Installed suffix',
      exact: true,
    });
    const colors = await primaryColors(page);
    await expect(quants.locator('svg')).toHaveCount(0);
    await expect(suffixes.locator('svg')).toHaveCount(0);
    await expectPrimary(
      quants.getByRole('button', { name: 'Q4_K', exact: true }),
      colors,
    );
    await expectPrimary(
      suffixes.getByRole('button', { name: 'M', exact: true }),
      colors,
    );
    await suffixes.getByRole('button', { name: 'S', exact: true }).click();
    await page.mouse.move(0, 0);
    await expectPrimary(
      suffixes.getByRole('button', { name: 'S', exact: true }),
      colors,
    );
    const q8 = quants.getByRole('button', { name: 'Q8_0', exact: true });
    await q8.focus();
    await page.keyboard.press('Space');
    await expectPrimary(q8, colors);
    await expectPrimary(
      suffixes.getByRole('button', { name: 'No suffix', exact: true }),
      colors,
    );
    await expect(
      suffixes.getByRole('button', { name: 'S', exact: true }),
    ).toBeDisabled();
    await expect(
      quants.getByRole('button', { name: 'F32', exact: true }),
    ).toBeDisabled();
    await expect(
      quants.getByRole('button', { name: 'Q4_K', exact: true }),
    ).not.toHaveCSS('background-color', colors.background);
    await page.screenshot({
      path: testInfo.outputPath(`primary-quantization-${width}.png`),
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
    expect(fixture.writes).toEqual([]);
  });
}
