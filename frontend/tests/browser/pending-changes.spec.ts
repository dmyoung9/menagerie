import { test, expect, openCard } from './fixtures';

for (const activity of ['unloaded', 'idle', 'busy'] as const) {
  test(`editor application actions follow the whole pool when ${activity}`, async ({
    page,
    fixture,
  }) => {
    if (activity === 'unloaded')
      fixture.registry.deployments.forEach((row) => {
        row.state = 'STOPPED';
      });
    fixture.sets[0].inflight = activity === 'busy' ? 2 : 0;
    await page.goto('/#/deployments/idle/configuration');
    const label =
      activity === 'unloaded'
        ? 'Apply'
        : activity === 'idle'
          ? 'Apply and Reload'
          : 'Apply and Reload when Idle';
    await expect(
      page.getByRole('button', { name: label, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Apply and Reload Now', exact: true }),
    ).toHaveCount(activity === 'busy' ? 1 : 0);
    expect(
      fixture.writes.filter((write) =>
        write.path.startsWith('/api/model-setups'),
      ),
    ).toEqual([]);
  });
}

test('pending changes require fresh review, show unload scope, and can be cancelled', async ({
  page,
}) => {
  let state = 'pending';
  const applications: unknown[] = [];
  await page.route('**/api/deployments/ready/pending', (route) =>
    route.fulfill({
      json: {
        pending: true,
        loaded: true,
        inflight: 2,
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
    .getByRole('button', { name: 'Apply and Reload when Idle', exact: true })
    .click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toContainText('Alpha, Beta');
  await expect(confirmation).toContainText('Also unload: Other runtime');
  await expect(confirmation).toContainText('Cached context will be lost');
  expect(applications).toEqual([]);
  await confirmation
    .getByRole('button', { name: 'Apply and Reload when Idle', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Cancel scheduled reload' }),
  ).toBeVisible();
  expect(applications).toEqual([
    {
      token: 'fresh-reviewed-token',
      scope_fingerprint: 'exact-scope',
      mode: 'idle',
      confirm_interrupt: false,
    },
  ]);
  await page.getByRole('button', { name: 'Cancel scheduled reload' }).click();
  await expect(
    page.getByRole('button', {
      name: 'Apply and Reload when Idle',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Configuration not applied', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Apply and Reload Now', exact: true })
    .click();
  await expect(confirmation).toContainText('Interrupt active requests now');
  expect(applications).toHaveLength(1);
  await confirmation
    .getByRole('button', { name: 'Apply and Reload Now', exact: true })
    .click();
  await expect.poll(() => applications.length).toBe(2);
  expect(applications[1]).toMatchObject({
    mode: 'now',
    confirm_interrupt: true,
  });
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
  await page.getByRole('button', { name: /^Apply(?: and Reload)?$/ }).click();
  await expect
    .poll(
      () =>
        fixture.registry.deployments.find((row) => row.id === 'idle')
          ?.profile_snapshot?.config.mmproj,
    )
    .toBe('/synthetic/unclassified.bin');
});
