import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfiguredModelCatalog } from '../src/types';
import {
  mappingKind,
  reasoningOptions,
  setReasoningOptions,
} from '../src/capabilityOptions.ts';

test('unknown controls stay unavailable; Default remains usable', () => {
  const options = reasoningOptions(
    {},
    { reasoning: true },
    { engine: 'llama.cpp' },
  );
  assert.deepEqual(
    options.filter((p) => p.enabled).map((p) => p.id),
    ['default'],
  );
  assert(
    options
      .filter((p) => p.id !== 'default')
      .every((p) => Object.keys(p.body).length === 0),
  );
});

test('detected thinking toggle offers Instant without inventing effort levels', () => {
  const options = reasoningOptions(
    {},
    { thinking_toggle: true },
    { engine: 'llama.cpp' },
  );
  assert.deepEqual(options.find((p) => p.id === 'instant')?.body, {
    chat_template_kwargs: { enable_thinking: false },
  });
  assert(
    options
      .filter((p) => ['low', 'medium', 'high'].includes(p.id))
      .every((p) => !Object.keys(p.body).length),
  );
  assert(
    !Object.keys(
      reasoningOptions({}, { thinking_toggle: true }, { engine: 'custom' })[1]
        .body,
    ).length,
  );
});

test('effort levels must be explicit in metadata', () => {
  const options = reasoningOptions(
    {},
    { reasoning_effort: ['low', 'high'] },
    { engine: 'prism' },
  );
  assert.deepEqual(options.find((p) => p.id === 'high')?.body, {
    reasoning_effort: 'high',
  });
  assert.equal(
    Object.keys(options.find((p) => p.id === 'medium')!.body).length,
    0,
  );
  assert.equal(
    Object.keys(options.find((p) => p.id === 'instant')!.body).length,
    0,
  );
});

test('saved mappings and exposure survive metadata changes and edits to another option', () => {
  const catalog: ConfiguredModelCatalog = {
    model: {
      limit: { output: 8192 },
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
    },
    reasoning: {
      presets: [
        { id: 'default', enabled: false, body: {} },
        { id: 'instant', enabled: true, body: { reasoning_effort: 'none' } },
        { id: 'high', enabled: false, body: { reasoning_budget: 12345 } },
      ],
    },
  };
  const original = structuredClone(catalog);
  const options = reasoningOptions(
    catalog,
    { thinking_toggle: true },
    { engine: 'llama.cpp' },
  );
  const next = setReasoningOptions(
    catalog,
    options.map((p) => (p.id === 'high' ? { ...p, enabled: true } : p)),
  );
  assert.deepEqual(
    next.reasoning.presets.find((p: { id: string }) => p.id === 'instant'),
    catalog.reasoning.presets[1],
  );
  assert.equal(
    next.reasoning.presets.find((p) => p.id === 'default')?.enabled,
    false,
  );
  assert.deepEqual(next.model.limit, { output: 8192 });
  assert.deepEqual(next.model.capabilities.input, ['text', 'image']);
  assert.deepEqual(catalog, original);
});

test('existing client variants remain selectable without resetting their controls', () => {
  const options = reasoningOptions({
    model: { variants: [{ id: 'high', body: { thinking_budget: 9000 } }] },
  });
  assert.deepEqual(options.find((p) => p.id === 'high')?.body, {
    thinking_budget: 9000,
  });
  assert.equal(options.find((p) => p.id === 'high')?.enabled, true);
});

test('advanced controls recognize common mappings without exposing JSON', () => {
  assert.equal(mappingKind({}), '');
  assert.equal(mappingKind({ reasoning_effort: 'low' }), 'effort');
  assert.equal(
    mappingKind({ chat_template_kwargs: { enable_thinking: false } }),
    'template',
  );
  assert.equal(mappingKind({ reasoning_budget: 2048 }), 'reasoning_budget');
  assert.equal(mappingKind({ thinking_budget: 2048 }), 'thinking_budget');
  assert.equal(
    mappingKind({ reasoning_effort: 'high', reasoning_budget: 1000 }),
    'custom',
  );
});
