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
    [error, setError] = useState('');
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
        save={async (editor) => {
          setBusy(true);
          setError('');
          try {
            await api(
              `/api/deployments?expected=${deployment.revision}`,
              editor.value,
            );
            saved();
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
