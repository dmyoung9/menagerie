import { test, expect } from './fixtures';

for (const width of [1440, 320]) {
  test(`Disabled navigation lists deployments and preserves detail/back/reload at ${width}px`, async ({
    page,
    fixture,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const disabled = fixture.registry.deployments.find((d) => !d.enabled)!;
    Object.assign(disabled, {
      id: 'archived',
      alias: 'archived',
      name: 'Example archived',
    });
    await page.goto('/#/deployments');
    const tab = page.getByRole('button', { name: 'Disabled (1)', exact: true });
    const link = page.getByRole('link', {
      name: 'Example archived',
      exact: true,
    });
    await expect(link).toHaveCount(0);
    await tab.click();
    await expect(page).toHaveURL(/#\/deployments\/disabled$/);
    await expect(tab).toHaveAttribute('aria-pressed', 'true');
    await expect(link).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Example ready', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Example idle', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText('Deployment not found', { exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/#\/deployments\/archived$/);
    await expect(
      page.getByRole('heading', { name: 'Example archived', exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(link).toBeVisible();
    await page
      .getByRole('button', { name: 'Enabled (2)', exact: true })
      .click();
    await expect(page).toHaveURL(/#\/deployments\/enabled$/);
    await expect(link).toHaveCount(0);
    await page.goBack();
    await expect(link).toBeVisible();
    await page.goForward();
    await expect(link).toHaveCount(0);
    await page.goto('/#/deployments/inactive');
    await expect(link).toBeVisible();
    await expect(tab).toHaveAttribute('aria-pressed', 'true');
    expect(fixture.writes).toEqual([]);
    await page.goto('/#/deployments/missing');
    await expect(
      page.getByText('Deployment not found', { exact: true }),
    ).toBeVisible();
  });
}
