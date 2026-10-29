import { test, expect } from './fixtures';

test('overview puts deployments before summary tiles without a first-response tour', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Deployments', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Get your first response', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Send test prompt' }),
  ).toHaveCount(0);
  expect(
    await page.locator('main').evaluate((main) => {
      const heading = [...main.querySelectorAll('h2')].find(
        (node) => node.textContent === 'Deployments',
      );
      const stats = main.querySelector('.stats');
      return Boolean(
        heading &&
        stats &&
        heading.compareDocumentPosition(stats) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
  ).toBe(true);
});

test('empty installation retains discover and local-model actions', async ({
  page,
  fixture,
}) => {
  fixture.registry.models = [];
  fixture.registry.runtimes = [];
  fixture.registry.deployments = [];
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Discover models', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add from File', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Get your first response', { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Discover models', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/models\/discover$/);
});

test('unloading another deployment still requires consent', async ({
  page,
}) => {
  await page.route('**/api/**/idle/validate', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        errors: [],
        warnings: ['Low confidence'],
        estimates: { idle: { reservation_mib: 6800, confidence: 'low' } },
        stops: ['ready'],
        plan_token: 'review-token',
      }),
    }),
  );
  await page.goto('/#/deployments/idle');
  await page.getByRole('button', { name: 'Load now', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('button', { name: 'Load', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Approve these unloads' }).check();
  await expect(
    dialog.getByRole('button', { name: 'Load', exact: true }),
  ).toBeEnabled();
});
