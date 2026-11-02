import {
  Bar,
  BarChart,
  ReferenceLine,
  ReferenceArea,
  XAxis,
  YAxis,
  Cell,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import {
  capacityAccounting,
  allocationColor,
  type Allocation,
} from '@/lib/capacity-accounting';
import { memory, memoryTick } from '@/lib/formatters';

export function CapacityBar({
  budget,
  physical = budget,
  components,
  selection,
  onSelect,
  boundaryLabel = 'Budget',
}: {
  budget: number;
  physical?: number;
  components: Allocation[];
  selection?: string;
  onSelect?: (id: string) => void;
  boundaryLabel?: string;
}) {
  const accounting = capacityAccounting(budget, components);
  const tiles = accounting.tiles;
  const config = Object.fromEntries(
    tiles.map((t, i) => [
      `s${i}`,
      { label: t.label, color: allocationColor(t) },
    ]),
  );
  const data = [
    {
      pool: 'Memory',
      ...Object.fromEntries(tiles.map((t, i) => [`s${i}`, t.mib])),
    },
  ];
  const maximum = Math.max(1, physical, accounting.demand);
  return (
    <ChartContainer
      config={config}
      className="h-28 w-full aspect-auto"
      aria-label="Memory capacity"
    >
      <BarChart
        accessibilityLayer
        layout="vertical"
        data={data}
        margin={{ top: 22, right: 28, bottom: 8, left: 28 }}
      >
        <XAxis
          type="number"
          domain={[0, maximum]}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => memoryTick(v, maximum)}
        />
        <YAxis type="category" dataKey="pool" hide />
        {physical > budget && (
          <ReferenceArea
            x1={budget}
            x2={physical}
            fill="var(--muted)"
            fillOpacity={0.7}
          />
        )}
        <ChartTooltip
          content={
            <ChartTooltipContent
              hideLabel
              formatter={(value, name) => (
                <span className="flex w-full justify-between gap-4">
                  <span>{name}</span>
                  <span className="tabular-nums">{memory(Number(value))}</span>
                </span>
              )}
            />
          }
        />
        {tiles.map((tile, i) => (
          <Bar
            key={tile.id}
            dataKey={`s${i}`}
            stackId="memory"
            fill={`var(--color-s${i})`}
            isAnimationActive={false}
            onClick={() => onSelect?.(tile.group || tile.id)}
          >
            <Cell
              opacity={
                !selection || selection === (tile.group || tile.id) ? 1 : 0.35
              }
            />
          </Bar>
        ))}
        <ReferenceLine
          x={budget}
          stroke="var(--foreground)"
          strokeDasharray="3 3"
          label={{
            value: boundaryLabel,
            position: 'top',
            fill: 'var(--muted-foreground)',
            fontSize: 11,
          }}
        />
        {physical > budget && (
          <ReferenceLine
            x={physical}
            stroke="var(--muted-foreground)"
            label={{
              value: 'Capacity',
              position: 'insideTopRight',
              fill: 'var(--muted-foreground)',
              fontSize: 11,
            }}
          />
        )}
      </BarChart>
    </ChartContainer>
  );
}
