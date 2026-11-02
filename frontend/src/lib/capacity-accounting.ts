export type Allocation = {
  id: string;
  label: string;
  mib: number;
  group?: string;
  detail?: string;
  href?: string;
  kind?: string;
};

export function allocationColor(item: Allocation) {
  if (item.kind === 'overflow') return 'var(--destructive)';
  if (item.kind === 'free') return 'var(--resource-free)';
  if (item.kind === 'external') return 'var(--resource-external)';
  const hash = [...(item.group || item.id)].reduce(
    (n, c) => (n * 31 + c.charCodeAt(0)) % 997,
    0,
  );
  return `var(--chart-${(hash % 5) + 1})`;
}

/** Split overflow, don't add it to unsplit demand. Area = max(budget, demand). */
export function capacityAccounting(budget: number, components: Allocation[]) {
  const valid = components.filter((v) => Number.isFinite(v.mib) && v.mib > 0);
  const demand = valid.reduce((sum, c) => sum + c.mib, 0);
  const usable = Math.max(0, Number.isFinite(budget) ? budget : 0);
  let left = usable;
  const tiles = valid.flatMap((c) => {
    const within = Math.min(left, c.mib);
    left -= within;
    const over = c.mib - within;
    return [
      ...(within ? [{ ...c, mib: within }] : []),
      ...(over
        ? [
            {
              ...c,
              id: c.id + '-over',
              label: c.label + ' · over budget',
              mib: over,
              kind: 'overflow',
            },
          ]
        : []),
    ];
  });
  if (left)
    tiles.push({
      id: 'available',
      label: 'Available',
      mib: left,
      kind: 'free',
    });
  return {
    demand,
    budget: usable,
    over: Math.max(0, demand - usable),
    total: Math.max(usable, demand),
    tiles,
  };
}
