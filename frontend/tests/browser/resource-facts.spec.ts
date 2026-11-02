import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';

test('resource preview pairs stacked capacity and allocation selection without policy copy', async ({
  page,
}, testInfo) => {
  await page.goto('/#/deployments');
  await page
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Add model', exact: true }).click();
  const preview = dialog.getByRole('complementary', {
    name: 'Deployment resource preview',
  });
  await expect(preview.getByRole('heading', { name: /GPU 0/ })).toBeVisible();
  await expect(preview.locator('.recharts-bar')).toHaveCount(4);
  await expect(preview.getByText('Budget', { exact: true })).toBeVisible();
  await expect(preview.getByText('Capacity', { exact: true })).toBeVisible();
  await preview.getByRole('application').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    preview.locator('.recharts-tooltip-wrapper').first(),
  ).toBeVisible();
  const weights = preview
    .locator('.resource-legend button')
    .filter({ hasText: 'Weights' });
  await weights.focus();
  await page.keyboard.press('Enter');
  await expect(weights).toHaveAttribute('aria-pressed', 'true');
  await expect(preview.getByRole('status')).toContainText('Weights');
  await expect(preview).not.toContainText('Advisory accounting only');
  await expect(preview).not.toContainText('No memory is reserved');
  await expect(preview).not.toContainText('Launch stops only');
  await page.screenshot({
    path: testInfo.outputPath('projected-capacity-pair.png'),
    fullPage: true,
  });
});

test('over-budget launch facts have no acknowledgment gate', async ({
  page,
}) => {
  await page.goto('/#/deployments/idle');
  await page.getByRole('button', { name: 'Load now', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('1.0 GiB over budget', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Load', exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('cell', { name: 'observed · 2 runs' }),
  ).toBeVisible();
});

test('process ownership, RAM residency and per-GPU telemetry stay explicit', async ({
  page,
  fixture,
}, testInfo) => {
  fixture.host.processes = [
    { pid: 101, name: 'fixture-engine', gpu_mib: 3072 },
    { pid: 202, name: 'external-worker', gpu_mib: null },
  ];
  fixture.host.deployments = {
    ready: {
      gpu_mib: 3072,
      gpu_by_device_mib: { '0': 3072, '1': 0 },
      rss_mib: 512,
      pids: [101],
    },
  };
  fixture.host.gpus.push({
    index: 1,
    name: 'Second fixture GPU',
    total_mib: 8192,
    used_mib: 1024,
    free_mib: 7168,
    utilization: 0,
  });
  await page.goto('/#/overview');
  await expect(
    page.getByRole('heading', { name: 'GPU processes', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'external-worker', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Process ownership').selectOption('menagerie');
  await expect(
    page.getByRole('cell', { name: 'external-worker', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('cell', { name: 'fixture-engine', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Filter GPU processes').fill('not-a-process');
  await expect(page.getByText('No matching processes.')).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'PID', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Telemetry GPU')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'GPU memory', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Telemetry time window').selectOption('5');
  await expect(
    page.getByRole('heading', { name: 'Decode throughput', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'GPU 0 · Fixture GPU', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'GPU 1 · Second fixture GPU',
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('resource-overview-desktop.png'),
    fullPage: true,
  });
});

test('history shows per-configuration measured counts, peaks and individual failed runs', async ({
  page,
  fixture,
}) => {
  const now = fixture.host.ts;
  await page.route('**/api/history/resources*', (route) =>
    route.fulfill({
      json: [
        {
          artifact_id: 'model',
          model_name: 'Fixture model',
          profile_hash: 'abcdef0123456789',
          run_count: 2,
          first_run_at: now - 3600,
          last_run_at: now,
          configuration: { 'ctx-size': 8192, parallel: 1 },
          runtime_name: 'Fixture engine',
          gpu_index: 0,
          gpu: { sample_count: 2, mean_peak_mib: 2048, max_peak_mib: 3072 },
          ram: { sample_count: 1, mean_peak_mib: 512, max_peak_mib: 512 },
          runs: [
            {
              id: 'earlier-run',
              started_at: now - 3600,
              ended_at: now - 3500,
              outcome: 'stopped',
              peak_gpu_mib: 1024,
              peak_ram_mib: 512,
            },
            {
              id: 'run',
              started_at: now,
              ended_at: now + 1,
              outcome: 'failed',
              peak_gpu_mib: 3072,
              peak_ram_mib: null,
            },
          ],
        },
      ],
    }),
  );
  await page.goto('/#/deployments/ready');
  await expect(
    page.getByRole('heading', { name: 'Observed resource history' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Fixture model · Fixture engine · 8,192 tokens · 1 slot · 2 runs/,
    ),
  ).toBeVisible();
  await expect(page.getByText('Individual runs', { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('link', { name: 'View individual runs' }).last().click();
  await expect(
    page.getByRole('cell', { name: 'failed', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: '—', exact: true }).first(),
  ).toBeVisible();
});

test('resource views remain usable at 320px with reduced motion', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/overview');
  await expect(
    page.getByRole('heading', { name: 'Live resource trends' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('resource-overview-mobile.png'),
    fullPage: true,
  });
});
