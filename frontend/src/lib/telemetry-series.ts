import type { HostSnapshot } from '../types/index.ts';

/** Only use a runtime-reported decode gauge. Never substitute request tokens/latency. */
export function outputRate(
  sample: HostSnapshot,
  deploymentId?: string,
): number | null {
  const ids = deploymentId
    ? [deploymentId]
    : Object.keys(sample.deployments || {});
  if (!ids.length) return null;
  const rates = ids.map((id) => {
    const entries = Object.entries(sample.runtime_metrics?.[id] || {});
    const reported = entries.find(
      ([key]) =>
        key.split('{')[0] === 'llamacpp:predicted_tokens_seconds' ||
        key.split('{')[0] === 'llama:predicted_tokens_seconds',
    );
    return reported && Number.isFinite(reported[1]) && reported[1] >= 0
      ? reported[1]
      : null;
  });
  return rates.some((rate) => rate === null)
    ? null
    : rates.reduce<number>((sum, rate) => sum + (rate ?? 0), 0);
}

/** Break lines at missing samples and telemetry gaps; timestamps stay quantitative. */
export function seriesPaths(
  points: { ts: number; value: number | null }[],
  start: number,
  end: number,
  max: number,
  interval: number,
) {
  let previous: number | null = null;
  return points
    .map((p) => {
      if (p.value === null || !Number.isFinite(p.value)) {
        previous = null;
        return '';
      }
      const command =
        previous === null || p.ts - previous > interval * 3 ? 'M' : 'L';
      previous = p.ts;
      return `${command}${40 + ((p.ts - start) / Math.max(1, end - start)) * 720},${150 - (p.value / Math.max(1, max)) * 130}`;
    })
    .join(' ');
}
