import {
  Bar,
  BarChart,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { memory, memoryTick, timestamp } from '@/lib/formatters';
import type { ResourceHistoryGroup } from '@/types';
import { ChartEmptyState } from './chart-empty-state';

export function RunPeaks({
  group,
  pool,
}: {
  group: ResourceHistoryGroup;
  pool: 'gpu' | 'ram';
}) {
  const field = pool === 'gpu' ? 'peak_gpu_mib' : 'peak_ram_mib';
  const data = [...group.runs].reverse().map((run) => ({
    started: run.started_at,
    peak: run[field],
    outcome: run.outcome,
  }));
  const label = pool === 'gpu' ? 'GPU run peaks' : 'RAM run peaks';
  const mean = group[pool].mean_peak_mib;
  return (
    <section>
      <h4>{label}</h4>
      {group[pool].sample_count === 0 ? (
        <ChartEmptyState />
      ) : (
        <ChartContainer
          config={{ peak: { label: 'Peak', color: 'var(--chart-2)' } }}
          className="h-44 w-full aspect-auto"
          aria-label={label}
        >
          <BarChart
            accessibilityLayer
            data={data}
            margin={{ left: 0, right: 12, top: 16 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="started"
              tickLine={false}
              axisLine={false}
              minTickGap={36}
              tickFormatter={(value) =>
                group.last_run_at - group.first_run_at < 86400
                  ? new Date(value * 1000).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : new Date(value * 1000).toLocaleDateString()
              }
            />
            <YAxis
              width={64}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) =>
                memoryTick(value, group[pool].max_peak_mib ?? 0)
              }
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    timestamp(payload[0]?.payload?.started)
                  }
                  formatter={(value, _, item) => (
                    <span>
                      {memory(Number(value))} · {item.payload.outcome}
                    </span>
                  )}
                />
              }
            />
            <Bar
              dataKey="peak"
              fill="var(--color-peak)"
              isAnimationActive={false}
            />
            {mean !== null && (
              <ReferenceLine
                y={mean}
                stroke="var(--foreground)"
                strokeDasharray="3 3"
                label={{
                  value: 'Mean',
                  position: 'insideTopRight',
                  fill: 'var(--muted-foreground)',
                  fontSize: 11,
                }}
              />
            )}
          </BarChart>
        </ChartContainer>
      )}
    </section>
  );
}
