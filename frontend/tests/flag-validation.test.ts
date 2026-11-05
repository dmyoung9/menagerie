import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flagError,
  numericFlagError,
  runtimeFlagSchema,
} from '../src/flag-validation.ts';
import {
  commitFlagInputs,
  inputKey,
  flagInputs,
  reconcileInputs,
} from '../src/draft-form.ts';
import type { DeploymentSetDraft, ProfileDraft } from '../src/types/index.ts';

const profile = (config: ProfileDraft['config']): ProfileDraft => ({
  name: 'Fixture',
  artifact_id: 'weights',
  runtime_id: 'engine',
  config,
  raw_args: [],
  catalog: {},
});

test('stable optional schema never seeds defaults or strips extensions', () => {
  assert.deepEqual(
    runtimeFlagSchema.parse({
      extension: { enabled: false },
      'top-k': 0,
      'top-p': 0.955,
    }),
    { extension: { enabled: false }, 'top-k': 0, 'top-p': 0.955 },
  );
  assert.deepEqual(runtimeFlagSchema.parse({}), {});
  assert.equal(runtimeFlagSchema.safeParse({ threads: 1.5 }).success, false);
  assert.equal(runtimeFlagSchema.safeParse({ temp: Infinity }).success, false);
});

test('numeric text rejects blank/nonfinite values and respects installed constraints', () => {
  const schema = { threads: { type: 'integer', min: -1, max: 256 } };
  for (const text of ['', ' ', 'NaN', 'Infinity'])
    assert.ok(numericFlagError('threads', text, schema, {}));
  assert.equal(
    numericFlagError('threads', '1.5', schema, {}),
    'Enter a whole number.',
  );
  assert.equal(
    numericFlagError('threads', '-2', schema, {}),
    'Enter at least -1.',
  );
  assert.equal(
    numericFlagError('threads', '257', schema, {}),
    'Enter at most 256.',
  );
  for (const text of ['-1', '0', '128'])
    assert.equal(numericFlagError('threads', text, schema, {}), undefined);
});

test('batch relationships use explicit or installed defaults, not reference presets', () => {
  const schema = { 'batch-size': { engine_default: 2048 }, 'ubatch-size': {} };
  assert.equal(
    flagError('ubatch-size', 1024, {}, { 'ubatch-size': 1024 }),
    undefined,
  );
  assert.equal(
    flagError('ubatch-size', 1024, schema, { 'ubatch-size': 1024 }),
    undefined,
  );
  assert.ok(flagError('ubatch-size', 4096, schema, { 'ubatch-size': 4096 }));
  assert.ok(
    flagError('batch-size', 256, schema, {
      'batch-size': 256,
      'ubatch-size': 512,
    }),
  );
});

test('flash attention validates choices and quantized V-cache constraints', () => {
  const schema = { 'flash-attn': { choices: ['auto', 'on', 'off'] } };
  assert.ok(flagError('flash-attn', 'invalid', schema, {}));
  assert.ok(flagError('flash-attn', 'off', schema, { 'cache-type-v': 'q8_0' }));
  assert.equal(
    flagError('flash-attn', 'auto', schema, { 'cache-type-v': 'q8_0' }),
    undefined,
  );
});

test('pending text commits immutably without filling omitted flags or altering precision', () => {
  const draft = profile({ 'top-k': 0, 'top-p': 0.955, extension: false });
  const inputs = flagInputs(draft);
  inputs[inputKey('config', 'top-k')] = '12';
  const committed = commitFlagInputs(draft, inputs);
  assert.deepEqual(committed.config, {
    'top-k': 12,
    'top-p': 0.955,
    extension: false,
  });
  assert.equal(draft.config['top-k'], 0);
  inputs[inputKey('config', 'top-k')] = '';
  assert.deepEqual(commitFlagInputs(draft, inputs), draft);
});

test('JSON and engine replacements reconcile buffers without losing unrelated input', () => {
  const draft = profile({ 'top-k': 0, 'top-p': 0.95 });
  const inputs = { ...flagInputs(draft), [inputKey('config', 'top-k')]: '' };
  assert.equal(
    reconcileInputs(draft, profile({ 'top-k': 0, 'top-p': 0.9 }), inputs)[
      inputKey('config', 'top-k')
    ],
    '',
  );
  assert.equal(
    reconcileInputs(draft, profile({ 'top-k': 40 }), inputs)[
      inputKey('config', 'top-k')
    ],
    '40',
  );
  assert.equal(
    reconcileInputs(draft, { ...draft, runtime_id: 'replacement' }, inputs)[
      inputKey('config', 'top-k')
    ],
    '0',
  );
  assert.equal(
    reconcileInputs(draft, profile({}), inputs)[inputKey('config', 'top-k')],
    undefined,
  );
});

test('member removal keeps pending text with its original model', () => {
  const draft: DeploymentSetDraft = {
    name: 'Fixture',
    residency: 'on-demand',
    priority: 50,
    idle_timeout: 300,
    allow_eviction: false,
    enabled: true,
    queue_timeout: 300,
    members: [8120, 8121].map((port) => ({
      name: String(port),
      alias: String(port),
      port,
      gpu: 0,
      residency: 'on-demand',
      priority: 50,
      idle_timeout: 300,
      allow_eviction: false,
      enabled: true,
      queue_timeout: 300,
      configuration: profile({ 'top-k': 0 }),
    })),
  };
  const inputs = flagInputs(draft);
  inputs[inputKey('members[0].configuration.config', 'top-k')] = '99';
  inputs[inputKey('members[1].configuration.config', 'top-k')] = '';
  const next = { ...draft, members: draft.members.slice(1) };
  assert.equal(
    reconcileInputs(draft, next, inputs)[
      inputKey('members[0].configuration.config', 'top-k')
    ],
    '',
  );
});
