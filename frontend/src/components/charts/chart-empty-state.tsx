import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';

export function ChartEmptyState({
  label = 'No measurements',
}: {
  label?: string;
}) {
  return (
    <Empty className="min-h-48">
      <EmptyHeader>
        <EmptyTitle>{label}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}
