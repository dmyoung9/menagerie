import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaults } from '../src/editor-state.ts';
import { deploymentDraft, deploymentSetDraft } from '../src/contracts.ts';

test('new deployments omit tuning and GPU selection; pool configuration survives decoding', () => {
  assert.deepEqual(defaults.profiles.config, {});
  assert.equal(defaults.deployments.gpu, null);
  const member = deploymentDraft({
    ...defaults.deployments,
    configuration: defaults.profiles,
  });
  assert.equal(member.gpu, null);
  const pool = deploymentSetDraft({
    name: 'Pool',
    engine_pool: true,
    max_loaded: 2,
    residency: 'on-demand',
    priority: 50,
    idle_timeout: 60,
    enabled: true,
    allow_eviction: true,
    queue_timeout: 300,
    members: [member],
  });
  assert.equal(pool.engine_pool, true);
  assert.equal(pool.max_loaded, 2);
  assert.deepEqual(pool.members[0].configuration!.config, {});
});
