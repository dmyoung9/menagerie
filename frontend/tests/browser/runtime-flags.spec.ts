import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

test('standalone NumberControl also preserves clearing and commits before Enter submission', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments/idle/configuration');
  const priority = page.getByLabel('Priority', { exact: true });
  await priority.fill('');
  await priority.blur();
  await expect(priority).toHaveValue('');
  await priority.fill('15');
  await priority.press('Enter');
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  expect(
    deploymentDraft(
      fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!
        .body,
    ).priority,
  ).toBe(15);
});

test('installed capability refresh preserves focused text and validates the new bounds on blur', async ({
  page,
  fixture,
}) => {
  fixture.registry.runtimes[0].capabilities!.schema!.threads.label =
    'CPU threads';
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.config.threads = 8;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/runtimes/engine/capabilities', async (route) => {
    await held;
    const capabilities = structuredClone(
      fixture.registry.runtimes[0].capabilities!,
    );
    capabilities.schema!.threads.max = 4;
    await route.fulfill({ json: capabilities });
  });
  await page.goto('/#/deployments/idle/configuration');
  const input = page.getByLabel('CPU threads', { exact: true });
  await input.fill('12');
  release();
  await expect(input).toHaveAttribute('max', '4');
  await expect(input).toHaveValue('12');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await input.blur();
  await expect(
    page.locator('[data-runtime-flag="threads"]').getByRole('alert'),
  ).toHaveText('Enter at most 4.');
  await expect(input).toHaveValue('12');
});

test('multi-model removal keeps the remaining member numeric buffer and saves it through the shared form', async ({
  page,
  fixture,
}) => {
  fixture.registry.runtimes[0].capabilities!.schema!['top-k'] = {
    type: 'integer',
    min: 0,
    max: 100,
    label: 'Top-k',
    default: 0,
  };
  await page.goto('/#/deployments');
  await page
    .getByRole('button', { name: 'New deployment', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Buffered pair');
  await dialog.getByRole('button', { name: 'Add model', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add model', exact: true }).click();
  const second = dialog.locator('[data-model-index="1"]');
  await second.getByLabel('Top-k', { exact: true }).fill('');
  await second.getByLabel('Top-k', { exact: true }).blur();
  await dialog
    .locator('[aria-label="Models"]')
    .getByRole('button')
    .first()
    .click();
  await dialog
    .locator('[data-model-index="0"]')
    .getByRole('button', { name: 'Remove model', exact: true })
    .click();
  const remaining = dialog.getByLabel('Top-k', { exact: true });
  await expect(remaining).toHaveValue('');
  await remaining.fill('8');
  await remaining.press('Enter');
  await expect(dialog).toBeHidden();
  const saved = deploymentDraft(
    fixture.writes.find((w) => w.path === '/api/deployments')!.body,
  );
  expect(saved.configuration!.config['top-k']).toBe(8);
});

test('clearing is an editing buffer; blur validates without substituting zero and Enter commits retyped text', async ({
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
  const input = page.getByRole('spinbutton', { name: 'Top-k', exact: true });
  const row = page.locator('[data-runtime-flag="top-k"]');
  await input.fill('');
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await expect(row.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Discard', exact: true }),
  ).toBeEnabled();
  await page.getByLabel('Display name', { exact: true }).focus();
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(row.getByRole('alert')).toHaveText('Enter a number.');
  await expect(row.locator(':scope > [data-slot="field-error"]')).toHaveText(
    'Enter a number.',
  );
  expect(
    await row.evaluate((element) =>
      element.lastElementChild?.previousElementSibling?.getAttribute(
        'data-slot',
      ),
    ),
  ).toBe('field-description');
  await expect(input).toHaveAttribute('aria-describedby', /-error/);
  await input.fill('12');
  await expect(input).toHaveValue('12');
  await input.press('Enter');
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  expect(
    deploymentDraft(
      fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!
        .body,
    ).configuration!.config['top-k'],
  ).toBe(12);
  await expect(
    page.getByRole('button', { name: 'Discard', exact: true }),
  ).toBeDisabled();
});

test('automatic thread input stays blank through validation and Discard restores value and metadata', async ({
  page,
  fixture,
}) => {
  Object.assign(fixture.registry.runtimes[0].capabilities!.schema!.threads, {
    min: -1,
    label: 'CPU threads',
  });
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.config.threads = -1;
  await page.goto('/#/deployments/idle/configuration');
  const input = page.getByRole('spinbutton', {
    name: 'CPU threads',
    exact: true,
  });
  await input.fill('');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(
    fixture.writes.filter((w) => w.path.startsWith('/api/deployments?')),
  ).toHaveLength(0);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(input).toHaveValue('-1');
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await expect(
    page.getByRole('button', { name: 'Discard', exact: true }),
  ).toBeDisabled();
});

test('removing an invalid flag clears its errors and unrelated omitted batch defaults impose no limit', async ({
  page,
  fixture,
}) => {
  Object.assign(fixture.registry.runtimes[0].capabilities!.schema!, {
    'top-k': { type: 'integer', min: 0, max: 100, label: 'Top-k' },
    'ubatch-size': {
      type: 'integer',
      min: 1,
      max: 8192,
      label: 'Physical batch',
    },
  });
  Object.assign(
    fixture.registry.deployments.find((d) => d.id === 'idle')!.profile_snapshot!
      .config,
    { 'top-k': 0, 'ubatch-size': 4096 },
  );
  await page.goto('/#/deployments/idle/configuration');
  const input = page.getByLabel('Top-k', { exact: true });
  await input.fill('1.5');
  await page.getByLabel('Display name', { exact: true }).focus();
  await expect(
    page.locator('[data-runtime-flag="top-k"]').getByRole('alert'),
  ).toHaveText('Enter a whole number.');
  await page
    .getByRole('button', { name: 'Remove Top-k override', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  const saved = deploymentDraft(
    fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!.body,
  ).configuration!.config;
  expect(saved).not.toHaveProperty('top-k');
  expect(saved).not.toHaveProperty('batch-size');
  expect(saved['ubatch-size']).toBe(4096);
});

test('advanced JSON replaces numeric buffers and a failed Save preserves the corrected draft', async ({
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
  const input = page.getByLabel('Top-k', { exact: true });
  await input.fill('');
  await input.blur();
  await page.getByText('Advanced model settings', { exact: true }).click();
  await page.getByText('Runtime options (JSON)', { exact: true }).click();
  const json = page.getByRole('textbox', {
    name: 'Runtime options (JSON)',
    exact: true,
  });
  await json.fill('{"top-k":40,"extension":false}');
  await expect(input).toHaveValue('40');
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await input.fill('41');
  await json.focus();
  await expect(json).toHaveValue('{\n  "top-k": 41,\n  "extension": false\n}');
  fixture.failSave = true;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('Alias already exists', { exact: false }),
  ).toBeVisible();
  await expect(input).toHaveValue('41');
  await expect(
    page.getByRole('button', { name: 'Discard', exact: true }),
  ).toBeEnabled();
  fixture.failSave = false;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
});

test('unrelated saves keep omitted flags absent and clearing a saved value stays dirty until discarded', async ({
  page,
  fixture,
}) => {
  fixture.registry.runtimes[0].capabilities!.schema!['top-k'] = {
    type: 'integer',
    label: 'Top-k',
    min: 0,
    max: 1048576,
  };
  fixture.registry.runtimes[0].capabilities!.schema!['top-p'] = {
    type: 'number',
    label: 'Top-p',
    min: 0,
    max: 1,
  };
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.config['top-p'] = 0.955;
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.config['top-k'] = 0;
  await page.goto('/#/deployments/idle/configuration');
  await page.getByLabel('Top-k', { exact: true }).fill('');
  await expect(
    page.getByRole('button', { name: 'Discard', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(
    fixture.writes.filter((w) => w.path.startsWith('/api/deployments?')),
  ).toHaveLength(0);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByLabel('Top-k', { exact: true })).toHaveValue('0');
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Renamed fixture');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  const saved = deploymentDraft(
    fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!.body,
  ).configuration!.config;
  expect(saved['top-k']).toBe(0);
  expect(saved['top-p']).toBe(0.955);
  expect(saved).not.toHaveProperty('threads');
});

test('saved thread counts above host concurrency remain editable and save unchanged', async ({
  page,
  fixture,
}) => {
  fixture.registry.runtimes[0].capabilities!.schema!.threads.label =
    'CPU threads';
  fixture.registry.deployments.find(
    (d) => d.id === 'idle',
  )!.profile_snapshot!.config.threads = 16;
  await page.goto('/#/deployments/idle/configuration');
  await expect(page.getByLabel('CPU threads', { exact: true })).toHaveValue(
    '16',
  );
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Oversubscribed fixture');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
    )
    .toBe(2);
  expect(
    deploymentDraft(
      fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!
        .body,
    ).configuration!.config.threads,
  ).toBe(16);
});

for (const width of [1440, 576, 320]) {
  test(`flag picker and editable items preserve explicit settings at ${width}px`, async ({
    page,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    Object.assign(fixture.registry.runtimes[0].capabilities!.schema!, {
      'top-p': { type: 'number', label: 'Top-p', min: 0, max: 1 },
      'top-k': { type: 'integer', label: 'Top-k', min: 0, max: 1048576 },
      'repeat-penalty': {
        type: 'number',
        label: 'Repetition penalty',
        min: 0,
        max: 10,
      },
      'reasoning-budget': {
        type: 'integer',
        label: 'Default reasoning budget',
        min: -1,
        max: 1048576,
      },
    });
    const original = fixture.registry.deployments.find(
      (d) => d.id === 'idle',
    )!.profile_snapshot!;
    Object.assign(original.config, {
      'top-p': 0.95,
      'top-k': 0,
      extension: false,
    });
    await page.goto('/#/deployments/idle/configuration');
    const card = page.getByRole('region', { name: 'Generation', exact: true });
    const rows = card.locator('[data-runtime-flag]');
    const group = card.getByRole('group', {
      name: 'Generation flags',
      exact: true,
    });
    await expect(group).toHaveJSProperty('tagName', 'FIELDSET');
    await expect(group.locator(':scope > legend')).toHaveText(
      'Generation flags',
    );
    await expect(
      group.locator(':scope > [data-slot="field-group"]'),
    ).toHaveCount(1);
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute('data-slot', 'field');
    expect(
      await rows
        .first()
        .evaluate((element) =>
          Array.from(element.children).map(
            (child) => child.getAttribute('data-slot') || 'controls',
          ),
        ),
    ).toEqual([
      'field-label',
      'field-label',
      'field-group',
      'field-description',
    ]);
    const item = rows.first().locator('..').locator('..');
    await expect(item).toHaveAttribute('data-slot', 'item');
    await expect(item).toHaveAttribute('data-size', 'sm');
    await expect(
      item.locator(':scope > [data-slot="item-content"] > [data-runtime-flag]'),
    ).toHaveCount(1);
    await expect(
      item.locator(':scope > [data-slot="item-actions"] > button'),
    ).toHaveAccessibleName('Remove Top-p override');
    await expect(
      rows.first().getByRole('button', { name: /Remove/ }),
    ).toHaveCount(0);
    await expect(
      group
        .getByRole('list', { name: 'Generation flag items', exact: true })
        .getByRole('listitem'),
    ).toHaveCount(2);
    const inputBox = await rows.first().getByRole('spinbutton').boundingBox();
    const descriptionBox = await rows
      .first()
      .locator(':scope > [data-slot="field-description"]')
      .boundingBox();
    expect(descriptionBox!.y).toBeGreaterThanOrEqual(
      inputBox!.y + inputBox!.height,
    );
    const title = rows.first().locator(':scope > div[data-slot="field-label"]');
    const syntax = rows
      .first()
      .locator(':scope > label[data-slot="field-label"]');
    await expect(title).toHaveText('Top-p sampling');
    await expect(title.locator('code')).toHaveCount(0);
    await expect(syntax).toHaveText('(--top-p N)');
    await expect(syntax.locator(':scope > code')).toHaveText('(--top-p N)');
    expect(
      await syntax.evaluate((label: HTMLLabelElement) => label.control?.id),
    ).toBe(await rows.first().getByRole('spinbutton').getAttribute('id'));
    const titleBox = await title.boundingBox();
    const syntaxBox = await syntax.boundingBox();
    expect(syntaxBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height);
    expect(inputBox!.y).toBeGreaterThanOrEqual(
      syntaxBox!.y + syntaxBox!.height,
    );
    await expect(
      rows.first().locator(':scope > [data-slot="field-description"]'),
    ).toHaveText('default: 0.95, 1.0 = disabled');
    await expect(
      rows.first().locator(':scope > [data-slot="field-description"] code'),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Discard', exact: true }),
    ).toBeDisabled();
    const trigger = card.getByRole('button', {
      name: 'Add generation flags',
      exact: true,
    });
    await trigger.click();
    const drawer = page.getByRole('dialog', {
      name: 'Add generation flags',
      exact: true,
    });
    await expect(drawer.locator('[data-slot="item"]')).toHaveCount(2);
    await expect(drawer.locator('[data-slot="item"]').first()).toHaveAttribute(
      'data-size',
      'default',
    );
    await expect(
      drawer.getByRole('checkbox', { name: 'Top-p', exact: true }),
    ).toHaveCount(0);
    await expect(drawer.getByRole('spinbutton')).toHaveCount(0);
    await expect(drawer.getByRole('slider')).toHaveCount(0);
    const available = drawer.locator('[data-slot="item"]').first();
    await expect(available.locator('[data-slot="item-title"]')).toHaveText(
      'Penalize repeat sequence of tokens (--repeat-penalty N)',
    );
    await expect(available.locator('[data-slot="item-title"] code')).toHaveText(
      '(--repeat-penalty N)',
    );
    const pickerTitleBox = await available
      .locator('[data-slot="item-title"] > span > span')
      .boundingBox();
    const pickerSyntaxBox = await available
      .locator('[data-slot="item-title"] code')
      .boundingBox();
    expect(pickerSyntaxBox!.y).toBeGreaterThanOrEqual(
      pickerTitleBox!.y + pickerTitleBox!.height,
    );
    await expect(
      available.locator('[data-slot="item-description"]'),
    ).toHaveText('default: 1.00, 1.0 = disabled');
    await expect(
      drawer.getByRole('button', { name: 'Add (0)', exact: true }),
    ).toBeDisabled();
    await drawer
      .getByText('Penalize repeat sequence of tokens', { exact: true })
      .click();
    await expect(
      drawer.getByRole('checkbox', { name: 'Repetition penalty', exact: true }),
    ).toBeChecked();
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toBeFocused();
    await expect(rows).toHaveCount(2);
    await expect(
      page.getByRole('button', { name: 'Discard', exact: true }),
    ).toBeDisabled();
    await trigger.click();
    await expect(
      drawer.getByRole('checkbox', { name: 'Repetition penalty', exact: true }),
    ).not.toBeChecked();
    await drawer
      .getByRole('checkbox', { name: 'Repetition penalty', exact: true })
      .focus();
    await page.keyboard.press('Space');
    await drawer
      .getByRole('checkbox', { name: 'Default reasoning budget', exact: true })
      .check();
    await expect(
      drawer.getByRole('button', { name: 'Add (2)', exact: true }),
    ).toBeInViewport();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`flag-picker-${width}.png`),
    });
    await drawer.getByRole('button', { name: 'Add (2)', exact: true }).click();
    await expect(rows).toHaveCount(4);
    await expect(trigger).toBeDisabled();
    await expect(
      page.getByLabel('Default reasoning budget', { exact: true }),
    ).toHaveValue('-1');
    const input = page.getByLabel('Repetition penalty', { exact: true });
    await input.fill('');
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect(
      fixture.writes.filter((w) => w.path.startsWith('/api/deployments?')),
    ).toHaveLength(0);
    await input.fill('1.12');
    await page
      .getByRole('slider', { name: 'Repetition penalty range', exact: true })
      .focus();
    await page.keyboard.press('ArrowRight');
    await expect(input).toHaveValue('1.13');
    await page
      .getByRole('button', { name: 'Remove Top-k override', exact: true })
      .click();
    await expect(page.getByLabel('Top-k', { exact: true })).toHaveCount(0);
    await trigger.click();
    await expect(
      drawer.getByRole('checkbox', { name: 'Top-k', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`flag-items-${width}.png`),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(
        () =>
          fixture.registry.deployments.find((d) => d.id === 'idle')?.revision,
      )
      .toBe(2);
    const saved = deploymentDraft(
      fixture.writes.find((w) => w.path === '/api/deployments?expected=1')!
        .body,
    ).configuration!.config;
    expect(saved).toMatchObject({
      'top-p': 0.95,
      'repeat-penalty': 1.13,
      'reasoning-budget': -1,
      extension: false,
    });
    expect(saved).not.toHaveProperty('top-k');
    await page
      .getByRole('button', { name: 'Remove Top-p override', exact: true })
      .click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByLabel('Top-p', { exact: true })).toHaveValue('0.95');
    await page.reload();
    await expect(
      page.getByLabel('Repetition penalty', { exact: true }),
    ).toHaveValue('1.13');
    await page.goto('/#/deployments/ready/configuration');
    await expect(
      page.getByRole('button', { name: 'Add performance flags', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Remove Top-p override', exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel('Top-p', { exact: true })).toBeDisabled();
  });
}
