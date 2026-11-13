import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGroupRows,
  filterGroupRows,
  sortGroupRows,
  selectionToFiles,
  summaryFor,
  retryGroups,
  groupType,
  groupQuantization,
  classifyFileName,
  detectQuant,
} from '../src/repository-model.ts';
import type { RepositoryManifest } from '../src/types';

const manifest: RepositoryManifest = {
  repo: 'org/large-model',
  revision: '0123456789abcdef0123456789abcdef01234567',
  files: [
    {
      name: 'model-00001-of-00004.gguf',
      size: 4000,
      sha256: 'a',
      status: 'downloaded',
    },
    {
      name: 'model-00002-of-00004.gguf',
      size: 4000,
      sha256: 'b',
      status: 'not_downloaded',
    },
    {
      name: 'model-00003-of-00004.gguf',
      size: 4000,
      sha256: 'c',
      status: 'not_downloaded',
    },
    {
      name: 'model-00004-of-00004.gguf',
      size: 4000,
      sha256: 'd',
      status: 'failed',
    },
    {
      name: 'model.safetensors',
      size: 10000,
      sha256: 'e',
      status: 'downloaded',
    },
    { name: 'config.json', size: 12, sha256: 'f', status: 'downloaded' },
    { name: 'tokenizer.json', size: 13, sha256: 'g', status: 'not_downloaded' },
    { name: 'README.md', size: 9, sha256: 'h', status: 'downloaded' },
    {
      name: 'mmproj-00001.gguf',
      size: 800,
      sha256: 'i',
      status: 'not_downloaded',
    },
    { name: 'unknown.bin', size: null, sha256: 'j', status: 'not_downloaded' },
  ],
  groups: [
    {
      id: 'gguf-model-4',
      name: 'model',
      kind: 'gguf_split',
      required: [
        'model-00001-of-00004.gguf',
        'model-00002-of-00004.gguf',
        'model-00003-of-00004.gguf',
        'model-00004-of-00004.gguf',
      ],
      complete: true,
      local_status: {
        'model-00001-of-00004.gguf': 'downloaded',
        'model-00002-of-00004.gguf': 'not_downloaded',
        'model-00003-of-00004.gguf': 'not_downloaded',
        'model-00004-of-00004.gguf': 'failed',
      },
      downloaded_count: 1,
      failed_count: 1,
      downloading_count: 0,
    },
    {
      id: 'bundle-main',
      name: 'main',
      kind: 'safetensors',
      required: ['model.safetensors'],
      complete: true,
      local_status: { 'model.safetensors': 'downloaded' },
      downloaded_count: 1,
      failed_count: 0,
      downloading_count: 0,
    },
    {
      id: 'mmproj-00001.gguf',
      name: 'mmproj-00001.gguf',
      kind: 'companion',
      required: ['mmproj-00001.gguf'],
      complete: true,
      local_status: { 'mmproj-00001.gguf': 'not_downloaded' },
      downloaded_count: 0,
      failed_count: 0,
      downloading_count: 0,
    },
    {
      id: 'config.json',
      name: 'config.json',
      kind: 'standalone',
      required: ['config.json'],
      complete: true,
      local_status: { 'config.json': 'downloaded' },
      downloaded_count: 1,
      failed_count: 0,
      downloading_count: 0,
    },
    {
      id: 'tokenizer.json',
      name: 'tokenizer.json',
      kind: 'standalone',
      required: ['tokenizer.json'],
      complete: true,
      local_status: { 'tokenizer.json': 'not_downloaded' },
      downloaded_count: 0,
      failed_count: 0,
      downloading_count: 0,
    },
    {
      id: 'README.md',
      name: 'README.md',
      kind: 'standalone',
      required: ['README.md'],
      complete: true,
      local_status: { 'README.md': 'downloaded' },
      downloaded_count: 1,
      failed_count: 0,
      downloading_count: 0,
    },
    {
      id: 'unknown.bin',
      name: 'unknown.bin',
      kind: 'standalone',
      required: ['unknown.bin'],
      complete: true,
      local_status: { 'unknown.bin': 'not_downloaded' },
      downloaded_count: 0,
      failed_count: 0,
      downloading_count: 0,
    },
    {
      id: 'bundle-missing',
      name: 'partially-declared',
      kind: 'safetensors',
      required: ['model.safetensors', 'missing-shard.safetensors'],
      complete: false,
      local_status: { 'model.safetensors': 'downloaded' },
      downloaded_count: 1,
      failed_count: 0,
      downloading_count: 0,
    },
  ],
};

test('group rows classify type, quantization, size, and status', () => {
  const rows = buildGroupRows(manifest);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // GGUF split: weights, unknown quant from stem, partial+failed status.
  assert.strictEqual(byId.get('gguf-model-4')!.type, 'Model weights');
  assert.strictEqual(byId.get('gguf-model-4')!.statusLabel, 'Failed');
  assert.strictEqual(byId.get('gguf-model-4')!.size, 16000);
  assert.strictEqual(byId.get('gguf-model-4')!.count, 4);
  // Safetensors bundle: weights, downloaded, size 10000.
  assert.strictEqual(byId.get('bundle-main')!.type, 'Model weights');
  assert.strictEqual(byId.get('bundle-main')!.statusLabel, 'Downloaded');
  assert.strictEqual(byId.get('bundle-main')!.size, 10000);
  // Companion projector.
  assert.strictEqual(
    byId.get('mmproj-00001.gguf')!.type,
    'Projector candidate',
  );
  assert.strictEqual(
    byId.get('mmproj-00001.gguf')!.statusLabel,
    'Not downloaded',
  );
  // Standalone config / tokenizer / docs / unknown.
  assert.strictEqual(byId.get('config.json')!.type, 'Configuration');
  assert.strictEqual(byId.get('tokenizer.json')!.type, 'Tokenizer');
  assert.strictEqual(byId.get('README.md')!.type, 'Documentation');
  assert.strictEqual(byId.get('unknown.bin')!.type, 'Other');
  // Declared-incomplete bundle still shows and size excludes the missing file
  // (unknown.bin has null size elsewhere; here missing-shard has no size entry).
  assert.strictEqual(byId.get('bundle-missing')!.complete, false);
  assert.strictEqual(byId.get('bundle-missing')!.statusLabel, '1/2 files');
});

test('quantization detection from file names', () => {
  assert.strictEqual(detectQuant('model-q4_k-00001-of-00002.gguf'), 'Q4_K');
  assert.strictEqual(detectQuant('model-Q5K.gguf'), 'Q5_K');
  assert.strictEqual(detectQuant('model-00001.gguf'), 'Unknown');
  assert.strictEqual(groupQuantization(manifest.groups[0]!), 'Unknown');
  const q4 = {
    ...manifest.groups[0]!,
    required: [
      'model-q4_k-00001-of-00004.gguf',
      'model-q4_k-00002-of-00004.gguf',
    ],
  };
  assert.strictEqual(
    groupQuantization(q4 as unknown as (typeof manifest.groups)[0]),
    'Q4_K',
  );
});

test('file type classification keeps unknowns as Other, never hides', () => {
  assert.strictEqual(classifyFileName('x.safetensors'), 'Model weights');
  assert.strictEqual(classifyFileName('mmproj.bin'), 'Other'); // no gguf suffix
  assert.strictEqual(classifyFileName('my_model.safetensors'), 'Model weights');
  assert.strictEqual(classifyFileName('README.md'), 'Documentation');
  assert.strictEqual(classifyFileName('random.bin'), 'Other');
});

test('filtering by type, quantization, status, and search', () => {
  const rows = buildGroupRows(manifest);
  const all = filterGroupRows(rows, {
    search: '',
    type: 'all',
    quantization: 'all',
    status: 'all',
  });
  assert.strictEqual(all.length, rows.length);
  const weights = filterGroupRows(rows, {
    search: '',
    type: 'Model weights',
    quantization: 'all',
    status: 'all',
  });
  // gguf split, bundle-main, and the declared-incomplete bundle-missing are
  // all Model weights; the projector, config, tokenizer and docs are not.
  assert.strictEqual(weights.length, 3);
  const docs = filterGroupRows(rows, {
    search: '',
    type: 'Documentation',
    quantization: 'all',
    status: 'all',
  });
  assert.strictEqual(docs.length, 1);
  const notdownloaded = filterGroupRows(rows, {
    search: '',
    type: 'all',
    quantization: 'all',
    status: 'not_downloaded',
  });
  // mmproj, tokenizer, unknown.bin, and the 1/2 bundle-missing; gguf is
  // "failed", not this.
  assert.strictEqual(notdownloaded.length, 4);
  const search = filterGroupRows(rows, {
    search: 'model',
    type: 'all',
    quantization: 'all',
    status: 'all',
  });
  assert.ok(search.some((r) => r.name === 'model'));
});

test('selectionToFiles expands bundles to sorted required file sets', () => {
  assert.deepEqual(
    selectionToFiles(manifest, ['mmproj-00001.gguf', 'gguf-model-4']),
    [
      'mmproj-00001.gguf',
      'model-00001-of-00004.gguf',
      'model-00002-of-00004.gguf',
      'model-00003-of-00004.gguf',
      'model-00004-of-00004.gguf',
    ],
  );
  // Order is independent of input selection order.
  assert.deepEqual(
    selectionToFiles(manifest, ['gguf-model-4', 'mmproj-00001.gguf']),
    selectionToFiles(manifest, ['mmproj-00001.gguf', 'gguf-model-4']),
  );
  assert.deepEqual(selectionToFiles(manifest, ['bundle-missing']), [
    'missing-shard.safetensors',
    'model.safetensors',
  ]);
});

test('summaryFor counts bytes, flags unknown sizes, and marks allDownloaded', () => {
  const s1 = summaryFor(manifest, ['mmproj-00001.gguf']);
  assert.strictEqual(s1.count, 1);
  assert.strictEqual(s1.size, 800);
  assert.strictEqual(s1.toDownload, 1);
  assert.strictEqual(s1.allDownloaded, false);
  const s2 = summaryFor(manifest, ['config.json']); // already downloaded
  assert.strictEqual(s2.allDownloaded, true);
  assert.strictEqual(s2.toDownload, 0);
  assert.strictEqual(s2.size, 0);
  // A selection with an unknown-size file reports null size.
  const s3 = summaryFor(manifest, ['unknown.bin']);
  assert.strictEqual(s3.size, null);
  assert.strictEqual(s3.toDownload, 1);
  const s4 = summaryFor(manifest, []);
  assert.strictEqual(s4.count, 0);
  assert.strictEqual(s4.allDownloaded, true);
});

test('retryGroups maps failed/missing files back to their bundle ids', () => {
  const ids = retryGroups(manifest, [
    'gguf-model-4',
    'config.json',
    'mmproj-00001.gguf',
  ]);
  assert.deepEqual(ids, ['gguf-model-4']);
  assert.deepEqual(retryGroups(manifest, ['bundle-main']), []);
  const s = summaryFor(manifest, ['gguf-model-4']);
  assert.strictEqual(s.retryFiles.length, 1); // the failed shard
});

test('sortGroupRows orders deterministically by file, size, status, quantization', () => {
  const rows = buildGroupRows(manifest);
  // file asc: case-insensitive name.
  const byFile = sortGroupRows(rows, 'file', 'asc');
  assert.deepEqual(
    byFile.map((r) => r.id),
    [
      'config.json',
      'bundle-main',
      'mmproj-00001.gguf',
      'gguf-model-4',
      'bundle-missing',
      'README.md',
      'tokenizer.json',
      'unknown.bin',
    ],
  );
  // size desc: largest first; unknown byte counts sink to the end.
  const bySize = sortGroupRows(rows, 'size', 'desc');
  assert.strictEqual(bySize[0].id, 'gguf-model-4'); // 16000 largest
  assert.strictEqual(bySize[0].size, 16000);
  assert.strictEqual(bySize[1].id, 'bundle-main'); // 10000
  assert.strictEqual(bySize[1].size, 10000);
  assert.ok(
    bySize.every(
      (r, i) => i === 0 || (bySize[i - 1].size ?? -1) >= (r.size ?? -1),
    ),
  );
  // The two groups with unknown byte counts are the last two.
  assert.strictEqual(bySize.at(-1)!.size, null);
  assert.strictEqual(bySize.at(-2)!.size, null);
  const nullIds = new Set(
    bySize.filter((r) => r.size === null).map((r) => r.id),
  );
  assert.deepEqual([...nullIds], ['unknown.bin', 'bundle-missing']);
  // status asc: not_downloaded … failed.
  const byStatus = sortGroupRows(rows, 'status', 'asc');
  assert.strictEqual(
    byStatus.map((r) => r.statusBucket).join(','),
    'not_downloaded,not_downloaded,not_downloaded,not_downloaded,downloaded,downloaded,downloaded,failed',
  );
});

test('status bucket and label for a partially downloaded bundle', () => {
  const partial = manifest.groups.find((g) => g.id === 'gguf-model-4')!;
  assert.strictEqual(partial.downloaded_count, 1);
  // bucket is "failed" because a shard failed (higher priority than partial)
  assert.strictEqual(
    groupType({ ...manifest.groups[0]!, name: 'x' }),
    'Model weights',
  );
});
