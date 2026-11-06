import { test, expect, openAdvanced, openIdentity } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

test('advanced memory controls are quiet by default, explain themselves and preserve omitted options', async ({
  page,
  fixture,
}) => {
  const schema = fixture.registry.runtimes[0].capabilities!.schema!;
  schema['fit-target'] = {
    type: 'string',
    label: 'Free device memory target',
    description: 'MiB to leave free for other workloads.',
  };
  schema['split-mode'] = {
    type: 'enum',
    choices: ['none', 'layer'],
    label: 'Device split mode',
    description: 'How to distribute work across multiple GPUs.',
  };
  await page.goto('/#/deployments/idle/configuration');
  await expect(
    page.getByLabel('Free device memory target', { exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole('combobox', { name: 'Device split mode', exact: true }),
  ).toBeHidden();
  await page
    .getByText('Advanced memory and placement', { exact: true })
    .click();
  await openIdentity(page);
  await expect(
    page.getByText('MiB to leave free for other workloads.'),
  ).toBeVisible();
  await expect(
    page.getByText('How to distribute work across multiple GPUs.'),
  ).toBeVisible();
  await page
    .getByText('Advanced memory and placement', { exact: true })
    .click();
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Unchanged defaults');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = deploymentDraft(
    fixture.writes.find((write) => write.path.startsWith('/api/deployments?'))!
      .body,
  );
  expect(saved.configuration!.config['fit-target']).toBeUndefined();
  expect(saved.configuration!.config['split-mode']).toBeUndefined();
  expect(saved.configuration!.config['gpu-layers']).toBe('all');
});

test('performance explains engine defaults and its Add action', async ({
  page,
}) => {
  await page.goto('/#/deployments/idle/configuration');
  const card = page.locator('[data-settings-section="performance"]');
  await openAdvanced(page);
  await expect(
    card.getByRole('heading', { name: 'Using engine defaults' }),
  ).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Add performance flags' }),
  ).toBeEnabled();
  await card.getByRole('button', { name: 'Add performance flags' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Add performance flags' }),
  ).toBeVisible();
});

test('performance explains why Add is unavailable without an engine', async ({
  page,
  fixture,
}) => {
  fixture.registry.runtimes = [];
  await page.goto('/#/deployments');
  await page
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Add model', exact: true }).click();
  const card = dialog.locator('[data-settings-section="performance"]');
  await openAdvanced(page);
  await expect(
    card.getByText(
      'Choose an engine to see its supported performance options.',
    ),
  ).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Add performance flags' }),
  ).toBeDisabled();
});

test('interrupting requests requires an explicit unload action', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments');
  const row = page.getByRole('row').filter({ hasText: 'Example ready' });
  await row.getByRole('button', { name: 'Unload', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Active requests finish first');
  await dialog
    .getByRole('button', { name: 'Cancel requests and unload', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    fixture.writes.find((write) => write.path.endsWith('/ready/stop'))!.body,
  ).toEqual({ cancel_requests: true });
});
