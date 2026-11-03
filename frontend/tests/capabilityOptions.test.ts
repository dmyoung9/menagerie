import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  modeSlug,
  reasoningOptions,
  reasoningLevels,
  mappingKind,
  setReasoningOptions,
  validModeId,
  defaultReasoningOptions,
  newModeId,
} from '../src/capabilityOptions.ts';
import type { ModelCatalog } from '../src/types';

test('existing empty catalogs offer disabled common choices without saving or exposing defaults', () => {
  assert.deepEqual(reasoningOptions({}), []);
  assert.deepEqual(
    reasoningLevels({}).map((mode) => mode.id),
    ['instant', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
  assert(reasoningLevels({}).every((mode) => !mode.enabled));
  assert.deepEqual(reasoningLevels({})[0].body, {});
  assert.deepEqual(reasoningLevels({})[4].body, { reasoning_effort: 'xhigh' });
});

test('custom toggle choices come only from saved user levels, with no guessed settings', () => {
  const catalog: ModelCatalog = {
    reasoning: {
      presets: [
        {
          id: 'research',
          name: 'Research',
          enabled: true,
          body: { reasoning_budget: 8192 },
        },
        { id: 'instant', enabled: false, body: {} },
      ],
    },
  };
  const before = structuredClone(catalog);
  const levels = reasoningLevels(catalog);
  assert.deepEqual(
    levels.map((mode) => mode.id),
    ['research', 'instant', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
  assert.deepEqual(levels[1], catalog.reasoning!.presets![1]);
  assert.deepEqual(levels[0], catalog.reasoning!.presets![0]);
  assert.deepEqual(catalog, before);
});

test('new drafts get independent common defaults without configuring Instant', () => {
  const modes = defaultReasoningOptions();
  assert.deepEqual(
    modes.filter((mode) => mode.enabled).map((mode) => mode.id),
    ['low', 'medium', 'high'],
  );
  assert.deepEqual(modes[0], { id: 'instant', enabled: false, body: {} });
  for (const mode of modes.slice(1))
    assert.deepEqual(mode.body, { reasoning_effort: mode.id });
  modes[1].body.reasoning_effort = 'changed';
  assert.equal(defaultReasoningOptions()[1].body.reasoning_effort, 'low');
});

test('generated IDs avoid common, reserved, saved and unrelated variant IDs', () => {
  const catalog: ModelCatalog = {
    reasoning: { presets: [{ id: 'research', enabled: false, body: {} }] },
    model: { variants: [{ id: 'research-2' }] },
  };
  assert.equal(newModeId('Research', catalog), 'research-3');
  assert.equal(newModeId('XHigh', catalog), 'xhigh-2');
  assert.equal(newModeId('Model Default', catalog), 'model-default-2');
  assert.equal(newModeId('研究', catalog), 'variant');
  const long = 'a'.repeat(80);
  const id = newModeId(long, { model: { variants: [{ id: 'a'.repeat(64) }] } });
  assert(validModeId(id));
  assert.equal(id.length, 64);
});

test('saved order wins and missing common choices do not exceed the 64-entry limit', () => {
  const presets = Array.from({ length: 64 }, (_, i) => ({
    id: `custom-${i}`,
    enabled: false,
    body: {},
  }));
  assert.deepEqual(reasoningLevels({ reasoning: { presets } }), presets);
});

test('compact mappings recognize simple controls and keep composites in custom settings', () => {
  assert.equal(mappingKind({}), '');
  assert.equal(mappingKind({ reasoning_effort: 'custom' }), 'effort');
  assert.equal(
    mappingKind({ chat_template_kwargs: { reasoning_effort: 'custom' } }),
    'template-effort',
  );
  assert.equal(
    mappingKind({ chat_template_kwargs: { enable_thinking: true } }),
    'template',
  );
  assert.equal(mappingKind({ thinking_budget: -1 }), 'thinking_budget');
  assert.equal(
    mappingKind({ reasoning_effort: 'high', thinking_budget: 8192 }),
    'custom',
  );
});

test('saved modes preserve order, empty mappings, labels, default and composite effects', () => {
  const catalog: ModelCatalog = {
    model: { capabilities: { reasoning: true }, limit: { output: 9000 } },
    reasoning: {
      default_mode: 'spoon',
      presets: [
        {
          id: 'spoon',
          name: 'Spoon 8K',
          enabled: false,
          body: {
            reasoning_effort: 'xhigh',
            reasoning_budget: 8192,
            chat_template_kwargs: { enable_thinking: true, style: 'research' },
          },
          prompt_prefix: '{REASON:spoon}',
        },
        {
          id: 'default',
          name: 'Custom default',
          enabled: true,
          body: { thinking_budget: 2048 },
        },
        { id: 'instant', enabled: false, body: {} },
      ],
    },
  };
  const before = structuredClone(catalog);
  assert.deepEqual(reasoningOptions(catalog), catalog.reasoning!.presets);
  const next = setReasoningOptions(catalog, reasoningOptions(catalog));
  assert.deepEqual(next.reasoning, catalog.reasoning);
  assert.deepEqual(next.model.capabilities.reasoning, true);
  assert.deepEqual(next.model.limit, { output: 9000 });
  assert.deepEqual(catalog, before);
});

test('editing modes does not enable an explicitly disabled reasoning capability', () => {
  const next = setReasoningOptions(
    { model: { capabilities: { reasoning: { supported: false } } } },
    [{ id: 'custom', enabled: true, body: { reasoning_effort: 'custom' } }],
  );
  assert.deepEqual(next.model.capabilities.reasoning, { supported: false });
});

test('legacy client mappings import without dropping custom IDs or unrelated catalog variants', () => {
  const catalog: ModelCatalog = {
    model: {
      variants: [
        { id: 'ultra', body: { reasoning_budget: 1234 } },
        { id: 'high', settings: { reasoningEffort: 'high' } },
        { id: 'creative', body: { temperature: 1.2 } },
      ],
    },
  };
  const modes = reasoningOptions(catalog);
  assert.deepEqual(
    modes.map((p) => p.id),
    ['ultra', 'high'],
  );
  assert.deepEqual(modes[1].body, { reasoning_effort: 'high' });
  assert.deepEqual(
    setReasoningOptions(catalog, modes).model.variants,
    catalog.model!.variants,
  );
});

test('stable IDs are bounded and reserve the explicit model-default selector', () => {
  assert.equal(modeSlug('Spoon / Research 8K'), 'spoon-research-8k');
  for (const id of ['xhigh', 'custom.mode-2', 'ABC_1']) assert(validModeId(id));
  for (const id of [
    '',
    'has spaces',
    'model-default',
    'x'.repeat(65),
    '__proto__',
  ])
    assert(!validModeId(id));
});
