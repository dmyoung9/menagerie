import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

const REPO = 'fixture/model';

function rows(page: Page) {
  return page.locator('tbody tr');
}

/** The visible group-name cell of a row (the column after the checkbox). */
function nameCell(page: Page, index: number) {
  return rows(page).nth(index).locator('td').nth(1);
}

/** Assert the table shows exactly these group names, in this order. */
async function expectRowNames(page: Page, expected: string[]) {
  for (const [i, name] of expected.entries())
    await expect(nameCell(page, i)).toContainText(name);
}

function selectAll(page: Page) {
  return page.getByRole('checkbox', { name: 'Select all visible files' });
}

function setHash(page: Page, hash: string) {
  page.evaluate((h: string) => {
    window.location.hash = h;
  }, hash);
}

const hashDev = `#/models/repo/${REPO}?revision=dev&returnTo=models/discover`;

test('renders the repository page, README card, and files table', async ({
  page,
  fixture,
}) => {
  await page.goto(
    `/#/models/repo/${REPO}?revision=main&returnTo=models/discover`,
  );
  await expect(page.getByRole('heading', { name: REPO })).toBeVisible();
  await expect(page.getByText('Revision main')).toBeVisible();
  await expect(rows(page)).toHaveCount(5);
  // All five groups are present; the first/last of the default file sort
  // are unambiguous across locales.
  await expect(nameCell(page, 0)).toContainText('config.json');
  await expect(nameCell(page, 4)).toContainText('tokenizer.model');
  await expect(page.locator('table')).toContainText('Model weights');
  await expect(page.locator('table')).toContainText('model-7B-Q4_K_M');
  await expect(page.locator('table')).toContainText(
    'model-7B.projector.safetensors',
  );
  // The initial POST must have carried the repo + revision and the token.
  expect(
    fixture.writes.find((w) => w.path === '/api/downloads/manifest')?.body,
  ).toMatchObject({ repo: REPO, revision: 'main' });

  // Every expected local status is present.
  const table = page.locator('table');
  await expect(table).toContainText('Downloaded');
  await expect(table).toContainText('Downloading');
  await expect(table).toContainText('Failed');
  await expect(table).toContainText('Not downloaded');
  await expect(table).toContainText('1/2 files');

  // The select-all checkbox renders with nothing selected (drawer closed).
  await expect(selectAll(page)).toBeVisible();
  await expect(selectAll(page)).not.toHaveAttribute('data-checked');

  // README drawer.
  await page.getByRole('button', { name: 'Open model card' }).click();
  await expect(
    page.getByRole('button', { name: 'Close model card' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Example Model', level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Usage', level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByText('A small fixture model used only by tests.'),
  ).toBeVisible();
  await expect(page.getByText('Run it with')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'View on Hugging Face' }),
  ).toHaveAttribute('href', 'https://huggingface.co/fixture/model');

  // Back button honors returnTo.
  await page.getByRole('button', { name: 'Close model card' }).click();
  await expect(
    page.getByRole('button', { name: 'Close model card' }),
  ).toBeHidden();
  await expect(selectAll(page)).toBeVisible();
  await page.getByRole('button', { name: 'Back to models' }).click();
  await expect(page).toHaveURL(/#\/models\/discover$/);
});

test('selects files with an indeterminate select-all and downloads them', async ({
  page,
  fixture,
}) => {
  await page.goto(
    `/#/models/repo/${REPO}?revision=main&returnTo=models/discover`,
  );
  await expect(rows(page)).toHaveCount(5);

  // Initially nothing is selected; select-all is neither checked nor indeterminate.
  await expect(selectAll(page)).not.toHaveAttribute('data-checked');
  await expect(selectAll(page)).not.toHaveAttribute('data-indeterminate');
  await expect(page.getByText('No selection')).toBeVisible();

  // Select-all selects every visible group (6 required files in total).
  await selectAll(page).click();
  await expect(selectAll(page)).toHaveAttribute('data-checked');
  await expect(
    page.getByText('6 files selected \u00b7 12.0 GiB to download'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry failed files' }),
  ).toBeVisible();

  // Select-all again deselects the visible groups.
  await selectAll(page).click();
  await expect(selectAll(page)).not.toHaveAttribute('data-checked');
  await expect(selectAll(page)).not.toHaveAttribute('data-indeterminate');
  await expect(page.getByText('No selection')).toBeVisible();

  // One group selected -> indeterminate select-all.
  await page
    .getByRole('checkbox', {
      name: 'Select model-7B-Q4_K_M and all required files',
    })
    .click();
  await expect(selectAll(page)).not.toHaveAttribute('data-checked');
  await expect(selectAll(page)).toHaveAttribute('data-indeterminate');
  await expect(
    page.getByText('2 files selected \u00b7 4.0 GiB to download'),
  ).toBeVisible();

  // A partial selection makes select-all select everything.
  await selectAll(page).click();
  await expect(selectAll(page)).toHaveAttribute('data-checked');
  await expect(
    page.getByText('6 files selected \u00b7 12.0 GiB to download'),
  ).toBeVisible();
  await page
    .getByRole('checkbox', {
      name: 'Select Model weights and all required files',
    })
    .click();
  await page
    .getByRole('checkbox', { name: 'Select model-7B.projector.safetensors' })
    .click();
  await expect(selectAll(page)).not.toHaveAttribute('data-checked');
  await expect(selectAll(page)).toHaveAttribute('data-indeterminate');
  await expect(
    page.getByText('4 files selected \u00b7 4.0 GiB to download'),
  ).toBeVisible();

  // Download the selection.
  await page.getByRole('button', { name: 'Download selected' }).click();
  await expect(page.getByText('Download queued: ' + REPO)).toBeVisible();

  const write = fixture.writes.find((w) => w.path === '/api/downloads/files');
  const payload = write?.body as {
    repo: string;
    revision: string;
    selected: string[];
  };
  expect(payload).toMatchObject({
    repo: REPO,
    revision: 'main',
  });
  // `selected` order follows the (locale-dependent) table order, so compare
  // the group ids without regard to order.
  expect((payload?.selected ?? []).slice().sort()).toEqual([
    'config.json',
    'gguf-7B-Q4_K_M-2',
    'tokenizer.model',
  ]);
  expect(fixture.registry.jobs).toHaveLength(1);
  expect(fixture.registry.jobs[0]).toMatchObject({
    operation: 'download_files',
    repo: REPO,
    state: 'QUEUED',
  });
  expect(fixture.unexpected, 'Every API request must be intercepted').toEqual(
    [],
  );
});

test('sorts and filters the files table', async ({ page }) => {
  await page.goto(`/#/models/repo/${REPO}?revision=main`);
  await expect(rows(page)).toHaveCount(5);
  // No active filters: "Clear filters" is disabled.
  await expect(
    page.getByRole('button', { name: 'Clear filters' }),
  ).toBeDisabled();

  // Sort by local status (not downloaded, downloading, downloaded, failed).
  await page.getByRole('button', { name: 'Sort by Local status' }).click();
  await expect(page.locator('th:has-text("Local status")')).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await expectRowNames(page, [
    'model-7B-Q4_K_M',
    'tokenizer.model',
    'model-7B.projector.safetensors',
    'config.json',
    'Model weights',
  ]);

  // Sort by size, then flip to ascending.
  await page.getByRole('button', { name: 'Sort by Size' }).click();
  await expectRowNames(page, [
    'model-7B-Q4_K_M',
    'Model weights',
    'model-7B.projector.safetensors',
    'tokenizer.model',
    'config.json',
  ]);
  await page.getByRole('button', { name: 'Sort by Size' }).click();
  await expectRowNames(page, [
    'config.json',
    'tokenizer.model',
    'model-7B.projector.safetensors',
    'Model weights',
    'model-7B-Q4_K_M',
  ]);

  // Filter by local status: failed -> only the safetensors bundle.
  await page
    .getByRole('combobox', { name: 'Local status' })
    .selectOption({ label: 'Failed' });
  await expect(rows(page)).toHaveCount(1);
  await expectRowNames(page, ['Model weights']);
  await expect(page.getByText('1 of 5 rows')).toBeVisible();

  // Filter by not-downloaded: the two not-downloaded groups.
  await page
    .getByRole('combobox', { name: 'Local status' })
    .selectOption({ label: 'Not downloaded' });
  await expect(rows(page)).toHaveCount(2);
  await expectRowNames(page, ['tokenizer.model', 'model-7B-Q4_K_M']);

  // Search filters names and member files.
  await page
    .getByRole('combobox', { name: 'Local status' })
    .selectOption({ label: 'All' });
  await expect(rows(page)).toHaveCount(5);
  await page.getByLabel('Filter repository files').fill('config');
  await expect(rows(page)).toHaveCount(1);
  await expectRowNames(page, ['config.json']);
  await page.getByLabel('Filter repository files').fill('');
  await expect(rows(page)).toHaveCount(5);

  // File-type filter.
  await page.getByRole('combobox', { name: 'File type' }).selectOption({
    label: 'Configuration',
  });
  await expect(rows(page)).toHaveCount(1);
  await expectRowNames(page, ['config.json']);
  await expect(
    page.getByRole('button', { name: 'Clear filters' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows(page)).toHaveCount(5);
});

test('guards revision changes when a selection is in flight', async ({
  page,
}) => {
  await page.goto(
    `/#/models/repo/${REPO}?revision=main&returnTo=models/discover`,
  );
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByText('Revision main')).toBeVisible();

  // Make a selection against the main revision.
  await page
    .getByRole('checkbox', {
      name: 'Select model-7B-Q4_K_M and all required files',
    })
    .click();
  await expect(
    page.getByText('2 files selected \u00b7 4.0 GiB to download'),
  ).toBeVisible();

  // Navigating to a different revision prompts before applying.
  setHash(page, hashDev);
  await expect(
    page.getByText('Change revision?', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Your file selection belongs to main'),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Changing revision clears the selection; downloaded files are kept',
    ),
  ).toBeVisible();
  // The table still shows main-revision data (manifest not re-fetched yet).
  await expect(page.getByText('Revision main')).toBeVisible();

  // "Keep revision" returns to the selected revision without clearing it.
  await page.getByRole('button', { name: 'Keep revision' }).click();
  await expect(page).toHaveURL(/revision=main$/);
  await expect(
    page.getByText('2 files selected \u00b7 4.0 GiB to download'),
  ).toBeVisible();
  await expect(page.getByText('Revision main')).toBeVisible();

  // "Change revision" clears the selection and fetches the new revision.
  setHash(page, hashDev);
  await expect(
    page.getByText('Change revision?', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Change revision' }).click();
  await expect(
    page.getByText('Change revision?', { exact: true }),
  ).toBeHidden();
  await expect(page.getByText('No selection')).toBeVisible();
  await expect(page.getByText('Revision dev')).toBeVisible();
  await expect(
    page.getByText('2 files selected \u00b7 4.0 GiB to download'),
  ).toBeHidden();
});
