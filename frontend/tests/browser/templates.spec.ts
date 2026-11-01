import { test, expect } from './fixtures';

test('model details opens the new-custom-template editor and saves it', async ({
  page,
  fixture,
}) => {
  const textarea = page.locator('textarea[placeholder*="Jinja chat template"]');

  // Give the model a realistic template list: one published, one custom.
  fixture.registry.models[0] = {
    ...fixture.registry.models[0],
    template_default: { source: 'automatic', asset_id: null },
    templates: [
      {
        id: 'pub-1',
        kind: 'published',
        artifact_id: 'model',
        name: 'chat_template',
        sha256: 'sha-a',
        file_path: '/models/hf/chat_template.jinja',
        relative_path: 'chat_template.jinja',
        size_bytes: 12,
        status: 'available',
        repo: 'fixture/model',
        source_revision: 'fixture-commit',
        error: null,
      },
      {
        id: 'custom-1',
        kind: 'custom',
        artifact_id: 'model',
        name: 'custom',
        sha256: 'sha-b',
        file_path: '/templates/custom-1.jinja',
        relative_path: 'custom.jinja',
        size_bytes: 6,
        status: 'available',
        repo: null,
        source_revision: null,
        error: null,
      },
    ],
  };

  let newBody: Record<string, unknown> | null = null;
  let editBody: Record<string, unknown> | null = null;
  let deleteId: string | null = null;

  // The model-details dialog reads its templates from the registry (already
  // served by the fixture). The template mutation/detail endpoints are not
  // mocked by the fixture, so intercept them here.
  page.route('**/api/templates**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();
    if (path === '/api/templates' && method === 'POST') {
      newBody = body;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'new-1',
          kind: 'custom',
          name: 'custom (custom)',
          artifact_id: 'model',
          content: (body as Record<string, unknown>).content,
          sha256: 'sha-c',
          size_bytes: 99,
          status: 'available',
          error: null,
        }),
      });
    }
    if (path.startsWith('/api/templates/') && method === 'GET') {
      // /api/templates/{id} — full template including content for editing.
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'custom-1',
          kind: 'custom',
          name: 'custom',
          content: ' {{ existing }}',
          sha256: 'sha-b',
          size_bytes: 6,
          status: 'available',
          error: null,
        }),
      });
    }
    if (path.startsWith('/api/templates/') && method === 'POST') {
      if (path.endsWith('/delete')) {
        // /api/templates/{id}/delete
        deleteId = path.split('/').at(-2) ?? null;
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ deleted: deleteId }),
        });
      }
      // /api/templates/{id} — edit (the frontend api() sends POST for all
      // mutations, including updates).
      editBody = body;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'custom-1',
          content: (body as Record<string, unknown>).content,
        }),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unhandled template route' }),
      status: 500,
    });
  });

  await page.goto('/#/models');
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Chat templates', exact: true }),
  ).toBeVisible();

  // The editor must be closed on first open (bug: it never rendered for New).
  await expect(textarea).toHaveCount(0);

  // "New custom template" opens the editor with no asset selected.
  await page
    .getByRole('button', { name: 'New custom template', exact: true })
    .click();
  await expect(textarea).toBeVisible();

  await textarea.fill(' {{ assistant }}');
  await expect(
    page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save template', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save template', exact: true })
    .click();

  await expect(page.getByText('Custom template created.')).toBeVisible();
  await expect(textarea).toHaveCount(0);
  // Leading/trailing whitespace is trimmed before save.
  expect(newBody).toEqual({
    artifact_id: 'model',
    content: '{{ assistant }}',
  });

  // Edit flow: the same editor opens pre-filled with the existing content.
  await page
    .getByRole('dialog')
    .getByRole('listitem')
    .nth(1)
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue(' {{ existing }}');
  await textarea.fill(' {{ changed }}');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save template', exact: true })
    .click();
  await expect(page.getByText('Custom template saved.')).toBeVisible();
  await expect(textarea).toHaveCount(0);
  expect(editBody).toEqual({ content: '{{ changed }}' });

  // Delete flow: confirmation required, then the row is gone.
  await page
    .getByRole('dialog')
    .getByRole('listitem')
    .nth(1)
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('alertdialog').getByText('Continue').click();
  await expect(page.getByText('Custom template removed.')).toBeVisible();
  expect(deleteId).toBe('custom-1');
});
