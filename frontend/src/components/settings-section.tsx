import { useId, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from './ui/card';

/** A settings card. Collapsible cards use one native disclosure level. */
export function SettingsSection({
  name,
  title,
  description,
  action,
  summary,
  collapsible = false,
  defaultOpen = true,
  hidden = false,
  className,
  children,
}: {
  name: string;
  title: string;
  description?: string;
  action?: ReactNode;
  summary?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  hidden?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      data-settings-section={name}
      aria-labelledby={id}
      className={cn('settings-card', hidden && 'is-hidden', className)}
      tabIndex={-1}
      hidden={hidden}
    >
      <Card>
        {collapsible ? (
          <details
            className="settings-disclosure"
            open={defaultOpen || undefined}
          >
            <summary className="settings-disclosure-summary">
              <ChevronRight
                aria-hidden
                className="settings-disclosure-chevron"
              />
              <h2 id={id} className="settings-disclosure-title">
                {title}
              </h2>
              {summary && (
                <span className="settings-disclosure-note">{summary}</span>
              )}
            </summary>
            {description && (
              <p className="settings-disclosure-description">{description}</p>
            )}
            {action && (
              <div className="settings-disclosure-actions">{action}</div>
            )}
            <CardContent>{children}</CardContent>
          </details>
        ) : (
          <>
            <CardHeader>
              <CardTitle id={id}>{title}</CardTitle>
              {description && <CardDescription>{description}</CardDescription>}
              {(action || summary) && (
                <CardAction className="flex items-center gap-2">
                  {summary}
                  {action}
                </CardAction>
              )}
            </CardHeader>
            <CardContent>{children}</CardContent>
          </>
        )}
      </Card>
    </section>
  );
}
