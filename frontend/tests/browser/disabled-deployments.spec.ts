import { test, expect } from './fixtures';

for (const width of [1440, 320]) {
  test(`Enabled/Disabled pool tabs list members and preserve detail/back/reload at ${width}px`, async ({
    page,
    fixture,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/#/deployments');
    const pool = fixture.sets[0];
    // The pool is enabled; members live under "Enabled" even when an
    // individual member is disabled.
    await expect(
      page.getByRole('button', { name: 'Enabled (1)', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Disabled (0)', exact: true }),
    ).toBeVisible();
    // A disabled *member* stays in its enabled pool; it is flagged in the
    // member-table Availability column.
    const inactiveRow = page.getByRole('row').filter({
      has: page.getByRole('link', { name: 'Example inactive', exact: true }),
    });
    await expect(inactiveRow.getByRole('cell').nth(2)).toHaveText('Disabled');
    await expect(
      page
        .getByRole('row')
        .filter({
          has: page.getByRole('link', { name: 'Example ready', exact: true }),
        })
        .getByRole('cell')
        .nth(2),
    ).toHaveText('Loaded');

    // Detail, back and reload keep the member's row.
    await page
      .getByRole('link', { name: 'Example ready', exact: true })
      .click();
    await expect(page).toHaveURL(/#\/deployments\/ready$/);
    await expect(
      page.getByRole('heading', { name: 'Example ready', exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('link', { name: 'Example inactive', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('link', { name: 'Example inactive', exact: true }),
    ).toBeVisible();

    // Disabling the *pool* moves every member under "Disabled".
    pool.enabled = false;
    await page.reload();
    await page.goto('/#/deployments');
    await expect(
      page.getByRole('link', { name: 'Example inactive', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Enabled (0)', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Disabled (1)', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Disabled (1)', exact: true })
      .click();
    await expect(page).toHaveURL(/#\/deployments\/disabled$/);
    await expect(
      page.getByRole('link', { name: 'Example inactive', exact: true }),
    ).toBeVisible();

    await page.goto('/#/deployments/missing');
    await expect(
      page.getByText('Deployment not found', { exact: true }),
    ).toBeVisible();
  });
}
