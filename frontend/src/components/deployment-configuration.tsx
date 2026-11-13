import { useState } from 'react';
import { Editor } from '@/Editors';
import { editable } from '@/editor-state';
import { readApi, message } from '@/ui';
import { deployment as deploymentDecoder } from '@/contracts';
import { PendingChanges } from './pending-changes';
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
  const [baseline, setBaseline] = useState(deployment);
  return (
    <>
      <PendingChanges deploymentId={deployment.id} changed={saved} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <Editor
        key={`${baseline.id}-${baseline.revision}`}
        initial={{
          kind: 'deployments',
          value: editable('deployments', baseline),
        }}
        data={data}
        busy={busy}
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
            const updated = await readApi(
              `/api/model-setups?expected=${
                pendingRevision ?? baseline.revision
              }`,
              deploymentDecoder,
              editor.value,
            );
            setBaseline(updated);
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
