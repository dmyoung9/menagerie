import { memory, budgetLabel } from '@/lib/formatters';

export function CapacitySummary({
  demand,
  budget,
  remaining,
  physical,
}: {
  demand: number;
  budget: number;
  remaining: number | null;
  physical: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 tabular-nums">
        <strong>{memory(demand)}</strong> / {memory(budget)}{' '}
        <span className="text-muted-foreground">budget</span>
      </p>
      <p
        className={
          remaining !== null && remaining < 0
            ? 'm-0 text-destructive'
            : 'm-0 text-muted-foreground'
        }
      >
        {budgetLabel(remaining)}
      </p>
      <p className="m-0 text-muted-foreground">
        {memory(physical)} capacity · {memory(Math.max(0, physical - budget))}{' '}
        headroom
      </p>
    </div>
  );
}
