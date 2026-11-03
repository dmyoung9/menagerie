import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  modeSlug,
  reasoningOptions,
  reasoningSuggestions,
  setReasoningOptions,
  validModeId,
} from '../src/capabilityOptions.ts';
import type { ModelCatalog } from '../src/types';

test('fresh models get no invented modes, Instant or default effort', () => {
  assert.deepEqual(reasoningOptions({}), []);
  assert.deepEqual(reasoningSuggestions({ reasoning: true }), []);
  assert.deepEqual(
    reasoningSuggestions({ thinking_toggle: true }, { engine: 'custom' }),
    [],
  );
});

test('explicit template hints suggest arbitrary modes without automatically exposing them', () => {
  const hints = {
    reasoning_effort: ['xhigh', 'spoon', 'logic'],
    thinking_toggle: true,
  };
  const suggestions = reasoningSuggestions(hints, { engine: 'prism' });
  assert.deepEqual(
    suggestions.map((p) => p.id),
    ['xhigh', 'spoon', 'logic', 'thinking-on', 'thinking-off'],
  );
  assert(suggestions.every((p) => !p.enabled));
  assert.deepEqual(suggestions[1].body, {
    chat_template_kwargs: { reasoning_effort: 'spoon' },
  });
  assert.deepEqual(suggestions.at(-1)?.body, {
    chat_template_kwargs: { enable_thinking: false },
  });
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
