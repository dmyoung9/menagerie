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

test('Deployments entry reaches the single-model wizard', async ({ page }) => {
  await page.goto('/#/deployments');
  await page
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  await page.getByRole('button', { name: 'Single model', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Set up model', { exact: true })).toBeVisible();
  const steps = dialog.locator('.steps li');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText('Choose model');
  await expect(steps.nth(1)).toContainText('Review setup');
  await expect(steps.nth(2)).toContainText('Make available');
  await expect(dialog.getByLabel('Model', { exact: true })).toBeVisible();
});

test('Deployments entry offers multiple-model creation', async ({ page }) => {
  await page.goto('/#/deployments');
  await page
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Single model', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Multiple models', exact: true }),
  ).toBeVisible();
});
