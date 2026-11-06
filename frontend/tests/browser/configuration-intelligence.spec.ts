import { test, expect } from './fixtures';
import { deploymentDraft } from '../../src/contracts';

test('curated sections preserve omission and separate explicit automatic context', async ({
  page,
  fixture,
}) => {
  const deployment = fixture.registry.deployments.find(
    (entry) => entry.id === 'idle',
  )!;
  deployment.profile_snapshot!.config = {};
  fixture.registry.runtimes[0].capabilities!.schema!['ctx-size'].min = 0;
  fixture.registry.runtimes[0].capabilities!.schema!['ctx-size'].presentation =
    {
      category: 'resources-context',
      owner: 'runtime-process',
      inheritable: true,
      automatic_value: 0,
      request_overridable: false,
      provenance: 'adapter',
    };
  await page.goto('/#/deployments/idle/configuration');
  for (const title of [
    'Model & runtime',
    'Resources & context',
    'Generation',
    'Availability',
  ])
    await expect(
      page.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
  const source = page.getByLabel('ctx-size setting', { exact: true });
  await expect(source).toHaveValue('inherited');
  await expect(
    page.getByRole('button', { name: 'Discard', exact: true }),
  ).toBeDisabled();
  await source.selectOption('automatic');
  await expect(source).toHaveValue('automatic');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () =>
        fixture.registry.deployments.find((entry) => entry.id === 'idle')
          ?.revision,
    )
    .toBe(2);
  const saved = deploymentDraft(
    fixture.writes.find(
      (entry) => entry.path === '/api/deployments?expected=1',
    )!.body,
  );
  expect(saved.configuration!.config).toEqual({ 'ctx-size': 0 });
});

test('capability warnings retain manual controls and recommendations need explicit application', async ({
  page,
  fixture,
}) => {
  const deployment = fixture.registry.deployments.find(
    (entry) => entry.id === 'idle',
  )!;
  deployment.profile_snapshot!.config = {};
  fixture.registry.runtimes[0].capabilities!.schema!.temp = {
    type: 'number',
    min: 0,
    max: 5,
    label: 'Temperature',
  };
  await page.route('**/api/capabilities/preview', (route) =>
    route.fulfill({
      json: {
        model: {
          input_image: {
            status: 'supported',
            evidence: [
              {
                source: 'artifact',
                confidence: 'high',
                detail: 'vision_config',
              },
            ],
          },
        },
        effective: {
          input_image: {
            status: 'unsupported',
            evidence: [
              {
                source: 'runtime',
                confidence: 'high',
                detail: 'Missing compatible projector',
              },
            ],
          },
        },
        warnings: ['Choose a compatible projector; launch remains available.'],
        recommendations: [
          {
            parameter: 'temp',
            value: 0.6,
            compatible: true,
            source: 'artifact',
            detail: 'Published generation_config.json',
          },
        ],
      },
    }),
  );
  await page.goto('/#/deployments/idle/configuration');
  await expect(
    page.getByText('Image input: unsupported', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Choose a compatible projector; launch remains available.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Discard', exact: true }),
  ).toBeDisabled();
  await page
    .getByText('Published sampling recommendations', { exact: true })
    .click();
  await expect(
    page.getByText('Published generation_config.json', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Apply compatible recommendations' })
    .click();
  await expect(page.getByLabel('Temperature', { exact: true })).toHaveValue(
    '0.6',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () =>
        fixture.registry.deployments.find((entry) => entry.id === 'idle')
          ?.revision,
    )
    .toBe(2);
  expect(
    fixture.registry.deployments.find((entry) => entry.id === 'idle')
      ?.profile_snapshot!.config,
  ).toEqual({ temp: 0.6 });
});

test('Advanced retains editable schema controls, raw arguments and identity', async ({
  page,
  fixture,
}) => {
  await page.goto('/#/deployments/idle/advanced');
  await expect(page.getByLabel('Display name', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add performance flags', exact: true }),
  ).toBeEnabled();
  await page.getByText('Engine arguments', { exact: true }).click();
  await page
    .getByLabel('Engine arguments', { exact: true })
    .fill('["--vendor-option", "synthetic"]');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () =>
        fixture.registry.deployments.find((entry) => entry.id === 'idle')
          ?.revision,
    )
    .toBe(2);
  expect(
    fixture.registry.deployments.find((entry) => entry.id === 'idle')
      ?.profile_snapshot!.raw_args,
  ).toEqual(['--vendor-option', 'synthetic']);
});
