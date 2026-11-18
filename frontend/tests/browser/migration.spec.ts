import AxeBuilder from '@axe-core/playwright';
import { test, expect, navigate, openIdentity } from './fixtures';
import * as contracts from '../../src/contracts';
import { recordValue } from '../../src/decode';

test('observed resources, SSE events, polling and exact preset stay integrated', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/overview');
  await expect(
    page.getByText('Unload Example idle', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: '—', exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.locator('[data-slot="chart"] svg path').count(),
  ).toBeGreaterThan(0);
  const tile = page.getByRole('link', { name: /^Example ready: 3.0 GiB/ });
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/deployments\/ready$/);
  await navigate(page, 'Overview');
  const tokens = await page.evaluate(() => ({
    primary: getComputedStyle(document.documentElement)
      .getPropertyValue('--primary')
      .trim(),
    font: getComputedStyle(document.body).fontFamily,
  }));
  expect(tokens.primary).toBe('oklch(0.432 0.095 166.913)');
  expect(tokens.font).toContain('Public Sans');
  fixture.registry.deployments.push({
    ...fixture.registry.deployments[1],
    id: 'polled',
    name: 'Polled deployment',
  });
  // The member table re-serves a new member only after a refetch, and the SPA
  // caches the registry slice — reload before expecting it to render.
  fixture.sets[0].member_ids.push('polled');
  await page.reload();
  await page.goto('/#/deployments');
  await expect(
    page.getByRole('link', { name: 'Polled deployment' }).first(),
  ).toBeVisible({ timeout: 8000 });
});

test('dialogs trap and restore focus; menus use keyboard navigation and fit the viewport', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/overview');
  const connect = page.getByRole('button', { name: 'Connect client' });
  await connect.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'OpenCode', exact: true }).click();
  await expect(
    dialog.getByText('menagerie plugin install', { exact: false }),
  ).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    await expect
      .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(connect).toBeFocused();
  await navigate(page, 'Deployments');
  const trigger = page.getByRole('button', {
    name: 'Actions for Example idle',
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu');
  await expect(
    menu.getByRole('menuitem', { name: 'Edit', exact: true }),
  ).toBeFocused();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/\/idle\/configuration$/);
  await openIdentity(page);
  await expect(page.getByLabel('Display name', { exact: true })).toBeVisible();
  await expect
    .poll(() => fixture.writes.some((w) => w.path === '/api/resources/preview'))
    .toBe(true);
  await navigate(page, 'Deployments');
  await page.getByRole('link', { name: 'Example idle', exact: true }).click();
  await page
    .getByRole('button', { name: 'Configuration', exact: true })
    .click();
  expect(page.url()).toContain('/idle/configuration');
  await page.goBack();
  await expect(
    page.getByRole('button', { name: 'Overview', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  // A slower runner can finish the editor's debounced read-only POST preview
  // before Escape. Navigation must not cause any persistent mutation.
  expect(
    fixture.writes.filter(
      (w) =>
        !['/api/resources/preview', '/api/capabilities/preview'].includes(
          w.path,
        ),
    ),
  ).toEqual([]);
});

test('unsaved editor dismissal is accessible and busy submissions cannot be dismissed', async ({
  page,
  fixture,
}) => {
  const opener = page
    .locator('.page-head')
    .getByRole('button', { name: 'New deployment', exact: true });
  await page.goto('/#/deployments');

  // No changes yet: Escape closes the wizard and returns focus to the trigger.
  await opener.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(opener).toBeFocused();

  // Editing makes dismissal ask to discard, and the guard is visible to beforeunload.
  await opener.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Unsaved deployment');
  // Joins the starter pool; the pool owns the runtime/device/port, so there are
  // no inline pool fields to fill in the wizard.
  await dialog
    .getByLabel('Pool', { exact: true })
    .selectOption({ label: 'Join pool: Example pool' });
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('alertdialog');
  await expect(
    confirm.getByRole('heading', { name: 'Discard unsaved changes?' }),
  ).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(
    'Unsaved deployment',
  );

  // A submission in flight locks the close button; the write still lands.
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  fixture.holdSave = true;
  await dialog
    .getByRole('button', {
      name: 'Make available without loading',
      exact: true,
    })
    .click();
  await expect
    .poll(() => fixture.writes.some((w) => w.path === '/api/model-setups'))
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Close dialog' }),
  ).toBeDisabled();
  fixture.releaseSave();
  await expect(
    dialog.getByText('Unsaved deployment is available', {
      exact: true,
    }),
  ).toBeVisible();
});

test('multi-model controls preserve payloads, failed input, invalid JSON and slider semantics', async ({
  page,
  fixture,
}) => {
  // Seed the pool the pair will share. The wizard joins it rather than
  // creating one inline; the pool owns the runtime, device and port.
  fixture.sets.push({
    id: 'buffered-pair',
    revision: 1,
    name: 'Buffered pair',
    engine_pool: true,
    runtime_id: 'engine',
    gpu: 0,
    port: 9120,
    max_loaded: 4,
    residency: 'on-demand',
    priority: 50,
    idle_timeout: 300,
    allow_eviction: false,
    queue_timeout: 300,
    enabled: true,
    state: 'STOPPED',
    multi_model: true,
    member_ids: [],
    members: [],
    lifecycle: { serving: false },
  });

  // First run: join the pool with the first member (context 32K, tools on).
  await page.goto('/#/deployments');
  await page
    .locator('.page-head')
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();

  await dialog.getByLabel('Name', { exact: true }).fill('Pair');
  // Context capacity: Custom → 32K preset (32768 tokens).
  await dialog
    .getByLabel('Context capacity', { exact: true })
    .selectOption('custom');
  await dialog.getByRole('button', { name: '32K', exact: true }).click();
  // Capabilities: Tools (carried in the member catalog).
  await dialog.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Tools', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');

  // "Continue" is disabled until the member is attached to a pool.
  await expect(
    dialog.getByRole('button', { name: 'Continue', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel('Pool', { exact: true })
    .selectOption({ label: 'Join pool: Buffered pair' });
  await expect(
    dialog.getByRole('button', { name: 'Continue', exact: true }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();

  // Failed input: alias collision keeps the form intact.
  fixture.failSave = true;
  await dialog
    .getByRole('button', {
      name: 'Make available without loading',
      exact: true,
    })
    .click();
  await expect(dialog.getByText('Alias already exists')).toBeVisible();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Pair');
  fixture.failSave = false;

  // Invalid JSON in the advanced options blocks "Continue"; valid JSON unblocks it.
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await dialog.getByText('Advanced', { exact: true }).click();
  await dialog
    .getByText('Additional engine arguments', { exact: true })
    .click();
  await dialog.getByLabel('Additional engine arguments').fill('{invalid');
  await expect(
    dialog.getByRole('button', { name: 'Continue', exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel('Additional engine arguments').fill('[]');
  await expect(
    dialog.getByRole('button', { name: 'Continue', exact: true }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog
    .getByRole('button', {
      name: 'Make available without loading',
      exact: true,
    })
    .click();
  await expect(
    dialog.getByText('Pair is available', { exact: true }),
  ).toBeVisible();
  await expect(fixture.sets).toHaveLength(2);
  let pool = fixture.sets.find((s) => s.id === 'buffered-pair')!;

  // Exit to the deployments list, then join the pool as the second member.
  await dialog
    .getByRole('button', { name: 'Open deployment', exact: true })
    .click();
  await navigate(page, 'Deployments');
  await page
    .locator('.page-head')
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const wizard = page.getByRole('dialog');
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();
  await wizard.getByLabel('Name', { exact: true }).fill('Second member');
  await expect(
    wizard.locator(`option[value="pool:${pool.id}"]`),
  ).toBeAttached();
  await wizard
    .getByLabel('Pool', { exact: true })
    .selectOption({ label: 'Join pool: Buffered pair' });
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();
  await wizard
    .getByRole('button', {
      name: 'Make available without loading',
      exact: true,
    })
    .click();
  await expect(
    wizard.getByText('Second member is available', { exact: true }),
  ).toBeVisible();

  // The join handler rebuilds fixture.sets (a fresh map), so the pool reference
  // captured before the join is stale — resolve it fresh before asserting.
  pool = fixture.sets.find((s) => s.id === 'buffered-pair')!;

  // The pool holds two pooled members: member 0 carries the reviewed context and
  // tools; every pooled member shares one engine/device and carries no port.
  await expect(pool.members).toHaveLength(2);
  expect(pool.id).toBe('buffered-pair');
  const [first, second] = pool.members;
  expect(first.unit_id).toBe(pool.id);
  expect(second.unit_id).toBe(pool.id);
  expect(first.config['ctx-size']).toBe(32768);
  expect(first.catalog.model?.capabilities?.tools).toBe(true);
  expect(second.name).toBe('Second member');
  expect(new Set(pool.members.map((m) => m.alias)).size).toBe(2);
  expect(pool.members.every((m) => m.port === null)).toBe(true);
});

test('launch warnings remain advisory and submit the plan token; local files use the original endpoint', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments/idle');
  await page
    .getByRole('button', { name: 'Review and load', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('button', { name: 'Load', exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(
    fixture.writes.find((w) => w.path.endsWith('/load-model'))!.body,
  ).toEqual({
    plan_token: 'review-token',
  });
  await navigate(page, 'Models');
  await page
    .getByRole('button', { name: 'Add from File', exact: true })
    .first()
    .click();
  await dialog.getByRole('textbox').fill('/models/fixture.gguf');
  await dialog
    .getByRole('button', { name: 'Add from File', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    recordValue(
      fixture.writes.find((w) => w.path === '/api/models/local')!.body,
    ).path,
  ).toBe('/models/fixture.gguf');
});

for (const width of [1440, 390])
  test(`catalog variant selection preserves pinning and explicit choice at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto('/#/models/discover');
    await page.getByRole('textbox', { name: 'Catalog search' }).fill('fixture');
    await page.getByRole('button', { name: 'Search catalog' }).click();
    await page.getByRole('button', { name: 'Choose variant' }).click();
    const dialog = page.getByRole('dialog');
    const download = dialog.getByRole('button', {
      name: 'Download',
      exact: true,
    });
    await expect(download).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Q5_K', exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: 'Q4_K', exact: true }).click();
    await expect(download).toBeEnabled();
    // The default button transitions opacity from 0.5 (disabled) to 1 when it
    // becomes enabled. While that transition is in flight, the button's
    // effective (composited-over-the-dialog) contrast dips well below 4.5:1,
    // so axe-core can report a spurious color-contrast violation. Wait until
    // the button is fully rendered before analyzing. (Locators cannot be
    // serialized as waitForFunction arguments, so the button is located in-page
    // by role + text.)
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      const download = Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent.trim() === 'Download',
      );
      if (!download) return false;
      return window.getComputedStyle(download).opacity === '1';
    });
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await expect(
      dialog.getByText('Pinned commit: fixture-commit'),
    ).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({
        id: v.id,
        targets: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('catalog-variant.png'),
      fullPage: true,
    });
    await download.click();
    await expect(dialog).toBeHidden();
    expect(
      fixture.writes.find((w) => w.path === '/api/downloads')!.body,
    ).toMatchObject({
      repo: 'fixture/model',
      revision: 'fixture-commit',
      filename: 'model-7B-Q4_K_M.gguf',
    });
    await expect(
      page
        .locator('.operation-notifications')
        .getByText(/Download fixture\/model/),
    ).toBeVisible();
  });

test('mobile action menus remain within the viewport and close on outside clicks', async ({
  page,
  fixture,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/deployments');
  const trigger = page.getByRole('button', {
    name: 'Actions for Example idle',
    exact: true,
  });
  await trigger.click();
  const menu = page.getByRole('menu');
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await page.mouse.click(1, 1);
  await expect(menu).toBeHidden();
});

test('engine-reset confirmation is cancellable and recovery retains its existing API', async ({
  page,
  fixture,
}) => {
  // The engine is a shared pool setting: it lives on the pool's Configuration
  // page, where it is editable (members render it as locked pool policy).
  fixture.registry.runtimes.push({
    ...fixture.registry.runtimes[0],
    id: 'engine-two',
    name: 'Second engine',
    // The pool's engine picker lists native llama.cpp runtimes that advertise
    // the models-preset flag; mark the second engine as such so it is offered.
    capabilities: {
      ...fixture.registry.runtimes[0].capabilities,
      flags: ['models-preset'],
    },
  });
  await page.goto('/#/deployments/pool/configuration');
  const engine = page.getByLabel('Shared installed engine', { exact: true });
  const confirm = page.getByRole('alertdialog');
  await engine.selectOption('engine-two');
  await expect(confirm).toContainText('Engine-specific options');
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(engine).toHaveValue('engine');
  await engine.selectOption('engine-two');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(engine).toHaveValue('engine');
  await engine.selectOption('engine-two');
  await confirm.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(engine).toHaveValue('engine-two');
  await page
    .getByRole('button', { name: 'Apply and Reload', exact: true })
    .click();
  await expect(
    fixture.writes.find((w) => w.path === '/api/deployment-sets?expected=1'),
  ).toBeDefined();
  expect(
    contracts.deploymentSetDraft(
      fixture.writes.find((w) => w.path === '/api/deployment-sets?expected=1')!
        .body,
    ).runtime_id,
  ).toBe('engine-two');
  await expect(confirm).toContainText('Cached context will be lost');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Cancelling reload preserves the draft; leaving still uses the route guard.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Settings', exact: true })
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Continue', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Recovery', exact: true }).click();
  await page
    .getByRole('button', { name: 'Create backup', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: 'Create backup', exact: true })
    .click();
  await expect(dialog.getByRole('status')).toContainText(
    '/fixtures/backup.sqlite',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Host', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save policy' })).toBeVisible();
});

test('empty installation and connection errors remain actionable', async ({
  page,
  fixture,
}) => {
  fixture.registry = {
    models: [],
    runtimes: [],
    deployments: [],
    jobs: [],
  };
  await page.goto('/#/models');
  await expect(
    page.getByRole('heading', { name: 'No models yet' }),
  ).toBeVisible();
  await page.route('**/api/status', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"Fixture disconnect"}',
    }),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Connection lost');
  await page.unroute('**/api/status');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'No models yet' }),
  ).toBeVisible();
});

test('wizard select and switch drafts are discarded without writes; outside dismissal closes dialogs', async ({
  page,
  fixture,
}) => {
  // Outside-click dismissal of an unrelated dialog.
  await page.goto('/#/overview');
  await page.getByRole('button', { name: 'Connect client' }).click();
  await page.mouse.click(1, 1);
  await expect(page.getByRole('dialog')).toBeHidden();

  await navigate(page, 'Deployments');
  await page
    .locator('.page-head')
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  // Wizard select: choose a pool through the value, not a DOM option click.
  const poolSelect = dialog.getByLabel('Pool', { exact: true });
  await poolSelect.selectOption({ label: 'Join pool: Example pool' });
  await expect(poolSelect).toContainText('Join pool: Example pool');
  // Base UI toggle (ToggleGroupItem, aria-pressed) marks the wizard dirty.
  await dialog.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Tools', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    fixture.writes.filter(
      (w) =>
        !['/api/resources/preview', '/api/capabilities/preview'].includes(
          w.path,
        ),
    ),
  ).toEqual([]);
});

for (const width of [1440, 390])
  test(`primary surfaces have no page overflow or accessibility violations at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto('/#/overview');
    for (const name of [
      'Overview',
      'Models',
      'Deployments',
      'Activity',
      'Settings',
    ]) {
      await navigate(page, name);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(
        result.violations,
        `${name}: ${JSON.stringify(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))}`,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`${name}-${width}.png`),
        fullPage: true,
      });
    }
    await navigate(page, 'Deployments');
    await page
      .locator('.page-head')
      .getByRole('button', { name: 'New deployment', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Surface');
    await dialog
      .getByLabel('Pool', { exact: true })
      .selectOption({ label: 'Join pool: Example pool' });
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      dialog.getByRole('heading', { name: 'Resource preview', exact: true }),
    ).toBeVisible();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    const save = dialog.getByRole('button', {
      name: 'Make available without loading',
      exact: true,
    });
    await expect(save).toBeEnabled();
    await expect(save).toHaveCSS('opacity', '1');
    expect(
      await dialog
        .locator('.dialog-body')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    const inputBox = (await dialog
      .getByLabel('Name', { exact: true })
      .boundingBox())!;
    expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(width);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`editor-${width}.png`),
      fullPage: true,
    });
  });
