import { test, expect } from './fixtures';
import { deploymentDraft, deploymentSetDraft } from '../../src/contracts';

test('new deployments leave tuning and device placement to the engine', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments');
  await page
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Automatic');
  await dialog.getByRole('button', { name: 'Add model', exact: true }).click();
  await expect(dialog.getByLabel('GPU', { exact: true })).toHaveValue('');
  await dialog
    .getByRole('button', { name: 'Save deployment', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const saved = deploymentDraft(
    fixture.writes.find((w) => w.path === '/api/deployments')!.body,
  );
  expect(saved.gpu).toBeNull();
  expect(saved.configuration!.config).toEqual({});
});

test('a native pool remains a pool even with one model and round-trips its policy', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments');
  await page
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Native pool');
  await dialog.getByRole('button', { name: 'Add model', exact: true }).click();
  await dialog.getByLabel('Lifecycle owner').selectOption('runtime');
  await expect(
    dialog.getByRole('combobox', { name: 'Mode', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole('button', { name: 'Save deployment', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const saved = deploymentSetDraft(
    fixture.writes.find((w) => w.path === '/api/deployment-sets')!.body,
  );
  expect(saved.engine_pool).toBe(true);
  expect(saved.residency).toBe('on-demand');
  expect(saved.allow_eviction).toBe(false);
  expect(saved.members[0].configuration!.config).toEqual({});
});

test('native pool device visibility is edited once and saved for all members', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments');
  await page
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Shared pool');
  await dialog.getByRole('button', { name: 'Add model', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add model', exact: true }).click();
  await dialog.getByLabel('Lifecycle owner').selectOption('runtime');
  const gpu = dialog.getByLabel('GPU', { exact: true });
  await expect(gpu).toHaveCount(1);
  await gpu.selectOption('0');
  await expect(
    dialog
      .locator('[data-model-index="1"]')
      .getByRole('combobox', { name: 'Engine', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole('button', { name: 'Save deployment', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const saved = deploymentSetDraft(
    fixture.writes.find((entry) => entry.path === '/api/deployment-sets')!.body,
  );
  expect(saved.members.map((member) => member.gpu)).toEqual([0, 0]);
  expect(new Set(saved.members.map((member) => member.port)).size).toBe(2);
  expect(new Set(saved.members.map((member) => member.alias)).size).toBe(2);
  expect(
    new Set(saved.members.map((member) => member.configuration!.runtime_id))
      .size,
  ).toBe(1);
});
