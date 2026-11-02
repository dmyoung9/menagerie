/** View-boundary formatters. Wire memory fields remain MiB; file sizes remain bytes. */
export const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
export const watts = (value: unknown) =>
  finite(value) ? `${Math.round(value)} W` : '—';
export function memory(mib: unknown): string {
  if (!finite(mib) || mib < 0) return '—';
  if (mib === 0) return '0 MiB';
  const unit = mib >= 1024 ** 2 ? 'TiB' : mib >= 1024 ? 'GiB' : 'MiB';
  const value = mib / (unit === 'TiB' ? 1024 ** 2 : unit === 'GiB' ? 1024 : 1);
  return `${value < 0.1 ? '<0.1' : value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;
}
export const bytes = (value: unknown) =>
  finite(value) ? memory(value / 1048576) : '—';

/** Use one unit throughout a chart axis without rounding nonzero values to zero. */
export function memoryTick(mib: number, extent: number) {
  const divisor = extent >= 1024 ** 2 ? 1024 ** 2 : extent >= 1024 ? 1024 : 1;
  const unit = divisor === 1024 ** 2 ? 'TiB' : divisor === 1024 ? 'GiB' : 'MiB';
  const value = mib / divisor;
  return `${value > 0 && value < 0.1 ? '<0.1' : value.toFixed(1)} ${unit}`;
}
export const percent = (value: unknown) =>
  finite(value) ? `${Math.round(value)}%` : '—';
export const temperature = (value: unknown) =>
  finite(value) ? `${Math.round(value)} °C` : '—';
export const tokens = (value: unknown) =>
  finite(value) ? `${value.toLocaleString()} tokens` : '—';
export const tokenRate = (value: unknown) =>
  finite(value) ? `${value.toFixed(1)} output tokens/s` : '—';
export const duration = (seconds: unknown) =>
  !finite(seconds) || seconds < 0
    ? '—'
    : seconds < 60
      ? `${Math.round(seconds)}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
        : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
export const timestamp = (seconds: unknown) =>
  finite(seconds) ? new Date(seconds * 1000).toLocaleString() : '—';
export const budgetLabel = (remaining: unknown) =>
  !finite(remaining)
    ? 'Accounting unavailable'
    : remaining < 0
      ? `${memory(-remaining)} over budget`
      : `${memory(remaining)} available`;
