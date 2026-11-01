import { useState } from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  memory,
  percent,
  temperature,
  tokenRate,
  timestamp,
} from '@/lib/formatters';
import { outputRate, seriesPaths } from '@/lib/telemetry-series';
import type { HostSnapshot, Deployment } from '@/types';

export function TelemetrySeries({
  samples,
  deployments,
  interval,
}: {
  samples: HostSnapshot[];
  deployments: Deployment[];
  interval: number;
}) {
  const [windowMinutes, setWindow] = useState(15);
  const [gpuIndex, setGpu] = useState(0);
  const [deploymentId, setDeployment] = useState('');
  const end = samples.at(-1)?.ts ?? 0;
  const start = end - windowMinutes * 60;
  const visible = samples.filter((s) => s.ts !== undefined && s.ts >= start);
  const gpus = samples.at(-1)?.gpus || [];
  const metrics: {
    label: string;
    value: (s: HostSnapshot) => number | null | undefined;
    format: (v: unknown) => string;
    max?: number;
  }[] = [
    {
      label: `GPU ${gpuIndex} memory`,
      value: (s) => s.gpus?.find((g) => g.index === gpuIndex)?.used_mib,
      format: memory,
      max: gpus.find((g) => g.index === gpuIndex)?.total_mib ?? undefined,
    },
    {
      label: `GPU ${gpuIndex} activity`,
      value: (s) => s.gpus?.find((g) => g.index === gpuIndex)?.utilization,
      format: percent,
      max: 100,
    },
    {
      label: `GPU ${gpuIndex} temperature`,
      value: (s) => s.gpus?.find((g) => g.index === gpuIndex)?.temperature,
      format: temperature,
    },
    {
      label: 'System RAM used',
      value: (s) =>
        typeof s.ram_total_mib === 'number' &&
        typeof s.ram_available_mib === 'number'
          ? s.ram_total_mib - s.ram_available_mib
          : null,
      format: memory,
      max: samples.at(-1)?.ram_total_mib,
    },
    {
      label: 'CPU activity',
      value: (s) => s.cpu_percent,
      format: percent,
      max: 100,
    },
    {
      label: 'Decode throughput',
      value: (s) => outputRate(s, deploymentId || undefined),
      format: tokenRate,
    },
  ];
  return (
    <Card className="mb-5 min-w-0">
      <CardHeader>
        <CardTitle>Live resource trends</CardTitle>
        <CardDescription>
          Timestamped samples at the configured {interval}s interval. Gaps stay
          gaps. Decode throughput requires a runtime-reported gauge; unsupported
          engines show unavailable.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="toolbar">
          <NativeSelect
            aria-label="Telemetry time window"
            value={windowMinutes}
            onChange={(e) => setWindow(Number(e.target.value))}
          >
            <NativeSelectOption value={5}>5 minutes</NativeSelectOption>
            <NativeSelectOption value={15}>15 minutes</NativeSelectOption>
            <NativeSelectOption value={60}>
              1 hour (loaded samples)
            </NativeSelectOption>
          </NativeSelect>
          <NativeSelect
            aria-label="Telemetry GPU"
            value={gpuIndex}
            onChange={(e) => setGpu(Number(e.target.value))}
          >
            {gpus.map((g) => (
              <NativeSelectOption key={g.index} value={g.index}>
                GPU {g.index} · {g.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Throughput deployment"
            value={deploymentId}
            onChange={(e) => setDeployment(e.target.value)}
          >
            <NativeSelectOption value="">
              All measured deployments
            </NativeSelectOption>
            {deployments.map((d) => (
              <NativeSelectOption key={d.id} value={d.id}>
                {d.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="resource-grid">
          {metrics.map((metric) => {
            const points = visible.map((s) => ({
              ts: s.ts!,
              value: metric.value(s) ?? null,
            }));
            const values = points.flatMap((p) =>
              p.value === null ? [] : [p.value],
            );
            const max = metric.max ?? Math.max(1, ...values);
            return (
              <section className="resource-card" key={metric.label}>
                <h3>{metric.label}</h3>
                <p className="numeric">{metric.format(points.at(-1)?.value)}</p>
                {values.length < 2 ? (
                  <p className="muted">
                    Telemetry unavailable or collecting samples.
                  </p>
                ) : (
                  <>
                    <svg
                      className="chart telemetry-chart"
                      viewBox="0 0 800 175"
                      preserveAspectRatio="none"
                      role="img"
                      aria-label={`${metric.label}: ${metric.format(points.at(-1)?.value)}, ${windowMinutes} minute window`}
                    >
                      <line
                        x1="40"
                        x2="760"
                        y1="150"
                        y2="150"
                        stroke="var(--border)"
                      />
                      <path
                        d={seriesPaths(points, start, end, max, interval)}
                        fill="none"
                        stroke="var(--chart-1)"
                        strokeWidth="2"
                        vectorEffect="non-scaling-stroke"
                      />
                      {values.length < 10 &&
                        points
                          .filter((p) => p.value !== null)
                          .map((p) => (
                            <circle
                              key={p.ts}
                              cx={
                                40 +
                                ((p.ts - start) / Math.max(1, end - start)) *
                                  720
                              }
                              cy={150 - (p.value! / Math.max(1, max)) * 130}
                              r="3"
                              fill="var(--chart-1)"
                            />
                          ))}
                    </svg>
                    <div className="telemetry-axis">
                      <span>{new Date(start * 1000).toLocaleTimeString()}</span>
                      <span>{new Date(end * 1000).toLocaleTimeString()}</span>
                    </div>
                    <p className="muted">Scale: 0 – {metric.format(max)}</p>
                    <details>
                      <summary>Exact samples and timestamps</summary>
                      <ol className="telemetry-samples">
                        {points.map((p) => (
                          <li key={p.ts}>
                            <time title={new Date(p.ts * 1000).toISOString()}>
                              {timestamp(p.ts)}
                            </time>{' '}
                            · {metric.format(p.value)}
                          </li>
                        ))}
                      </ol>
                    </details>
                  </>
                )}
              </section>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
