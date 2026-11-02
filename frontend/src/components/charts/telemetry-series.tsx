import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
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
  memoryTick,
} from '@/lib/formatters';
import { outputRate } from '@/lib/telemetry-series';
import { readApi, message } from '@/ui';
import { array } from '@/decode';
import { host as hostContract } from '@/contracts';
import type { HostSnapshot, Deployment } from '@/types';
import { ChartEmptyState } from './chart-empty-state';

export function TelemetrySeries({
  samples,
  deployments,
  interval,
  temperatureLimit,
}: {
  samples: HostSnapshot[];
  deployments: Deployment[];
  interval: number;
  temperatureLimit?: number;
}) {
  const [minutes, setMinutes] = useState(15);
  const [gpuIndex, setGpu] = useState(0);
  const [deploymentId, setDeployment] = useState('');
  const [history, setHistory] = useState<HostSnapshot[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    readApi(
      `/api/history/metrics?hours=${Math.max(1, Math.ceil(minutes / 60))}`,
      array(hostContract),
    )
      .then((rows) => {
        if (alive) {
          setHistory(rows);
          setError('');
        }
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [minutes]);
  const merged = [
    ...new Map(
      [...history, ...samples]
        .filter((s) => s.ts !== undefined)
        .map((s) => [s.ts!, s]),
    ).values(),
  ].sort((a, b) => a.ts! - b.ts!);
  const end = merged.at(-1)?.ts ?? 0;
  const start = end - minutes * 60;
  const visible = merged.filter((s) => s.ts! >= start);
  const gpus = merged.at(-1)?.gpus || [];
  const gpu = gpus.some((g) => g.index === gpuIndex)
    ? gpuIndex
    : (gpus[0]?.index ?? 0);
  const metrics: {
    label: string;
    value: (s: HostSnapshot) => number | null | undefined;
    format: (v: unknown) => string;
    capacity?: number;
    limit?: number;
    percent?: boolean;
    area?: boolean;
  }[] = [
    {
      label: `GPU ${gpu} memory`,
      value: (s) => s.gpus?.find((g) => g.index === gpu)?.used_mib,
      format: memory,
      capacity: gpus.find((g) => g.index === gpu)?.total_mib ?? undefined,
      area: true,
    },
    {
      label: `GPU ${gpu} activity`,
      value: (s) => s.gpus?.find((g) => g.index === gpu)?.utilization,
      format: percent,
      percent: true,
    },
    {
      label: `GPU ${gpu} temperature`,
      limit: temperatureLimit,
      value: (s) => s.gpus?.find((g) => g.index === gpu)?.temperature,
      format: temperature,
    },
    {
      label: 'System RAM used',
      value: (s) =>
        s.ram_total_mib != null && s.ram_available_mib != null
          ? s.ram_total_mib - s.ram_available_mib
          : null,
      format: memory,
      capacity: merged.at(-1)?.ram_total_mib,
      area: true,
    },
    {
      label: 'CPU activity',
      value: (s) => s.cpu_percent,
      format: percent,
      percent: true,
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
      </CardHeader>
      <CardContent>
        <div className="toolbar">
          <NativeSelect
            aria-label="Telemetry time window"
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          >
            {[
              [5, '5 minutes'],
              [15, '15 minutes'],
              [60, '1 hour'],
              [1440, '24 hours'],
              [10080, '7 days'],
            ].map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Telemetry GPU"
            value={gpu}
            onChange={(e) => setGpu(Number(e.target.value))}
          >
            {gpus.length ? (
              gpus.map((g) => (
                <NativeSelectOption key={g.index} value={g.index}>
                  GPU {g.index} · {g.name}
                </NativeSelectOption>
              ))
            ) : (
              <NativeSelectOption value={0}>No GPU</NativeSelectOption>
            )}
          </NativeSelect>
          <NativeSelect
            aria-label="Throughput deployment"
            value={deploymentId}
            onChange={(e) => setDeployment(e.target.value)}
          >
            <NativeSelectOption value="">All deployments</NativeSelectOption>
            {deployments.map((d) => (
              <NativeSelectOption key={d.id} value={d.id}>
                {d.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {error && <p role="status">History unavailable: {error}</p>}
        <div className="resource-grid">
          {metrics.map((metric) => {
            const points: {
              ts: number;
              value: number | null;
              gap?: boolean;
            }[] = [];
            for (const sample of visible) {
              const previous = points.at(-1);
              if (
                previous &&
                sample.ts! - previous.ts >
                  Math.max(interval * 3, ((minutes * 60) / 500) * 3)
              )
                points.push({
                  ts: previous.ts + 0.001,
                  value: null,
                  gap: true,
                });
              points.push({
                ts: sample.ts!,
                value: metric.value(sample) ?? null,
              });
            }
            const known = points.filter((p) => p.value !== null);
            const Chart = metric.area ? AreaChart : LineChart;
            const domain: [number, number | 'auto'] = [
              0,
              metric.percent ? 100 : (metric.capacity ?? 'auto'),
            ];
            return (
              <section className="resource-card" key={metric.label}>
                <div className="section-heading">
                  <h3>{metric.label}</h3>
                  <strong className="tabular-nums" title={timestamp(end)}>
                    {metric.format(points.at(-1)?.value)}
                  </strong>
                </div>
                {!known.length ? (
                  <ChartEmptyState />
                ) : (
                  <>
                    <ChartContainer
                      config={{
                        value: { label: metric.label, color: 'var(--chart-1)' },
                      }}
                      className="h-48 w-full aspect-auto"
                      aria-label={metric.label}
                    >
                      <Chart
                        accessibilityLayer
                        data={points}
                        margin={{ left: 0, right: 16, top: 12 }}
                      >
                        <CartesianGrid vertical={false} />
                        <XAxis
                          type="number"
                          dataKey="ts"
                          domain={[start, end]}
                          scale="time"
                          tickLine={false}
                          axisLine={false}
                          minTickGap={40}
                          tickFormatter={(v) =>
                            minutes >= 1440
                              ? new Date(v * 1000).toLocaleDateString([], {
                                  month: 'short',
                                  day: 'numeric',
                                })
                              : new Date(v * 1000).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })
                          }
                        />
                        <YAxis
                          domain={domain}
                          width={64}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(v) =>
                            metric.area
                              ? memoryTick(
                                  v,
                                  metric.capacity ??
                                    Math.max(
                                      0,
                                      ...known.map((p) => p.value ?? 0),
                                    ),
                                )
                              : metric.percent
                                ? v + '%'
                                : String(v)
                          }
                        />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              labelFormatter={(_, payload) =>
                                timestamp(payload[0]?.payload?.ts)
                              }
                              formatter={(value) => (
                                <span className="tabular-nums">
                                  {metric.format(Number(value))}
                                </span>
                              )}
                            />
                          }
                        />
                        {metric.capacity !== undefined && (
                          <ReferenceLine
                            y={metric.capacity}
                            stroke="var(--muted-foreground)"
                            strokeDasharray="3 3"
                          />
                        )}
                        {metric.limit !== undefined && (
                          <ReferenceLine
                            y={metric.limit}
                            ifOverflow="extendDomain"
                            stroke="var(--muted-foreground)"
                            strokeDasharray="3 3"
                            label={{
                              value: temperature(metric.limit),
                              position: 'insideTopRight',
                              fill: 'var(--muted-foreground)',
                              fontSize: 11,
                            }}
                          />
                        )}
                        {metric.area ? (
                          <Area
                            dot={known.length <= 10 ? { r: 2 } : false}
                            type="linear"
                            dataKey="value"
                            stroke="var(--color-value)"
                            fill="var(--color-value)"
                            fillOpacity={0.15}
                            connectNulls={false}
                            isAnimationActive={false}
                          />
                        ) : (
                          <Line
                            type="linear"
                            dataKey="value"
                            stroke="var(--color-value)"
                            connectNulls={false}
                            dot={known.length <= 10 ? { r: 2 } : false}
                            isAnimationActive={false}
                          />
                        )}
                      </Chart>
                    </ChartContainer>
                    <details>
                      <summary>Samples</summary>
                      <ol className="telemetry-samples">
                        {points
                          .filter((p) => !p.gap)
                          .map((p) => (
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
