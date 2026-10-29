import { test, expect } from './fixtures';

// Preserve the split/single-variant behavior formerly checked against live
// upstream repositories. Both the supplier listing and download are fixtures.
for (const width of [1440, 390])
  for (const complete of [true, false])
    test(`split variant is ${complete ? 'downloadable' : 'blocked when incomplete'} at ${width}px`, async ({
      page,
      fixture,
    }) => {
      const revision = 'a'.repeat(40);
      const names = [
        'model-7B-BF16-00001-of-00002.gguf',
        'model-7B-BF16-00002-of-00002.gguf',
      ];
      await page.route('**/api/catalog/hf/files?*', (route) =>
        route.fulfill({
          json: {
            revision,
            files: names
              .slice(0, complete ? 2 : 1)
              .map((name) => ({ name, size: 1024 })),
          },
        }),
      );
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.goto('/#/models/discover');
      await page
        .getByRole('textbox', { name: 'Catalog search' })
        .fill('fixture');
      await page.getByRole('button', { name: 'Search catalog' }).click();
      await expect(
        page.getByLabel('Open fixture/model supplier page', { exact: true }),
      ).toHaveAttribute('href', 'https://huggingface.co/fixture/model');
      await page.getByRole('button', { name: 'Choose variant' }).click();
      const dialog = page.getByRole('dialog');
      await expect(
        dialog.getByRole('button', { name: 'BF16', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        dialog.getByRole('button', { name: 'Q4_K', exact: true }),
      ).toBeDisabled();
      await expect(
        dialog.getByText(`${complete ? 2 : 1} of 2 shards`, { exact: true }),
      ).toBeVisible();
      expect(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      const download = dialog.getByRole('button', {
        name: 'Download',
        exact: true,
      });
      if (complete) {
        await expect(
          dialog.getByText('2 files included', { exact: true }),
        ).toBeVisible();
        await expect(download).toBeEnabled();
        await download.click();
        await expect(dialog).toBeHidden();
        expect(
          fixture.writes.find((entry) => entry.path === '/api/downloads')?.body,
        ).toMatchObject({
          repo: 'fixture/model',
          revision,
          filename: names[0],
        });
      } else {
        await expect(download).toBeDisabled();
        await expect(
          dialog.getByText(
            'The supplier listing is missing shards. This variant cannot be downloaded.',
          ),
        ).toBeVisible();
        expect(
          fixture.writes.filter((entry) => entry.path === '/api/downloads'),
        ).toEqual([]);
      }
    });
