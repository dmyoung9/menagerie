import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagDefault, flagDefaultNote } from '../src/runtime-flags.ts';

test('documented defaults seed flags without using historical policy presets', () => {
  assert.equal(
    flagDefault('batch-size', { 'batch-size': { default: 512 } }, {}),
    2048,
  );
  assert.equal(flagDefault('temp', { temp: { default: 1 } }, {}), 0.8);
  assert.equal(flagDefault('top-k', { 'top-k': { engine_default: 0 } }, {}), 0);
  assert.equal(
    flagDefault('reasoning-budget', { 'reasoning-budget': {} }, {}),
    -1,
  );
});

test('installed help and inherited defaults take precedence without modifying the draft', () => {
  const schema = {
    threads: { engine_default: 8 },
    'threads-batch': { default_from: 'threads' },
    'top-p': { engine_default: 0.9, default_note: '0.90, 1.0 = disabled' },
  };
  const value = { threads: 4 };
  assert.equal(flagDefault('threads-batch', schema, value), 4);
  assert.equal(flagDefault('threads-batch', schema, {}), 8);
  assert.equal(flagDefault('top-p', schema, value), 0.9);
  assert.equal(
    flagDefaultNote('threads-batch', schema['threads-batch']),
    'same as --threads',
  );
  assert.equal(
    flagDefaultNote('top-p', schema['top-p']),
    '0.90, 1.0 = disabled',
  );
  assert.equal(
    flagDefaultNote('top-k', { engine_default: 0 }),
    '0, 0 = disabled',
  );
  assert.deepEqual(value, { threads: 4 });
});
