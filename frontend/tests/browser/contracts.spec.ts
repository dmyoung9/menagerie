import { test, expect } from './fixtures';
import * as contracts from '../../src/contracts';
import { recordValue } from '../../src/decode';

test('Discover renders public Hugging Face results with null SDK fields', async ({
  page,
}) => {
  await page.route(/\/api\/catalog\/hf\?q=/, (route) =>
    route.fulfill({
      json: [
        {
          id: 'fixture/public-model',
          gated: null,
          downloads: null,
          tags: null,
        },
      ],
    }),
  );
  await page.goto('/#/models/discover');
  await page.getByRole('textbox', { name: 'Catalog search' }).fill('qwen');
  await page.getByRole('button', { name: 'Search catalog' }).click();
  await expect(
    page.getByText('fixture/public-model', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('0 downloads', { exact: true })).toBeVisible();
  await expect(page.getByText('Gated', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Choose variant' }),
  ).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('malformed registry responses fail safely and retry restores the typed snapshot', async ({
  page,
}) => {
  await page.route('**/api/registry/models', (route) =>
    route.fulfill({ json: { not: 'an array' } }),
  );
  await page.goto('/#/models');
  await expect(page.getByRole('alert')).toContainText('Connection lost');
  await page.unroute('**/api/registry/models');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Example 27B', exact: false }),
  ).toBeVisible();
});

test('valid JSON with an invalid argument shape blocks saving; extensions survive a valid edit', async ({
  page,
  fixture,
}) => {
  const snapshot = fixture.registry.deployments[1].profile_snapshot;
  if (!snapshot) throw new Error('Expected fixture profile snapshot');
  snapshot.catalog = contracts.modelCatalog({
    vendor: { retain: true },
    model: { compatibility: { reasoningField: 'reasoning_content' } },
  });
  await page.goto('/#/deployments/idle');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Advanced model settings', { exact: true }).click();
  await dialog.getByText('Engine arguments', { exact: true }).click();
  const args = dialog.getByRole('textbox', {
    name: 'Engine arguments',
    exact: true,
  });
  await args.fill('{"not":"an array"}');
  await expect(args).toHaveAttribute('aria-invalid', 'true');
  await expect(
    dialog.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  expect(
    fixture.writes.filter((write) => write.path.startsWith('/api/deployments')),
  ).toEqual([]);
  await args.fill('["--fixture-control"]');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  const write = fixture.writes.find((entry) =>
    entry.path.startsWith('/api/deployments'),
  );
  const saved = contracts.deploymentDraft(write?.body);
  expect(saved.configuration?.raw_args).toEqual(['--fixture-control']);
  const catalog = recordValue(saved.configuration?.catalog);
  expect(catalog.vendor).toEqual({ retain: true });
  expect(recordValue(catalog.model).compatibility).toEqual({
    reasoningField: 'reasoning_content',
  });
});

test('multi-model groups render without a member alias or profile on the group itself', async ({
  page,
  fixture,
}) => {
  fixture.sets.push({
    id: 'group',
    revision: 1,
    name: 'Paired models',
    enabled: true,
    state: 'STOPPED',
    multi_model: true,
    member_ids: ['idle', 'inactive'],
    members: fixture.registry.deployments.slice(1),
    lifecycle: { serving: true },
  });
  await page.goto('/#/deployments/group');
  await expect(
    page.getByRole('heading', { name: 'Paired models', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Models', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByText('Example idle', { exact: true }).first(),
  ).toBeVisible();
});
