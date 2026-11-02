import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { ChartEmptyState } from './chart-empty-state';
import { timestamp } from '@/lib/formatters';

export type TrendLine = {
  key: string;
  label: string;
  color: string;
  capacity?: number;
};
export type TrendPoint = { ts: number; [key: string]: number | string | null };

export function TrendChart({
  label,
  points,
  lines,
  format,
  maximum,
  limit,
  interval = 2,
}: {
  label: string;
  points: TrendPoint[];
  lines: TrendLine[];
  format: (value: unknown) => string;
  maximum?: number;
  limit?: number;
  interval?: number;
}) {
  const data: TrendPoint[] = [];
  for (const point of points) {
    const previous = data.at(-1);
    if (
      previous &&
      (point.ts - previous.ts > interval * 3 || point.run !== previous.run)
    )
      data.push({
        ts: previous.ts + 0.001,
        ...Object.fromEntries(lines.map((l) => [l.key, null])),
      });
    data.push(point);
  }
  const known = points.some((p) =>
    lines.some((l) => typeof p[l.key] === 'number'),
  );
  return (
    <section className="resource-card">
      <h3>{label}</h3>
      {known ? (
        <ChartContainer
          className="h-52 w-full aspect-auto"
          aria-label={label}
          config={Object.fromEntries(
            lines.map((l) => [l.key, { label: l.label, color: l.color }]),
          )}
        >
          <LineChart
            accessibilityLayer
            data={data}
            margin={{ left: 8, right: 20, top: 12 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tickLine={false}
              axisLine={false}
              minTickGap={45}
              tickFormatter={(v) =>
                (points.at(-1)?.ts ?? 0) - (points[0]?.ts ?? 0) >= 86400
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
              width={78}
              domain={[0, maximum ?? 'auto']}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => format(v)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    timestamp(payload[0]?.payload?.ts)
                  }
                  formatter={(value, name) => (
                    <span>
                      {lines.find((l) => l.key === name)?.label ?? name}:{' '}
                      {format(Number(value))}
                    </span>
                  )}
                />
              }
            />
            {lines
              .filter((l) => l.capacity != null)
              .map((l) => (
                <ReferenceLine
                  key={l.key}
                  y={l.capacity}
                  ifOverflow="extendDomain"
                  stroke={l.color}
                  strokeDasharray="3 3"
                  label={{
                    value: `${l.label} capacity`,
                    position: 'insideTopRight',
                    fill: 'var(--muted-foreground)',
                    fontSize: 10,
                  }}
                />
              ))}
            {limit != null && (
              <ReferenceLine
                y={limit}
                ifOverflow="extendDomain"
                stroke="var(--muted-foreground)"
                strokeDasharray="3 3"
                label={{
                  value: format(limit),
                  position: 'insideTopRight',
                  fill: 'var(--muted-foreground)',
                  fontSize: 11,
                }}
              />
            )}
            {lines.map((l) => (
              <Line
                key={l.key}
                dataKey={l.key}
                type="linear"
                stroke={`var(--color-${l.key})`}
                strokeWidth={2}
                dot={points.length < 10 ? { r: 2 } : false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      ) : (
        <ChartEmptyState />
      )}
      <ul className="chart-legend" aria-label={`${label} legend`}>
        {lines.map((l) => (
          <li key={l.key}>
            <i style={{ background: l.color }} aria-hidden="true" />
            <span>{l.label}</span>
            <strong>{format(points.at(-1)?.[l.key])}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
