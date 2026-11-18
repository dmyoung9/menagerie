import { useState } from 'react';
import { Editor } from '@/Editors';
import { editable } from '@/editor-state';
import { readApi, message } from '@/ui';
import { deployment as deploymentDecoder } from '@/contracts';
import { PendingChanges } from './pending-changes';
import { applyConfiguration } from '@/configuration-apply';
import { useConfirmation } from '@/hooks/use-confirmation';
import { array } from '@/decode';
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
  const [applying, setApplying] = useState(false);
  const [pending, setPending] = useState(false);
  const { confirm, confirmation } = useConfirmation();
  const refreshed = async () => {
    const rows = await readApi(
      '/api/registry/deployments',
      array(deploymentDecoder),
    );
    const row = rows.find((r) => r.id === deployment.id);
    if (row) setBaseline(row);
    saved();
  };
  return (
    <>
      {confirmation}
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
        applyActions
        applicationOwnsActions={pending}
        disabled={applying}
        applicationStatus={(dirty) => (
          <PendingChanges
            hideApplyActions={dirty}
            deploymentId={deployment.id}
            changed={() => void refreshed().catch((e) => setError(message(e)))}
            onBusyChange={setApplying}
            onPendingChange={setPending}
          />
        )}
        revisionConflict={revisionConflict}
        onReconciled={(fresh) => {
          setPendingRevision(fresh.revision);
          setRevisionConflict(false);
          setError('');
        }}
        save={async (editor, mode = 'apply') => {
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
            if (updated.changes_pending)
              await applyConfiguration(updated.id, mode, confirm);
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
