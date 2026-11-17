import { test } from './fixtures';

test('dump deployments', async ({ page }) => {
  await page.goto('/#/deployments');
  await page.waitForTimeout(1500);
  console.log('DEPLOYMENTS>>>', await page.locator('main').innerText());
  await page.goto('/#/deployments/disabled');
  await page.waitForTimeout(1000);
  console.log('DISABLED>>>', await page.locator('main').innerText());
});
