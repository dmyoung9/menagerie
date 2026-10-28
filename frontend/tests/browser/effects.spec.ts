import { test, expect, type Page } from '@playwright/test';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(String(error)));
});
test.afterEach(({ page }) => {
  expect(errors.get(page), 'No React/browser errors').toEqual([]);
});

test('JSON validation survives callback churn and reports external replacements once', async ({
  page,
}) => {
  await page.goto('/tests/effects.html');
  await page.getByText('JSON value', { exact: true }).click();
  const input = page.getByRole('textbox', { name: 'JSON value' });
  const reports = page.getByLabel('Validation reports');
  await input.fill('{broken');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(reports).toHaveText('0:false');
  await page.getByRole('button', { name: 'Rerender parent' }).click();
  await expect(input).toHaveValue('{broken');
  await expect(reports).toHaveText('0:false');
  await page.getByRole('button', { name: 'Replace value' }).click();
  await expect(input).toHaveValue('{\n  "count": 2\n}');
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await expect(reports).toHaveText('0:false,1:true');
  await page.getByRole('button', { name: 'Rerender parent' }).click();
  await expect(reports).toHaveText('0:false,1:true');
});

test('catalog effects switch API clients and ignore the old in-flight response', async ({
  page,
}) => {
  await page.goto('/tests/effects.html?scenario=variant');
  await expect(page.getByLabel('API calls')).toContainText(
    'original:revisions',
  );
  await page.evaluate(() => window.dispatchEvent(new Event('replace-client')));
  await expect(page.getByText('Pinned commit: replacement')).toBeVisible();
  await expect(
    page.getByRole('option', { name: 'replacement · branch' }),
  ).toHaveCount(1);
  await expect(page.getByLabel('API calls')).toHaveText(
    'original:files,original:revisions,replacement:files,replacement:revisions',
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event('resolve-original')),
  );
  await expect(page.getByLabel('API calls')).toContainText(
    'original:completed',
  );
  await expect(page.getByText('Pinned commit: replacement')).toBeVisible();
  await expect(
    page.getByText('Pinned commit: original', { exact: true }),
  ).toHaveCount(0);
});

test('wizard preserves edits on identical polling snapshots but updates changed supported defaults', async ({
  page,
}) => {
  await page.route('**/api/resources/preview', (route) =>
    route.fulfill({
      json: { members: [], gpus: [], ram_available_mib: 0, ram_reserve_mib: 0 },
    }),
  );
  await page.goto('/tests/effects.html?scenario=wizard');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByText('Advanced', { exact: true }).click();
  await page.getByText('Runtime options (JSON)', { exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Runtime options (JSON)' });
  await input.fill('{"gpu-layers":"17"}');
  await page.evaluate(() => window.dispatchEvent(new Event('poll-registry')));
  await expect(page.getByLabel('Registry snapshot')).toHaveText('1');
  await expect(input).toHaveValue('{"gpu-layers":"17"}');
  await page.evaluate(() => window.dispatchEvent(new Event('change-schema')));
  await expect(input).toHaveValue(
    '{\n  "flash-attn": "on",\n  "gpu-layers": "17"\n}',
  );
  await page.evaluate(() => window.dispatchEvent(new Event('replace-engine')));
  await expect(input).toHaveValue(
    '{\n  "gpu-layers": "all",\n  "flash-attn": "on"\n}',
  );
});
