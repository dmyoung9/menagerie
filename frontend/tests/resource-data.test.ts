import assert from 'node:assert/strict';
import test from 'node:test';
import { capacityAccounting } from '../src/lib/capacity-accounting.ts';
import {
  bytes,
  memory,
  percent,
  temperature,
  tokens,
  tokenRate,
  duration,
} from '../src/lib/formatters.ts';
import { outputRate, seriesPaths } from '../src/lib/telemetry-series.ts';
import { resourceEstimate, resourcePreview } from '../src/contracts.ts';

test('capacity composition never double counts overflow and keeps raw quantities', () => {
  for (const demand of [0, 5, 10, 17]) {
    const result = capacityAccounting(10, [
      { id: 'a', label: 'A', mib: demand },
    ]);
    assert.equal(
      result.tiles.reduce((sum, t) => sum + t.mib, 0),
      Math.max(10, demand),
    );
    assert.equal(result.over, Math.max(0, demand - 10));
    assert.equal(
      result.tiles
        .filter((t) => t.kind === 'overflow')
        .reduce((sum, t) => sum + t.mib, 0),
      result.over,
    );
  }
  const split = capacityAccounting(16, [
    { id: 'a', label: 'A', mib: 7 },
    { id: 'b', label: 'B', mib: 6 },
    { id: 'kv', label: 'KV', mib: 4 },
  ]);
  assert.deepEqual(
    split.tiles.map((t) => t.mib),
    [7, 6, 3, 1],
  );
  assert.equal(
    capacityAccounting(0, [{ id: 'a', label: 'A', mib: 3 }]).over,
    3,
  );
  assert.equal(
    capacityAccounting(-10, [
      { id: 'a', label: 'A', mib: -1 },
      { id: 'nan', label: 'NaN', mib: NaN },
    ]).total,
    0,
  );
});

test('IEC formatting distinguishes unavailable, zero and tiny nonzero quantities', () => {
  assert.equal(memory(null), 'Unavailable');
  assert.equal(memory(NaN), 'Unavailable');
  assert.equal(memory(-1), 'Unavailable');
  assert.equal(memory(0), '0 MiB');
  assert.equal(memory(0.001), '<0.1 MiB');
  assert.equal(memory(32), '32.0 MiB');
  assert.equal(bytes(1024 ** 3), '1.0 GiB');
  assert.equal(memory(1024 ** 2), '1.0 TiB');
  assert.equal(percent(99.7), '100%');
  assert.equal(temperature(71.5), '72 °C');
  assert.equal(tokens(32768), '32,768 tokens');
  assert.equal(tokenRate(42.64), '42.6 output tokens/s');
  assert.equal(duration(272), '4m 32s');
});

test('resource contracts accept partial facts and reject verdict/confidence-only responses', () => {
  const fact = {
    peak_mib: null,
    ram_mib: 0,
    file_size_bytes: 10,
    kv_mib: null,
    basis: 'unavailable',
    sample_count: 0,
    provenance: 'Missing metadata',
    profile_hash: 'synthetic',
  };
  assert.equal(resourceEstimate(fact).peak_mib, null);
  assert.throws(() =>
    resourceEstimate({ peak_mib: 10, confidence: 'low', reservation_mib: 12 }),
  );
  const preview = resourcePreview({
    members: [],
    gpus: [
      {
        index: 0,
        name: 'GPU A',
        total_mib: 8000,
        used_mib: null,
        free_mib: null,
        headroom_mib: 2000,
        draft_mib: null,
        remaining_mib: null,
        status: 'unavailable',
      },
      {
        index: 1,
        name: 'GPU B',
        total_mib: 16000,
        used_mib: 0,
        free_mib: 16000,
        headroom_mib: 2000,
        draft_mib: 0,
        remaining_mib: 14000,
        status: 'within_budget',
      },
    ],
    ram_available_mib: null,
    ram_headroom_mib: 4000,
    ram_draft_mib: null,
    ram_remaining_mib: null,
  });
  assert.deepEqual(
    preview.gpus.map((g) => g.total_mib),
    [8000, 16000],
  );
});

test('time series preserve missing samples and gaps; throughput is never guessed', () => {
  const path = seriesPaths(
    [
      { ts: 0, value: 0 },
      { ts: 2, value: 1 },
      { ts: 4, value: null },
      { ts: 6, value: 2 },
      { ts: 30, value: 3 },
    ],
    0,
    30,
    3,
    2,
  );
  assert.equal((path.match(/M/g) || []).length, 3);
  assert.equal((path.match(/L/g) || []).length, 1);
  assert.equal(
    outputRate({
      deployments: { a: {} },
      runtime_metrics: { a: { 'llamacpp:predicted_tokens_seconds': 12 } },
    }),
    12,
  );
  assert.equal(
    outputRate({
      deployments: { a: {}, b: {} },
      runtime_metrics: { a: { 'llamacpp:predicted_tokens_seconds': 12 } },
    }),
    null,
  );
  assert.equal(
    outputRate({
      deployments: { a: {} },
      runtime_metrics: { a: { generation_tokens_total: 9000 } },
    }),
    null,
  );
});
