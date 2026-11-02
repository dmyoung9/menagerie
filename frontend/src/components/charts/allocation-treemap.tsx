import { Treemap, type TreemapNode } from 'recharts';
import { ChartContainer } from '@/components/ui/chart';
import { Button } from '@/components/ui/button';
import {
  capacityAccounting,
  allocationColor,
  type Allocation,
} from '@/lib/capacity-accounting';
import { memory } from '@/lib/formatters';

function componentLabel(tile: Allocation) {
  return tile.group && tile.label.includes(' · ')
    ? tile.label.split(' · ').slice(1).join(' · ')
    : tile.label;
}

export function AllocationTreemap({
  budget,
  components,
  selection,
  onSelect,
  title,
}: {
  budget: number;
  components: Allocation[];
  selection?: string;
  onSelect: (id: string) => void;
  title: string;
}) {
  const a = capacityAccounting(budget, components);
  const hierarchy = (tiles: Allocation[]) => {
    const groups = new Map<string, Allocation[]>();
    tiles.forEach((tile) => {
      const key = tile.group || tile.label;
      groups.set(key, [...(groups.get(key) || []), tile]);
    });
    return [...groups].map(([key, children]) => ({
      name: children[0].label.split(' · ')[0],
      key,
      children: children.map((t) => ({ ...t, name: t.label, value: t.mib })),
    }));
  };
  const data =
    a.over > 0
      ? [
          {
            name: 'Within budget',
            children: hierarchy(a.tiles.filter((t) => t.kind !== 'overflow')),
          },
          {
            name: 'Over budget',
            children: hierarchy(a.tiles.filter((t) => t.kind === 'overflow')),
          },
        ]
      : hierarchy(a.tiles);
  const node = (n: TreemapNode) => {
    if (!n.value) return <g />;
    if (n.children)
      return n.depth > 0 ? (
        <g role="group" aria-label={n.name}>
          <rect
            x={n.x}
            y={n.y}
            width={n.width}
            height={n.height}
            fill="none"
            stroke="var(--border)"
            strokeWidth={2}
          />
          {n.width > 80 && (
            <text
              x={n.x + 4}
              y={n.y + 11}
              fontSize={10}
              fill="var(--muted-foreground)"
            >
              {n.name.length > n.width / 6
                ? n.name.slice(0, Math.max(4, Math.floor(n.width / 6) - 2)) +
                  '…'
                : n.name}
            </text>
          )}
        </g>
      ) : (
        <g />
      );
    const tile = a.tiles.find((t) => t.id === n.id);
    if (!tile) return <g />;
    const key = tile.group || tile.id;
    const label = `${tile.label}: ${memory(tile.mib)} · ${((tile.mib / a.total) * 100).toFixed(1)}%${tile.detail ? ' · ' + tile.detail : ''}`;
    return (
      <g
        role={tile.href ? 'link' : 'button'}
        tabIndex={0}
        aria-label={label}
        aria-pressed={tile.href ? undefined : selection === key}
        onFocus={() => onSelect(key)}
        onClick={() =>
          tile.href ? window.location.assign(tile.href) : onSelect(key)
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (tile.href) window.location.assign(tile.href);
            else onSelect(key);
          }
        }}
      >
        <title>{label}</title>
        <rect
          x={n.x}
          y={n.y}
          width={n.width}
          height={n.height}
          fill={allocationColor(tile)}
          fillOpacity={!selection || selection === key ? 0.3 : 0.08}
          stroke={selection === key ? 'var(--foreground)' : 'var(--background)'}
          strokeWidth={2}
        />
        {n.width > 85 && n.height > 42 && (
          <text
            x={n.x + 10}
            y={n.y + 22}
            fill="var(--foreground)"
            fontSize={12}
            pointerEvents="none"
          >
            {componentLabel(tile).length > Math.floor(n.width / 7)
              ? componentLabel(tile).slice(
                  0,
                  Math.max(4, Math.floor(n.width / 7) - 2),
                ) + '…'
              : componentLabel(tile)}
            <tspan x={n.x + 10} dy={18}>
              {memory(tile.mib)}
            </tspan>
          </text>
        )}
      </g>
    );
  };
  return (
    <>
      {a.tiles.length > 2 && (
        <ChartContainer
          config={{}}
          className="h-56 w-full aspect-auto"
          aria-label={title + ' resource breakdown'}
        >
          <Treemap
            nodeInset={14}
            data={data}
            dataKey="value"
            nameKey="name"
            content={node}
            isAnimationActive={false}
          />
        </ChartContainer>
      )}
      <div className="resource-legend">
        {a.tiles.map((tile) => (
          <Button
            key={tile.id}
            variant="ghost"
            type="button"
            aria-pressed={selection === (tile.group || tile.id)}
            title={`${tile.label}${tile.detail ? ' · ' + tile.detail : ''}`}
            onFocus={() => onSelect(tile.group || tile.id)}
            onClick={() =>
              tile.href
                ? window.location.assign(tile.href)
                : onSelect(tile.group || tile.id)
            }
          >
            <i style={{ background: allocationColor(tile) }} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{componentLabel(tile)}</span>
              {tile.group && tile.label.includes(' · ') && (
                <small className="truncate text-muted-foreground">
                  {tile.label.split(' · ')[0]}
                </small>
              )}
            </span>
            <b>{memory(tile.mib)}</b>
          </Button>
        ))}
      </div>
      {selection && (
        <p className="muted" role="status">
          {a.tiles
            .filter((t) => (t.group || t.id) === selection)
            .map(
              (t) =>
                `${componentLabel(t)}: ${memory(t.mib)} (${((t.mib / a.total) * 100).toFixed(1)}%)`,
            )
            .join(' · ')}
        </p>
      )}
    </>
  );
}
