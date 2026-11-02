import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadProgress } from '../src/lib/download-progress.ts';

const job = {
  id: 'download',
  revision: 1,
  name: 'Example weights',
  state: 'RUNNING',
  created_at: 1,
};
test('download byte facts support legacy reports without guessing totals or rates', () => {
  const legacy = downloadProgress({
    ...job,
    progress: 'downloading bytes: 2,714,130,528 / 5887667808 B',
  });
  assert.equal(legacy?.done, 2714130528);
  assert.equal(legacy?.total, 5887667808);
  assert.equal(Math.floor(legacy!.percent!), 46);
  assert.equal(legacy?.rate, null);
  assert.equal(
    downloadProgress({ ...job, progress: 'Downloading: 12 / ? B' })?.percent,
    null,
  );
  assert.equal(
    downloadProgress({ ...job, progress: 'Downloading: 2 / 4 files' }),
    null,
  );
  assert.equal(
    downloadProgress({ ...job, transfer: { done_bytes: -1 } }),
    null,
  );
  assert.equal(
    downloadProgress({ ...job, transfer: { done_bytes: 12, total_bytes: 10 } })
      ?.percent,
    null,
  );
  assert.equal(
    downloadProgress({ ...job, transfer: { done_bytes: 0, total_bytes: 100 } })
      ?.percent,
    0,
  );
  assert.equal(
    downloadProgress({
      ...job,
      transfer: { done_bytes: 50, total_bytes: 100, rate_bytes_per_second: 10 },
    })?.rate,
    10,
  );
});
