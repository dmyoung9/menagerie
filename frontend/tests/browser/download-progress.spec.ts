import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';

for (const width of [1440, 320]) {
  test(`Operations renders byte progress, unknown totals and errors at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    fixture.registry.jobs = [
      {
        id: 'legacy',
        revision: 1,
        name: 'Example legacy download',
        state: 'RUNNING',
        created_at: 1,
        progress: 'downloading bytes: 2,714,130,528 / 5887667808 B',
      },
      {
        id: 'known',
        revision: 1,
        name: 'Example measured download',
        state: 'RUNNING',
        created_at: 2,
        progress: 'Downloading',
        transfer: {
          done_bytes: 1073741824,
          total_bytes: 2147483648,
          rate_bytes_per_second: 10485760,
        },
      },
      {
        id: 'unknown',
        revision: 1,
        name: 'Example unknown download',
        state: 'RUNNING',
        created_at: 3,
        transfer: { done_bytes: 512, total_bytes: null },
      },
      {
        id: 'failed',
        revision: 1,
        name: 'Example failed download',
        state: 'FAILED',
        created_at: 4,
        error: 'Connection interrupted',
        transfer: { done_bytes: 50, total_bytes: 100 },
      },
      {
        id: 'verify',
        revision: 1,
        name: 'Example verifying download',
        state: 'RUNNING',
        created_at: 5,
        progress: 'Verifying SHA-256 and reading metadata',
      },
    ];
    await page.goto('/#/activity/operations');
    await expect(
      page.getByText('Downloading · 2.5 GiB / 5.5 GiB'),
    ).toBeVisible();
    await expect(page.getByText('46%', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('progressbar', {
        name: 'Download Example measured download',
      }),
    ).toHaveAttribute('aria-valuenow', '50');
    await expect(page.getByText('10.0 MiB/s · 1m 42s remaining')).toBeVisible();
    await expect(
      page.getByRole('progressbar', {
        name: 'Download Example unknown download',
      }),
    ).not.toHaveAttribute('aria-valuenow');
    await expect(page.getByText('Connection interrupted')).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveCount(3);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('download-progress.png'),
      fullPage: true,
    });
  });
}
