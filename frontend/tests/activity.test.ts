import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityEntries } from '../src/lib/activity.ts';
import type { OperationEvent, Job } from '../src/types/index.ts';

test('groups correlated lifecycle steps and job result without merging concurrent attempts', () => {
  const events: OperationEvent[] = [
    {
      seq: 1,
      ts: 1,
      kind: 'state',
      deployment_id: 'd',
      data: { operation_id: 'a', to: 'STARTING', session_id: 'run' },
    },
    {
      seq: 2,
      ts: 2,
      kind: 'state',
      deployment_id: 'd',
      data: { operation_id: 'b', to: 'VALIDATING' },
    },
    {
      seq: 3,
      ts: 3,
      kind: 'state',
      deployment_id: 'd',
      data: { operation_id: 'a', to: 'READY', session_id: 'run' },
    },
    {
      seq: 4,
      ts: 4,
      kind: 'job',
      deployment_id: 'd',
      data: {
        id: 'a',
        operation_id: 'a',
        state: 'SUCCEEDED',
        name: 'Load Example',
      },
    },
  ];
  const job: Job = {
    id: 'a',
    revision: 1,
    created_at: 1,
    state: 'SUCCEEDED',
    name: 'Load Example',
    deployment_id: 'd',
  };
  const result = activityEntries(events, [{ id: 'd', name: 'Example' }], [job]);
  assert.equal(result.length, 2);
  assert.equal(result[0].steps.length, 3);
  assert.equal(result[0].title, 'Load Example');
  assert.ok(result[0].links.some((l) => l.href.includes('run=run')));
});
test('pressure shows exact measurements; missing historical fields stay missing', () => {
  const rows = activityEntries(
    [
      { seq: 1, ts: 1, kind: 'pressure', data: { active: true } },
      {
        seq: 2,
        ts: 2,
        kind: 'pressure',
        data: {
          active: true,
          conditions: [
            {
              resource: 'GPU 1',
              metric: 'temperature',
              value: 90,
              threshold: 85,
              direction: 'above',
              unit: '°C',
            },
          ],
        },
      },
    ],
    [],
  );
  assert.equal(rows[0].title, 'GPU 1 temperature 90 °C above 85 °C');
  assert.equal(rows[1].title, '—');
  assert.equal(rows[0].state, 'Warning');
});
test('download entries identify their model and link to it', () => {
  const rows = activityEntries(
    [],
    [],
    [
      {
        id: 'download',
        revision: 1,
        created_at: 1,
        state: 'SUCCEEDED',
        operation: 'download',
        name: 'Download example/model · weights.gguf',
        result: { id: 'model' },
      },
    ],
  );
  assert.equal(rows[0].title, 'Download example/model · weights.gguf');
  assert.ok(rows[0].links.some((l) => l.href === '#/models/installed/model'));
});
test('legacy lifecycle boundaries batch steps, and legacy job IDs deduplicate', () => {
  const rows = activityEntries(
    [
      {
        seq: 1,
        ts: 1,
        kind: 'state',
        deployment_id: 'd',
        data: { from: 'STOPPED', to: 'VALIDATING' },
      },
      {
        seq: 2,
        ts: 2,
        kind: 'state',
        deployment_id: 'd',
        data: { from: 'VALIDATING', to: 'QUEUED' },
      },
      {
        seq: 3,
        ts: 3,
        kind: 'state',
        deployment_id: 'd',
        data: { from: 'QUEUED', to: 'STARTING' },
      },
      {
        seq: 4,
        ts: 4,
        kind: 'state',
        deployment_id: 'd',
        data: { from: 'STARTING', to: 'READY' },
      },
      {
        seq: 5,
        ts: 5,
        kind: 'state',
        deployment_id: 'd',
        data: { from: 'READY', to: 'STOPPING' },
      },
      {
        seq: 6,
        ts: 6,
        kind: 'state',
        deployment_id: 'd',
        data: { from: 'STOPPING', to: 'STOPPED' },
      },
      {
        seq: 7,
        ts: 7,
        kind: 'job',
        data: { id: 'legacy-job', state: 'SUCCEEDED' },
      },
    ],
    [{ id: 'd', name: 'Example' }],
    [
      {
        id: 'legacy-job',
        revision: 1,
        name: 'Refresh model templates',
        created_at: 1,
        state: 'SUCCEEDED',
      },
    ],
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'Refresh model templates');
  assert.equal(rows[1].steps.length, 2);
  assert.equal(rows[2].steps.length, 4);
});
