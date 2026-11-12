import { useState } from 'react';
import { Editor } from '@/Editors';
import { editable } from '@/editor-state';
import { active, api, message } from '@/ui';
import type { Deployment, Registry } from '@/types';

export function DeploymentConfiguration({
  deployment,
  data,
  saved,
}: {
  deployment: Deployment;
  data: Registry;
  saved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pendingRevision, setPendingRevision] = useState<number | null>(null),
    [revisionConflict, setRevisionConflict] = useState(false);
  return (
    <>
      {active(deployment) && (
        <p role="status">
          Unload this deployment before changing its configuration.
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <Editor
        key={`${deployment.id}-${deployment.revision}`}
        initial={{
          kind: 'deployments',
          value: editable('deployments', deployment),
        }}
        data={data}
        busy={busy}
        disabled={active(deployment)}
        embedded
        revisionConflict={revisionConflict}
        onReconciled={(fresh) => {
          setPendingRevision(fresh.revision);
          setRevisionConflict(false);
          setError('');
        }}
        save={async (editor) => {
          setBusy(true);
          setError('');
          try {
            await api(
              `/api/deployments?expected=${
                pendingRevision ?? deployment.revision
              }`,
              editor.value,
            );
            saved();
            setPendingRevision(null);
          } catch (e) {
            const detail = message(e);
            if (detail.includes('Revision changed')) {
              // A concurrent change: surface the conflict for review and do NOT
              // call saved() — that would refresh the deployment and remount the
              // Editor (via its revision key), resetting the (now merged) draft
              // and clobbering the user's edits.
              setRevisionConflict(true);
            } else {
              setError(detail);
            }
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
