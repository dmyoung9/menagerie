import { useId, type ReactNode } from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from './ui/card';

/** Open settings groups: navigation scrolls to them rather than hiding fields. */
export function SettingsSection({
  name,
  title,
  description,
  action,
  children,
}: {
  name: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      data-settings-section={name}
      aria-labelledby={id}
      className="settings-card"
      tabIndex={-1}
    >
      <Card>
        <CardHeader>
          <CardTitle id={id}>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  );
}
