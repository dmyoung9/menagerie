/**
 * Unit tests for the deterministic API-identifier contract on the client:
 * the server suggestion request and the last-resort local fallback.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchSuggestedAlias,
  localAliasFallback,
} from '../src/alias-suggestion.ts';

type FetchFn = typeof globalThis.fetch;

function mockFetch(handler: FetchFn): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function ok(json: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

test('fetches the generated identifier and decodes the contract', async () => {
  const urls: string[] = [];
  const restore = mockFetch((input) => {
    urls.push(String(input));
    return ok({
      alias: 'example-8b',
      base: 'example-8b',
      mode: 'generated',
    });
  });
  try {
    const result = await fetchSuggestedAlias('Example 8B');
    assert.equal(urls[0], '/api/deployments/alias/suggest?name=Example%208B');
    assert.deepEqual(result, {
      alias: 'example-8b',
      base: 'example-8b',
      mode: 'generated',
    });
  } finally {
    restore();
  }
});

test('encodes the name for non-ASCII and special characters', async () => {
  const urls: string[] = [];
  const restore = mockFetch((input) => {
    urls.push(String(input));
    return ok({
      alias: 'model-abcdef12',
      base: 'model-abcdef12',
      mode: 'generated',
    });
  });
  try {
    await fetchSuggestedAlias('日本語 测试 🚀');
    assert.equal(
      urls[0],
      '/api/deployments/alias/suggest?name=' +
        encodeURIComponent('日本語 测试 🚀'),
    );
  } finally {
    restore();
  }
});

test('surfaces a server error on a non-200 suggestion response', async () => {
  const restore = mockFetch(() => ok({ error: 'Model name required' }, 400));
  try {
    await assert.rejects(fetchSuggestedAlias(''), /Model name required/);
  } finally {
    restore();
  }
});

test('decodes a validation-style detail array into one error line', async () => {
  const restore = mockFetch(() =>
    ok(
      {
        detail: [
          {
            loc: ['query', 'name'],
            msg: 'Field required',
          },
        ],
      },
      422,
    ),
  );
  try {
    await assert.rejects(fetchSuggestedAlias(''), /name: Field required/);
  } finally {
    restore();
  }
});

test('localAliasFallback lowercases and hyphenates', () => {
  assert.equal(localAliasFallback('Example 8B'), 'example-8b');
  assert.equal(localAliasFallback('Model_8B--Q4'), 'model-8b-q4');
  assert.equal(localAliasFallback('  Leading  '), 'leading');
  assert.equal(localAliasFallback('Trail. ing-'), 'trail-ing');
});

test('localAliasFallback normalizes dots and underscores to hyphens to match the server slug', () => {
  assert.equal(localAliasFallback('a.b_c-d'), 'a-b-c-d');
});

test('localAliasFallback truncates long names to 140 characters', () => {
  const long = 'a'.repeat(300);
  const result = localAliasFallback(long);
  assert.equal(result.length, 140);
  assert.ok(result.startsWith('a'));
});

test('localAliasFallback returns a stable model id when there is no slug', () => {
  assert.equal(localAliasFallback(''), 'model');
  assert.equal(localAliasFallback('   '), 'model');
  assert.equal(localAliasFallback('!!!'), 'model');
  assert.equal(localAliasFallback('—'), 'model');
});
