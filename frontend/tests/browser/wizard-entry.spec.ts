import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(String(error)));
});
test.afterEach(({ page }) => {
  expect(errors.get(page), 'No React/browser errors').toEqual([]);
});

test('Deployments entry opens model setup without an infrastructure choice', async ({
  page,
}) => {
  await page.goto('/#/deployments');
  await page.getByRole('button', { name: 'Set up model', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Single model', exact: true }),
  ).toHaveCount(0);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Set up model', { exact: true })).toBeVisible();
  const steps = dialog.locator('.steps li');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText('Choose model');
  await expect(steps.nth(1)).toContainText('Review setup');
  await expect(steps.nth(2)).toContainText('Make available');
  await expect(dialog.getByLabel('Model', { exact: true })).toBeVisible();
});

test('Explicit group creation remains under Advanced', async ({ page }) => {
  await page.goto('/#/deployments');
  await page.getByText('Advanced', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Create supervised group or runtime pool' })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('default setup saves automatic assignment and waits for the model load job', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments');
  await page.getByRole('button', { name: 'Set up model', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Writing Assistant');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Make available and load', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Load', exact: true }).click();
  await expect
    .poll(() => fixture.registry.jobs.some((job) => job.name === 'Load model'))
    .toBe(true);
  await expect(
    dialog.getByText('Writing Assistant is loaded and available', {
      exact: true,
    }),
  ).toHaveCount(0);
  const saved = fixture.writes.find(
    (write) => write.path === '/api/model-setups',
  )?.body;
  expect(saved).toMatchObject({
    runtime_assignment: 'automatic',
    allow_eviction: true,
    idle_timeout: 300,
    identifier_mode: 'generated',
  });
  fixture.registry.jobs = fixture.registry.jobs.map((job) =>
    job.name === 'Load model' ? { ...job, state: 'SUCCEEDED' } : job,
  );
  await expect(
    dialog.getByText('Writing Assistant is loaded and available', {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    fixture.writes.some((write) => write.path.includes('completions')),
  ).toBe(false);
});

test('empty-library acquisition detour retains setup intent', async ({
  page,
  fixture,
}) => {
  fixture.registry.models = [];
  await page.goto('/#/deployments');
  await page.getByRole('button', { name: 'Set up model', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Add your first model' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Discover models', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Return to setup', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Add your first model' }),
  ).toBeVisible();
});
