import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileRuntimeOptions } from '../src/runtime-options.ts';

test('schema updates add defaults without overwriting edits or cleared values', () => {
  const current = { 'gpu-layers': '17', custom: true };
  const defaults = {
    'gpu-layers': 'all',
    'cache-type-k': 'q8_0',
    'flash-attn': 'on',
  };
  assert.deepEqual(
    reconcileRuntimeOptions(
      current,
      defaults,
      ['gpu-layers', 'cache-type-k'],
      ['gpu-layers', 'cache-type-k', 'flash-attn'],
    ),
    { 'gpu-layers': '17', custom: true, 'flash-attn': 'on' },
  );
  assert.deepEqual(current, { 'gpu-layers': '17', custom: true });
});

test('schema updates remove retired settings but retain unrelated custom options', () => {
  assert.deepEqual(
    reconcileRuntimeOptions(
      { 'gpu-layers': '17', retired: 2, custom: true },
      { 'gpu-layers': 'all' },
      ['gpu-layers', 'retired'],
      ['gpu-layers'],
    ),
    { 'gpu-layers': '17', custom: true },
  );
});
