import { test, expect, openCard, openIdentity } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

const conflictText = 'This configuration changed elsewhere';

test("revision conflict merges fresh server fields with the user's edits and re-saves cleanly", async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments/idle/configuration');
  await openIdentity(page);
  await page.getByLabel('Display name', { exact: true }).fill('Merged name');
  fixture.conflictSave = true;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(conflictText, { exact: false })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review changes', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Review changes', exact: true })
    .click();
  await expect(page.getByText(conflictText, { exact: false })).toBeHidden();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(3);
  const written = deploymentDraft(
    fixture.writes.find((w) => w.path === '/api/deployments?expected=2')?.body,
  );
  expect(written.name).toBe('Merged name');
  expect(written.idle_timeout).toBe(600);
  expect(
    fixture.registry.deployments.find((d) => d.id === 'idle'),
  ).toMatchObject({
    name: 'Merged name',
    idle_timeout: 600,
    revision: 3,
  });
});

test('conflict review preserves an in-progress numeric buffer the fresh value did not change', async ({
  page,
  fixture,
}) => {
  fixture.registry.runtimes[0].capabilities!.schema!['top-k'] = {
    type: 'integer',
    min: 0,
    max: 100,
    label: 'Top-k',
  };
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.config['top-k'] = 0;
  await page.goto('/#/deployments/idle/configuration');
  await openCard(page, 'generation');
  const input = page.getByLabel('Top-k', { exact: true });
  await input.fill('40');
  fixture.conflictSave = true;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(conflictText, { exact: false })).toBeVisible();
  await page
    .getByRole('button', { name: 'Review changes', exact: true })
    .click();
  await expect(page.getByText(conflictText, { exact: false })).toBeHidden();
  await expect(input).toHaveValue('40');
});
