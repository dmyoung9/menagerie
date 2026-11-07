import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from './ui/badge';

/**
 * One advanced disclosure inside a card. Content stays mounted while closed,
 * so drafts, validation and focus survive a collapse.
 */
export function CardAdvanced({
  title = 'Advanced',
  hint,
  overrides = [],
  defaultOpen = false,
  children,
}: {
  title?: string;
  hint?: string;
  /** Config keys explicitly set inside this disclosure. */
  overrides?: string[];
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      className="card-advanced"
      data-card-advanced={title}
      data-overrides={overrides.length}
      open={defaultOpen || undefined}
    >
      <summary className="card-advanced-summary">
        <ChevronRight aria-hidden className="card-advanced-chevron" />
        <span>{title}</span>
        {overrides.length > 0 && (
          <Badge
            variant="secondary"
            title={`Explicit: ${overrides.join(', ')}`}
          >
            {overrides.length}
          </Badge>
        )}
      </summary>
      {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
      <div className="card-advanced-content">{children}</div>
    </details>
  );
}
