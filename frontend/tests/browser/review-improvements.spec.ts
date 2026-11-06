import { test, expect, openIdentity } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

test('configuration is inline, guards navigation and saves with the expected revision', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments/idle/configuration');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Edit', exact: true }),
  ).toHaveCount(0);
  const name = page.getByLabel('Display name', { exact: true });
  await openIdentity(page);
  await name.fill('Changed name');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Discard unsaved changes?');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(name).toHaveValue('Changed name');
  await expect(page).toHaveURL(/\/configuration$/);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() =>
      fixture.writes.some((w) => w.path === '/api/deployments?expected=1'),
    )
    .toBe(true);
  await expect(
    page.getByRole('heading', { name: 'Changed name', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(confirm).toBeHidden();
});

test('requests are scoped to deployment; missing VRAM is N/A when unloaded', async ({
  page,
}) => {
  await page.route('**/api/history/requests?deployment_id=idle', (route) =>
    route.fulfill({
      json: [
        {
          id: 'request',
          ts: 1,
          deployment_id: 'idle',
          data: {
            model_alias: 'idle',
            latency: 1.2,
            ttft: 0.1,
            output_tokens: 20,
          },
        },
      ],
    }),
  );
  await page.goto('/#/deployments/idle');
  await expect(page.getByText('N/A', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Performance', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  await expect(
    page.getByRole('cell', { name: '20', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'idle', exact: true }),
  ).toHaveAttribute('href', '#/deployments/idle');
});

test('installed variants show installed chips, file details and accessible capability icons', async ({
  page,
  fixture,
}) => {
  fixture.registry.models = [0, 1].map((i) => ({
    ...fixture.registry.models[0],
    id: `model-${i}`,
    name: `Example-${i ? 'Q8_0' : 'Q4_K_M'}.gguf`,
    repo: 'example/model',
    quantization: i ? 'Q8_0' : 'Q4_K_M',
  }));
  await page.goto('/#/models/installed');
  await page
    .getByRole('button', { name: 'Details', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('region', { name: 'Installed model files' }),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole('group', { name: 'Installed quant', exact: true })
      .getByRole('button', { name: 'Q8_0', exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole('group', { name: 'Installed quant', exact: true })
    .getByRole('button', { name: 'Q8_0', exact: true })
    .click();
  await expect(
    dialog
      .getByRole('group', { name: 'Installed quant', exact: true })
      .getByRole('button', { name: 'Q8_0', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    dialog
      .getByLabel('Detected capabilities')
      .getByLabel('tools', { exact: true }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('settings expose policy directly and move sample data out of overview', async ({
  page,
}) => {
  await page.goto('/#/overview');
  await expect(
    page.locator('summary').filter({ hasText: /^(Samples|Hardware)$/ }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'View sample table' }).first().click();
  await expect(
    page.getByRole('region', { name: 'Telemetry samples', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Host', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save policy', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Edit policy', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Prometheus metrics' }),
  ).toHaveCount(0);
});

test('events consolidate jobs and expandable lifecycle steps with resource links', async ({
  page,
  fixture,
}) => {
  fixture.registry.jobs = [
    {
      id: 'operation',
      revision: 1,
      created_at: 1,
      name: 'Load Example idle',
      state: 'SUCCEEDED',
      deployment_id: 'idle',
    },
  ];
  await page.route('**/api/events/stream', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: [
        {
          seq: 1,
          ts: 1,
          kind: 'state',
          deployment_id: 'idle',
          data: {
            operation_id: 'operation',
            to: 'STARTING',
            session_id: 'run',
          },
        },
        {
          seq: 2,
          ts: 2,
          kind: 'state',
          deployment_id: 'idle',
          data: { operation_id: 'operation', to: 'READY', session_id: 'run' },
        },
        {
          seq: 3,
          ts: 3,
          kind: 'job',
          deployment_id: 'idle',
          data: {
            id: 'operation',
            operation_id: 'operation',
            name: 'Load Example idle',
            state: 'SUCCEEDED',
          },
        },
      ]
        .map((e) => `event: operation\ndata: ${JSON.stringify(e)}\n\n`)
        .join(''),
    }),
  );
  await page.goto('/#/activity/operations');
  await expect(page).toHaveURL(/\/activity\/events$/);
  await expect(
    page.getByRole('button', { name: 'Sessions', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Load Example idle', { exact: true }),
  ).toHaveCount(1);
  await page.getByText('3 steps', { exact: true }).click();
  await expect(
    page.getByText('Example idle is starting', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Logs', exact: true }).first(),
  ).toHaveAttribute('href', /#\/deployments\/idle\/logs\?member=idle&run=run/);
  await expect(
    page.getByRole('button', { name: 'Restore deployment' }),
  ).toHaveCount(0);
});
test('engine rows expose all source actions in the toolbar and downloads identify legacy results', async ({
  page,
  fixture,
}) => {
  await page.route('**/api/engines/releases', (route) =>
    route.fulfill({
      json: {
        engines: [
          {
            id: 'llama.cpp',
            name: 'llama.cpp',
            description: 'GGUF engine',
            releases: [
              {
                id: 'cuda-build',
                version: 'example',
                backend: 'cuda',
                requirements: 'NVIDIA driver',
              },
              {
                id: 'cpu-build',
                version: 'example',
                backend: 'cpu',
                requirements: 'CPU',
              },
            ],
          },
        ],
      },
    }),
  );
  await page.goto('/#/settings');
  await expect(page.locator('.engine-row')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Register existing engine', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Build from source', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Pull image', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Check for updates', exact: true }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
  fixture.registry.jobs = [
    {
      id: 'old-download',
      revision: 1,
      created_at: 1,
      state: 'SUCCEEDED',
      name: 'Download model',
      result: { id: 'model', name: 'example.gguf', repo: 'example/model' },
    },
  ];
  await page.goto('/#/models/downloads');
  await expect(
    page.getByText('Download example/model · example.gguf', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Model', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
