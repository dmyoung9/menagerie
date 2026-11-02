import type { Job } from '../types/index.ts';

/** Older running daemons only publish tqdm text. Keep that byte-only fallback bounded. */
export function downloadProgress(job: Job) {
  const legacy = job.progress?.match(
    /^downloading(?: bytes)?:\s*([\d,]+)\s*\/\s*([\d,]+|\?)\s*B$/i,
  );
  const transfer =
    job.transfer ??
    (legacy
      ? {
          done_bytes: Number(legacy[1].replaceAll(',', '')),
          total_bytes:
            legacy[2] === '?' ? null : Number(legacy[2].replaceAll(',', '')),
        }
      : null);
  if (
    !transfer ||
    !Number.isFinite(transfer.done_bytes) ||
    transfer.done_bytes < 0
  )
    return null;
  const total = transfer.total_bytes;
  const known =
    typeof total === 'number' &&
    Number.isFinite(total) &&
    total > 0 &&
    total >= transfer.done_bytes;
  const rate =
    'rate_bytes_per_second' in transfer ? transfer.rate_bytes_per_second : null;
  return {
    done: transfer.done_bytes,
    total: known ? total : null,
    percent: known ? (transfer.done_bytes / total) * 100 : null,
    rate:
      typeof rate === 'number' && Number.isFinite(rate) && rate > 0
        ? rate
        : null,
  };
}
