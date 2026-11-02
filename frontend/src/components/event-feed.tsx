import { Status, date, eventText } from '@/ui';
import { activityEntries } from '@/lib/activity';
import { OperationProgress } from './operation-progress';
import type { Deployment, Job, OperationEvent } from '@/types';

export function EventFeed({
  events,
  deployments,
  jobs = [],
  limit,
}: {
  events: OperationEvent[];
  deployments: Pick<Deployment, 'id' | 'name' | 'unit_id'>[];
  jobs?: Job[];
  limit?: number;
}) {
  const entries = activityEntries(events, deployments, jobs).slice(0, limit);
  return entries.length ? (
    <ol className="event-feed">
      {entries.map((entry) => (
        <li key={entry.id}>
          <div className="event-row">
            <div>
              <Status
                value={entry.state === 'FAILED' ? 'Errored' : entry.state}
              />
            </div>
            <div className="min-w-0">
              <strong>{entry.title}</strong>
              <time dateTime={new Date(entry.ts * 1000).toISOString()}>
                {date(entry.ts)}
              </time>
              {entry.detail && entry.detail !== entry.job?.error && (
                <p>{entry.detail}</p>
              )}
              {entry.job && <OperationProgress job={entry.job} />}
            </div>
            <nav
              className="event-links"
              aria-label={`Resources for ${entry.title}`}
            >
              {entry.links.map((link) => (
                <a key={link.href} href={link.href}>
                  {link.label}
                </a>
              ))}
            </nav>
          </div>
          {entry.steps.length > 1 && (
            <details className="event-steps">
              <summary>{entry.steps.length} steps</summary>
              <ol>
                {entry.steps.map((e) => (
                  <li key={e.seq}>
                    <Status
                      value={String(e.data?.to || e.data?.state || 'Recorded')}
                    />
                    <span>{eventText(e, deployments)}</span>
                    <time>{date(e.ts)}</time>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </li>
      ))}
    </ol>
  ) : (
    <p className="muted padded">No recent activity.</p>
  );
}
