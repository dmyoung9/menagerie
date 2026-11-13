import { test, expect, openCard } from './fixtures';

test('pending changes require fresh review, show unload scope, and can be cancelled', async ({
  page,
}) => {
  let state = 'pending';
  const applications: unknown[] = [];
  await page.route('**/api/deployments/ready/pending', (route) =>
    route.fulfill({
      json: {
        pending: true,
        affected: ['Alpha', 'Beta'],
        op: { state, error: null },
      },
    }),
  );
  await page.route('**/api/deployments/ready/review-apply', (route) =>
    route.fulfill({
      json: {
        plan_token: 'fresh-reviewed-token',
        scope_fingerprint: 'exact-scope',
        affected: ['Alpha', 'Beta'],
        stop_names: ['Other runtime'],
        errors: [],
      },
    }),
  );
  await page.route('**/api/deployments/ready/request-apply', (route) => {
    applications.push(route.request().postDataJSON());
    state = 'queued';
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/deployments/ready/cancel', (route) => {
    expect(route.request().method()).toBe('POST');
    state = 'cancelled';
    return route.fulfill({ json: {} });
  });
  await page.goto('/#/deployments/ready/configuration');
  await page
    .getByRole('button', { name: 'Review restart', exact: true })
    .click();
  await expect(page.getByText('Restart affects: Alpha, Beta')).toBeVisible();
  await expect(
    page.getByText('Will also unload: Other runtime. KV caches will be lost.'),
  ).toBeVisible();
  expect(applications).toEqual([]);
  await page
    .getByRole('button', { name: 'Apply when idle', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Cancel scheduled apply' }),
  ).toBeVisible();
  expect(applications).toEqual([
    { token: 'fresh-reviewed-token', scope_fingerprint: 'exact-scope' },
  ]);
  await page.getByRole('button', { name: 'Cancel scheduled apply' }).click();
  await expect(
    page.getByRole('button', { name: 'Review restart' }),
  ).toBeVisible();
  await expect(
    page.getByText('Changes pending', { exact: true }),
  ).toBeVisible();
});

test('unclassified downloaded companions are selectable without losing the editor draft', async ({
  page,
  fixture,
}) => {
  fixture.registry.runtimes[0].capabilities!.schema!.mmproj = {
    type: 'string',
  };
  await page.route('**/api/registry/downloaded_files', (route) =>
    route.fulfill({
      json: [
        {
          id: 'other-file',
          name: 'unclassified.bin',
          repo: 'example/weights',
          source_revision: 'a'.repeat(40),
          status: 'downloaded',
          local_path: '/synthetic/unclassified.bin',
        },
      ],
    }),
  );
  await page.goto('/#/deployments/idle/configuration');
  await openCard(page, 'model');
  await page
    .getByRole('button', { name: 'Choose another file', exact: true })
    .click();
  await page
    .getByRole('button', { name: /example\/weights\/unclassified.bin/ })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Projector', { exact: true })).toHaveValue(
    '/synthetic/unclassified.bin',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () =>
        fixture.registry.deployments.find((row) => row.id === 'idle')
          ?.profile_snapshot?.config.mmproj,
    )
    .toBe('/synthetic/unclassified.bin');
});
