import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as contracts from '../src/contracts.ts';
import { editable } from '../src/editor-state.ts';
import { artifactLimits } from '../src/artifact-metadata.ts';

test('Hugging Face catalog fields accept SDK nulls without accepting invalid shapes', () => {
  const model = {
    id: 'fixture/qwen',
    gated: null,
    downloads: null,
    tags: null,
    likes: null,
    pipeline_tag: null,
  };
  assert.deepEqual(contracts.catalogModel(model), model);
  for (const gated of [false, true, 'auto', 'manual', null]) {
    assert.equal(
      contracts.catalogModel({ id: 'fixture/qwen', gated }).gated,
      gated,
    );
  }
  assert.throws(() => contracts.catalogModel({ ...model, gated: 1 }), /gated/);
  assert.throws(
    () => contracts.catalogModel({ ...model, downloads: 'many' }),
    /downloads/,
  );
  assert.throws(
    () => contracts.catalogModel({ ...model, tags: [null] }),
    /tags/,
  );
});

test('wire decoders reject malformed nested data and non-JSON configuration values', () => {
  assert.throws(
    () =>
      contracts.artifact({
        id: 'm',
        revision: 1,
        name: 'Model',
        format: 'gguf',
        metadata: { config: [] },
      }),
    /metadata.config/,
  );
  assert.throws(
    () =>
      contracts.runtime({
        id: 'r',
        revision: 1,
        name: 'Runtime',
        engine: 'custom',
        capabilities: { schema: { threads: { min: 'one' } } },
      }),
    /schema.threads.min/,
  );
  assert.throws(
    () =>
      contracts.host({
        gpus: [{ index: 0, name: 'GPU', free_mib: 'unknown' }],
      }),
    /free_mib/,
  );
  assert.throws(() => contracts.jsonObject({ context: undefined }), /context/);
  assert.throws(
    () => contracts.jsonObject({ context: Number.NaN }),
    /finite number/,
  );
  assert.throws(() => contracts.stringArray({ flag: true }), /array/);
  assert.throws(() => contracts.stringArray(['--threads', 8]), /\[1\]/);
  assert.throws(
    () => contracts.environment({ OMP_NUM_THREADS: 8 }),
    /OMP_NUM_THREADS/,
  );
});

test('absent fields and nullable telemetry remain distinct', () => {
  const host = contracts.host({
    gpus: [{ index: 0, name: 'Unavailable GPU', free_mib: null }],
    pressure: false,
  });
  assert.equal(host.gpus?.[0].free_mib, null);
  assert.equal('used_mib' in host.gpus![0], false);
  assert.equal('cpu_count' in host, false);
  assert.deepEqual(
    contracts.host({ errors: ['No GPU telemetry'], gpus: [] }).gpus,
    [],
  );
  assert.throws(() => contracts.status({}), /version/);
});

test('catalog extension fields survive decoding and editor projection without server-owned revision fields', () => {
  const saved = contracts.profile({
    id: 'profile',
    revision: 4,
    name: 'Profile',
    artifact_id: 'm',
    runtime_id: 'r',
    config: { 'vendor-control': { enabled: true } },
    raw_args: ['--custom'],
    catalog: {
      vendor: { keep: true },
      model: {
        compatibility: { reasoningField: 'reasoning_content' },
        variants: [{ id: 'custom', body: { vendor_budget: 123 } }],
      },
    },
  });
  const draft = editable('profiles', saved);
  assert.deepEqual(draft.catalog, saved.catalog);
  assert.deepEqual(draft.config, saved.config);
  assert.equal('revision' in draft, false);
  const deployment = contracts.deployment({
    id: 'd',
    revision: 1,
    name: 'Deployment',
    enabled: true,
    state: 'STOPPED',
    alias: 'model',
    profile_snapshot: saved,
  });
  const edited = editable('deployments', deployment);
  assert.equal('revision' in edited.configuration!, false);
  assert.equal('id' in edited.configuration!, false);
  assert.deepEqual(edited.configuration?.catalog, saved.catalog);
  assert.equal(saved.revision, 4);
});

test('serving groups have a distinct contract from single-model deployments', () => {
  const member = {
    id: 'd',
    revision: 1,
    name: 'Model',
    alias: 'model',
    state: 'STOPPED',
    enabled: true,
  };
  const group = contracts.servingDeployment({
    id: 'g',
    revision: 1,
    name: 'Group',
    state: 'STOPPED',
    enabled: true,
    multi_model: true,
    members: [member],
    member_ids: ['d'],
  });
  assert.equal(group.multi_model, true);
  assert.equal('alias' in group, false);
  assert.equal(group.members[0].alias, 'model');
  assert.throws(
    () => contracts.servingDeployment({ ...group, multi_model: false }),
    /alias/,
  );
});

test('known event payloads are checked and unknown event kinds retain their data', () => {
  const state = contracts.operationEvent({
    seq: 1,
    ts: 10,
    kind: 'state',
    deployment_id: null,
    data: { to: 'READY', reason: null },
  });
  assert.deepEqual(contracts.eventPayload(state), {
    kind: 'state',
    to: 'READY',
    reason: null,
  });
  assert.throws(
    () => contracts.operationEvent({ ...state, data: { to: [] } }),
    /to/,
  );
  const future = contracts.operationEvent({
    seq: 2,
    ts: 11,
    kind: 'future_feature',
    data: { nested: [1, 2] },
  });
  assert.deepEqual(contracts.eventPayload(future), {
    kind: 'other',
    value: { nested: [1, 2] },
  });
});

test('metadata accessors accept numeric legacy values but ignore invalid limits', () => {
  assert.deepEqual(
    artifactLimits({
      architecture: 'llama',
      metadata: {
        'llama.context_length': '32768',
        config: { num_hidden_layers: 32 },
      },
    }),
    { context: 32768, layers: 32 },
  );
  assert.deepEqual(
    artifactLimits({
      metadata: {
        config: { max_position_embeddings: -1, num_hidden_layers: [] },
      },
    }),
    { context: undefined, layers: undefined },
  );
  assert.deepEqual(artifactLimits({ metadata: { config: null } }), {
    context: undefined,
    layers: undefined,
  });
});
