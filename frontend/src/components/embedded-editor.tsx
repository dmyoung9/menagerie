import type { ReactNode } from 'react';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';

export function EmbeddedEditor({
  children,
  changed,
  busy,
}: {
  children: ReactNode;
  changed?: boolean;
  busy?: boolean;
  title?: string;
  close?: () => void;
  wide?: boolean;
  editor?: boolean;
}) {
  const guard = useUnsavedChanges(!!changed, !!busy);
  return (
    <section className="embedded-editor">
      {guard}
      {children}
    </section>
  );
}
