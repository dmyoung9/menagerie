import { test, expect } from './fixtures';

test('first response works without GPU telemetry and recovers from a gateway error', async ({
  page,
  fixture,
}) => {
  fixture.host.gpus = [];
  fixture.host.ram_available_mib = null;
  let failed = false;
  await page.route('**/v1/chat/completions', (route) => {
    const body: unknown = route.request().postDataJSON();
    expect(body).toMatchObject({
      model: 'ready',
      stream: true,
      max_tokens: 128,
    });
    return failed
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { message: 'Runtime ran out of memory' },
          }),
        })
      : route.fulfill({
          contentType: 'text/event-stream',
          body: 'data: {"choices":[{"delta":{"content":"Hello friend"}}]}\n\ndata: [DONE]\n\n',
        });
  });
  await page.goto('/');
  await page.getByText('Get your first response', { exact: true }).click();
  await expect(
    page.getByText('GPU telemetry unavailable. A CPU engine', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Send test prompt' }).click();
  await expect(page.getByLabel('Test response')).toHaveText('Hello friend');
  failed = true;
  await page.getByRole('button', { name: 'Send test prompt' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Runtime ran out of memory' }),
  ).toBeVisible();
  failed = false;
  await page.getByRole('button', { name: 'Send test prompt' }).click();
  await expect(page.getByLabel('Test response')).toHaveText('Hello friend');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('empty installation keeps an existing-model route and disables requests before readiness', async ({
  page,
  fixture,
}) => {
  fixture.registry.models = [];
  fixture.registry.runtimes = [];
  fixture.registry.deployments = [];
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Choose starter variant' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Send test prompt' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('link', { name: 'Use an existing model / Add from File' }),
  ).toHaveAttribute('href', '#/models');
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
