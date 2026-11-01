import { capacityAccounting, type Allocation } from '@/lib/capacity-accounting';
import { memory } from '@/lib/formatters';

export function CapacityBar({
  budget,
  components,
}: {
  budget: number;
  components: Allocation[];
}) {
  const a = capacityAccounting(budget, components);
  return (
    <div className="capacity-summary">
      <p className="numeric">
        {memory(a.demand)} / {memory(a.budget)} budget ·{' '}
        {a.budget > 0
          ? `${Math.round((a.demand / a.budget) * 100)}%`
          : 'No usable budget'}
        {a.over > 0 && ` · ${memory(a.over)} over budget`}
      </p>
      <svg
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${memory(a.demand)} demand, ${memory(a.budget)} budget`}
      >
        <rect width="100" height="8" y="1" fill="var(--muted)" />
        <rect
          width={a.total ? (Math.min(a.demand, a.budget) / a.total) * 100 : 0}
          height="8"
          y="1"
          fill="var(--chart-1)"
        />
        {a.over > 0 && (
          <rect
            x={(a.budget / a.total) * 100}
            width={(a.over / a.total) * 100}
            height="8"
            y="1"
            fill="var(--destructive)"
          />
        )}
        <line
          x1={a.total ? (a.budget / a.total) * 100 : 100}
          x2={a.total ? (a.budget / a.total) * 100 : 100}
          y1="0"
          y2="10"
          stroke="var(--foreground)"
          strokeWidth="0.5"
        />
      </svg>
    </div>
  );
}
