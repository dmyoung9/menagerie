import { useEffect, useState } from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { TrendChart } from './charts/trend-chart';
import { TimeWindow } from './charts/telemetry-series';
import { memory, percent, finite } from '@/lib/formatters';
import { readApi, message } from '@/ui';
import { array } from '@/decode';
import { host } from '@/contracts';
import type { Deployment, HostSnapshot } from '@/types';

export function DeploymentPerformance({
  deployment,
}: {
  deployment: Deployment;
}) {
  const [minutes, setMinutes] = useState(1440),
    [samples, setSamples] = useState<HostSnapshot[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () =>
      readApi(
        `/api/deployments/${deployment.id}/performance?hours=${Math.max(1, Math.ceil(minutes / 60))}`,
        array(host),
      )
        .then((rows) => {
          if (alive) {
            setSamples(rows);
            setError('');
          }
        })
        .catch((e) => {
          if (alive) setError(message(e));
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [deployment.id, deployment.revision, minutes]);
  const rate = (s: HostSnapshot, tokens: string, seconds: string) => {
    const metrics = Object.entries(s.runtime_metrics?.[deployment.id] || {});
    const sum = (name: string) => {
      const entries = metrics.filter(
        ([key]) => key.split('{')[0].replace(/^(llamacpp|llama):/, '') === name,
      );
      return entries.length ? entries.reduce((n, [, v]) => n + v, 0) : null;
    };
    const count = sum(tokens),
      elapsed = sum(seconds);
    return count != null && elapsed != null && elapsed > 0
      ? count / elapsed
      : null;
  };
  const metrics = [
    {
      label: 'Prefill throughput',
      value: (s: HostSnapshot) =>
        rate(s, 'prompt_tokens_total', 'prompt_seconds_total'),
      format: (v: unknown) =>
        finite(v) ? `${v.toFixed(1)} prompt tokens/s` : '—',
    },
    {
      label: 'Generation throughput',
      value: (s: HostSnapshot) =>
        rate(s, 'tokens_predicted_total', 'tokens_predicted_seconds_total'),
      format: (v: unknown) =>
        finite(v) ? `${v.toFixed(1)} output tokens/s` : '—',
    },
    {
      label: 'Process RAM',
      value: (s: HostSnapshot) => s.deployments?.[deployment.id]?.rss_mib,
      format: memory,
    },
    {
      label: 'CPU activity',
      value: (s: HostSnapshot) => s.deployments?.[deployment.id]?.cpu_percent,
      format: percent,
      maximum: 100,
    },
  ];
  const cutoff = Date.now() / 1000 - minutes * 60;
  return (
    <Card className="mb-5 min-w-0">
      <CardHeader>
        <CardTitle>Performance</CardTitle>
        <CardDescription>
          Retained runs of this configuration. Throughput is the runtime average
          since loading.
        </CardDescription>
        <TimeWindow minutes={minutes} change={setMinutes} />
      </CardHeader>
      <CardContent>
        {error && <p role="alert">{error}</p>}
        <div className="resource-grid">
          {metrics.map((m) => (
            <TrendChart
              interval={Math.max(2, (minutes * 60) / 500)}
              key={m.label}
              label={m.label}
              format={m.format}
              maximum={m.maximum}
              points={samples
                .filter((s) => s.ts! >= cutoff)
                .map((s) => ({
                  ts: s.ts!,
                  value: m.value(s) ?? null,
                  run: s.deployments?.[deployment.id]?.session_id ?? null,
                }))}
              lines={[
                { key: 'value', label: m.label, color: 'var(--chart-1)' },
              ]}
            />
          ))}
        </div>
        <a
          href={`#/settings/history/runs/${deployment.profile_snapshot?.artifact_id || ''}`}
        >
          View individual runs
        </a>
      </CardContent>
    </Card>
  );
}
