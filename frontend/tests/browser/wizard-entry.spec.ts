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

const pageHead = (page: Page) => page.locator('.page-head');
const dialogOf = (page: Page) => page.getByRole('dialog');

// The deployments page head now offers two page-level actions that replace
// the old single "Add model": "New pool" (PoolWizard) and "New deployment"
// (model -> existing pool). There is no inline pool creation in the model wizard.
test('Page head offers New pool and New deployment; New deployment opens the setup wizard', async ({
  page,
}) => {
  await page.goto('/#/deployments');
  await expect(
    pageHead(page).getByRole('button', { name: 'New pool', exact: true }),
  ).toBeVisible();
  await expect(
    pageHead(page).getByRole('button', { name: 'New deployment', exact: true }),
  ).toBeVisible();
  await expect(
    pageHead(page).getByRole('button', { name: 'Add model', exact: true }),
  ).toHaveCount(0);

  await pageHead(page)
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  // The wizard title is "New deployment"; the old "Set up model" heading is gone.
  await expect(
    dialog.getByText('New deployment', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText('Set up model', { exact: true })).toHaveCount(
    0,
  );
  // Three steps, unchanged labels.
  const steps = dialog.locator('.steps li');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText('Choose model');
  await expect(steps.nth(1)).toContainText('Review setup');
  await expect(steps.nth(2)).toContainText('Make available');
  // Step 0 shows a Model select; the engine is inherited from the pool, so
  // there is no Engine select in the model wizard.
  await expect(dialog.getByLabel('Model', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Engine', { exact: true })).toHaveCount(0);
});

test('New pool opens a pool wizard that lists the pool-ready engine', async ({
  page,
}) => {
  await page.goto('/#/deployments');
  await pageHead(page)
    .getByRole('button', { name: 'New pool', exact: true })
    .click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('New pool', { exact: true })).toBeVisible();
  // With the fixture runtime advertising models-preset, the engine dropdown
  // is populated instead of "No pool-ready engines". Selecting the offered
  // engine both verifies it is present and exercises the dropdown.
  await expect(dialog.getByLabel('Shared installed engine')).toBeVisible();
  await expect(dialog.getByText('No pool-ready engines')).toHaveCount(0);
  await dialog
    .getByLabel('Shared installed engine')
    .selectOption({ label: 'Example engine' });
  await expect(
    dialog.getByRole('button', { name: 'Create pool', exact: true }),
  ).toBeVisible();
});

test('The model wizard joins an existing pool instead of creating one inline', async ({
  page,
}) => {
  await page.goto('/#/deployments');
  await pageHead(page)
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  // Step 0 (Choose model) is pre-filled; advance to Review setup.
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Pool', { exact: true })).toBeVisible();
  // No inline pool fields: the old "Pool name" / "Serving port" fields are
  // gone; the wizard joins an existing pool instead.
  await expect(dialog.getByLabel('Pool name', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Serving port', { exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.getByText('New pool…', { exact: true })).toHaveCount(0);
  // Selecting the existing pool verifies it is offered (selectOption throws
  // if the option is absent) and advances the flow.
  await dialog.getByLabel('Pool', { exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await dialog.getByLabel('Name', { exact: true }).fill('Joining Member');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    dialog.getByRole('button', {
      name: 'Make available and load',
      exact: true,
    }),
  ).toBeVisible();
});

test('default setup saves a joined member, inherits pool policy, and waits for the load job', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments');
  await pageHead(page)
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const dialog = dialogOf(page);
  // Step 0 -> Review setup (model is pre-filled).
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Writing Assistant');
  await dialog
    .getByLabel('Pool', { exact: true })
    .selectOption({ label: 'Join pool: Example pool' });
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  // Step 2 (Make available): save + launch review + load.
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
  const saved = fixture.writes.find((write) => {
    return write.path.startsWith('/api/model-setups');
  })?.body;
  expect(saved).toMatchObject({
    pool_id: 'pool',
    runtime_id: 'engine',
    gpu: 0,
    port: null,
    name: 'Writing Assistant',
    artifact_id: 'model',
    identifier_mode: 'generated',
    runtime_assignment: 'automatic',
    // Policy inherited from the joined "Example pool".
    residency: 'on-demand',
    priority: 50,
    idle_timeout: 300,
    allow_eviction: false,
    queue_timeout: 300,
    enabled: true,
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
  await pageHead(page)
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
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
