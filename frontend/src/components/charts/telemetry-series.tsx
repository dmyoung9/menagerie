import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  memory,
  percent,
  temperature,
  tokenRate,
  watts,
} from '@/lib/formatters';
import { outputRate } from '@/lib/telemetry-series';
import { readApi, message, number } from '@/ui';
import { array } from '@/decode';
import { host as hostContract } from '@/contracts';
import type { HostSnapshot, Deployment } from '@/types';
import { TrendChart } from './trend-chart';

export function TimeWindow({
  minutes,
  change,
}: {
  minutes: number;
  change: (value: number) => void;
}) {
  return (
    <NativeSelect
      aria-label="Telemetry time window"
      value={minutes}
      onChange={(e) => change(Number(e.target.value))}
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
  );
}

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
  const [minutes, setMinutes] = useState(15),
    [deploymentId, setDeployment] = useState('');
  const [history, setHistory] = useState<HostSnapshot[]>([]),
    [error, setError] = useState('');
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
        .filter((s) => s.ts != null)
        .map((s) => [s.ts!, s]),
    ).values(),
  ].sort((a, b) => a.ts! - b.ts!);
  const latest = merged.at(-1),
    end = latest?.ts ?? 0;
  const visible = merged.filter((s) => s.ts! >= end - minutes * 60);
  const sampleInterval = Math.max(interval, (minutes * 60) / 500);
  const gpus = [
    ...new Map(
      merged.flatMap((s) => s.gpus || []).map((g) => [g.index, g]),
    ).values(),
  ].sort((a, b) => a.index - b.index);
  const gpuLines = gpus.map((g) => ({
    key: `g${g.index}`,
    label: `GPU ${g.index} · ${g.name}`,
    color: `var(--chart-${(g.index % 5) + 1})`,
  }));
  const gpuPoints = (key: 'used_mib' | 'utilization' | 'temperature') =>
    visible.map((s) => ({
      ts: s.ts!,
      ...Object.fromEntries(
        gpus.map((g) => [
          `g${g.index}`,
          s.gpus?.find((v) => v.index === g.index)?.[key] ?? null,
        ]),
      ),
    }));
  const singleLine = [
    { key: 'value', label: 'Observed', color: 'var(--chart-1)' },
  ];
  return (
    <>
      <div className="section-heading">
        <h2>Live resource trends</h2>
        <TimeWindow minutes={minutes} change={setMinutes} />
      </div>
      {error && <p role="status">History unavailable: {error}</p>}
      <Card className="mb-5 min-w-0">
        <CardHeader>
          <CardTitle>GPU</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="metric-strip">
            {(latest?.gpus || []).map((g) => (
              <div key={g.index}>
                <dt>GPU {g.index} power</dt>
                <dd>{watts(g.power_w)}</dd>
              </div>
            ))}
          </dl>
          <div className="resource-grid">
            <TrendChart
              label="GPU memory"
              points={gpuPoints('used_mib')}
              format={memory}
              interval={sampleInterval}
              lines={gpuLines.map((l, i) => ({
                ...l,
                capacity: gpus[i].total_mib ?? undefined,
              }))}
            />
            <TrendChart
              label="GPU activity"
              points={gpuPoints('utilization')}
              lines={gpuLines}
              format={percent}
              maximum={100}
              interval={sampleInterval}
            />
            <TrendChart
              label="GPU temperature"
              points={gpuPoints('temperature')}
              lines={gpuLines}
              format={temperature}
              limit={temperatureLimit}
              interval={sampleInterval}
            />
          </div>
          <a href="#/settings/history/samples">View sample table</a>
        </CardContent>
      </Card>
      <Card className="mb-5 min-w-0">
        <CardHeader>
          <CardTitle>CPU & RAM</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="metric-strip">
            <div>
              <dt>Disk free</dt>
              <dd>
                {latest?.disk_free_gib == null
                  ? '—'
                  : `${number(latest.disk_free_gib)} GiB`}
              </dd>
            </div>
            <div>
              <dt>Swap used</dt>
              <dd>{memory(latest?.swap_used_mib)}</dd>
            </div>
          </dl>
          <div className="resource-grid">
            <TrendChart
              label="System RAM used"
              points={visible.map((s) => ({
                ts: s.ts!,
                value:
                  s.ram_total_mib != null && s.ram_available_mib != null
                    ? s.ram_total_mib - s.ram_available_mib
                    : null,
              }))}
              lines={[{ ...singleLine[0], capacity: latest?.ram_total_mib }]}
              format={memory}
              interval={sampleInterval}
            />
            <TrendChart
              label="CPU activity"
              points={visible.map((s) => ({
                ts: s.ts!,
                value: s.cpu_percent ?? null,
              }))}
              lines={singleLine}
              format={percent}
              maximum={100}
              interval={sampleInterval}
            />
          </div>
          <a href="#/settings/history/samples">View sample table</a>
        </CardContent>
      </Card>
      <Card className="mb-5 min-w-0">
        <CardHeader>
          <CardTitle>Inference throughput</CardTitle>
        </CardHeader>
        <CardContent>
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
          <TrendChart
            label="Decode throughput"
            points={visible.map((s) => ({
              ts: s.ts!,
              value: outputRate(s, deploymentId || undefined),
            }))}
            lines={singleLine}
            format={tokenRate}
            interval={sampleInterval}
          />
        </CardContent>
      </Card>
    </>
  );
}
