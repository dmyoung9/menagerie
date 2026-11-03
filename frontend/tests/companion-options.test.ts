import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  companionOptions,
  hasEmbeddedMtp,
  selectMtp,
} from '../src/companion-options.ts';
import type { Artifact } from '../src/types/index.ts';

const model: Artifact = {
  id: 'target',
  revision: 1,
  name: 'Target MTP',
  format: 'gguf',
  architecture: 'example',
  repo: 'fixture/model',
  source_revision: 'a'.repeat(40),
  metadata: {
    'example.block_count': 32,
    'example.nextn_predict_layers': 1,
    projector: { name: 'Projector', path: '/models/projector.gguf' },
  },
};
const head: Artifact = {
  ...model,
  id: 'head',
  name: 'Draft head',
  local_path: '/models/head.gguf',
  metadata: { 'example.block_count': 1, 'example.nextn_predict_layers': 1 },
};

test('embedded MTP requires positive NextN metadata on a full GGUF, not a name or head-only file', () => {
  assert.equal(hasEmbeddedMtp(model), true);
  for (const candidate of [
    { ...model, metadata: {} },
    { ...model, format: 'safetensors' },
    head,
    {
      ...model,
      metadata: {
        'example.block_count': 32,
        'example.nextn_predict_layers': 0,
      },
    },
  ])
    assert.equal(hasEmbeddedMtp(candidate), false);
});

test('companions use pinned source and head metadata, never filename similarity alone', () => {
  const options = companionOptions(model, [
    head,
    { ...head, id: 'wrong-revision', source_revision: 'b'.repeat(40) },
    { ...head, id: 'wrong-repo', repo: 'fixture/other' },
    { ...head, id: 'wrong-arch', architecture: 'other' },
    { ...model, id: 'full-model', local_path: '/models/full.gguf' },
  ]);
  assert.deepEqual(options.heads, [
    { name: 'Draft head', path: '/models/head.gguf' },
  ]);
  assert.deepEqual(options.projectors, [
    { name: 'Projector', path: '/models/projector.gguf' },
  ]);
});

test('head selection clears stale draft aliases without discarding unrelated tuning', () => {
  const config = {
    'spec-draft-model': '/old.gguf',
    'model-draft': '/legacy.gguf',
    'spec-draft-n-max': 5,
    temp: 0.7,
  };
  assert.deepEqual(selectMtp(config, '', 'spec-draft-model'), {
    'spec-type': 'none',
    'spec-draft-n-max': 5,
    temp: 0.7,
  });
  assert.deepEqual(selectMtp(config, 'embedded', 'spec-draft-model'), {
    'spec-type': 'draft-mtp',
    'spec-draft-n-max': 5,
    temp: 0.7,
  });
  assert.deepEqual(selectMtp(config, '/new.gguf', 'model-draft'), {
    'spec-type': 'draft-mtp',
    'model-draft': '/new.gguf',
    'spec-draft-n-max': 5,
    temp: 0.7,
  });
});
