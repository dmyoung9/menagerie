import { test, expect } from './fixtures';
import { deploymentDraft, deploymentSetDraft } from '../../src/contracts';

test('new deployments leave tuning and device placement to the engine', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments');
  await page.locator('.page-head').getByRole('button', { name: 'Add model', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Model', { exact: true }).selectOption('model');
  await dialog.getByLabel('Engine', { exact: true }).selectOption('engine');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Automatic');
  await dialog.getByLabel('Pool name', { exact: true }).fill('Automatic pool');
  await dialog.getByLabel('Serving port', { exact: true }).fill('8123');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog
    .getByRole('button', {
      name: 'Make available without loading',
      exact: true,
    })
    .click();
  await expect(
    dialog.getByText('Automatic is available', { exact: true }),
  ).toBeVisible();
  const saved = deploymentDraft(
    fixture.writes.find((w) => w.path === '/api/model-setups')!.body,
  );
  expect(saved.gpu).toBeNull();
  expect(saved.config).toEqual({});
});

test('a native pool remains a pool even with one model and round-trips its policy', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments');
  await page.locator('.page-head').getByRole('button', { name: 'Add model', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Model', { exact: true }).selectOption('model');
  await dialog.getByLabel('Engine', { exact: true }).selectOption('engine');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Native pool');
  await dialog
    .getByLabel('Placement', { exact: true })
    .selectOption({ label: 'New pool…' });
  await dialog.getByLabel('Pool name', { exact: true }).fill('Native pool');
  await dialog.getByLabel('Serving port', { exact: true }).fill('8125');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog
    .getByRole('button', {
      name: 'Make available without loading',
      exact: true,
    })
    .click();
  await expect(
    dialog.getByText('Native pool is available', { exact: true }),
  ).toBeVisible();
  const pool = fixture.sets.find((g) => g.name === 'Native pool')!;
  expect(pool).not.toBeNull();
  expect(pool.multi_model).toBe(true);
  expect(pool.members).toHaveLength(1);
  expect(pool.members[0].port).toBeNull();
  expect(pool.members[0].config).toEqual({});
  expect(pool.enabled).toBe(true);
  expect(pool.runtime_id).toBe('engine');
});

test('native pool device visibility is edited once and saved for all members', async ({
  page,
  fixture,
}) => {
  // Seed a two-model runtime pool, as the detail-page editor edits it: the
  // pool owns engine, device, port and policy; members mirror it with no
  // member ports.
  const member = (id: string) => ({
    id,
    name: `Example ${id}`,
    alias: id,
    artifact_id: 'model',
    runtime_id: 'engine',
    config: {},
    raw_args: [],
    catalog: {},
    enabled: true,
    state: 'STOPPED',
    revision: 1,
    port: null,
    gpu: null,
    residency: 'on-demand',
    priority: 50,
    idle_timeout: 300,
    queue_timeout: 300,
    allow_eviction: false,
    lifecycle: { serving: false },
    profile_snapshot: {
      artifact_id: 'model',
      runtime_id: 'engine',
      config: {},
      raw_args: [],
      catalog: {},
    },
  });
  fixture.registry.deployments.push(member('shared-a'), member('shared-b'));
  fixture.sets.push({
    id: 'shared',
    name: 'Shared pool',
    engine_pool: true,
    runtime_id: 'engine',
    gpu: null,
    port: 8200,
    max_loaded: 4,
    residency: 'on-demand',
    priority: 50,
    idle_timeout: 300,
    allow_eviction: false,
    queue_timeout: 300,
    enabled: true,
    state: 'STOPPED',
    revision: 1,
    multi_model: true,
    member_ids: ['shared-a', 'shared-b'],
    members: [member('shared-a'), member('shared-b')],
    lifecycle: { serving: false },
  });
  await page.goto('/#/deployments/shared');
  await expect(
    page.getByRole('heading', { name: 'Shared pool', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Configuration', exact: true })
    .click();
  await expect(page.getByLabel('GPU', { exact: true })).toBeVisible();
  // One shared device edit; no per-member device controls exist in a pool.
  await expect(page.getByLabel('GPU', { exact: true })).toHaveCount(1);
  await page.getByLabel('GPU', { exact: true }).selectOption('0');
  await page
    .getByRole('button', { name: 'Save pool', exact: true })
    .click();
  await expect
    .poll(() =>
      fixture.writes.find((entry) =>
        entry.path.startsWith('/api/deployment-sets'),
      ),
    )
    .toBeDefined();
  const saved = deploymentSetDraft(
    fixture.writes.find((entry) =>
      entry.path.startsWith('/api/deployment-sets'),
    )!.body,
  );
  expect(saved.engine_pool).toBe(true);
  expect(saved.members.map((m) => m.gpu)).toEqual([0, 0]);
  expect(saved.members.map((m) => m.port)).toEqual([null, null]);
  expect(new Set(saved.members.map((m) => m.alias)).size).toBe(2);
  expect(new Set(saved.members.map((m) => m.runtime_id)).size).toBe(1);
});
