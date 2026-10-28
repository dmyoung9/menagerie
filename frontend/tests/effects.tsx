import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JsonEdit } from '../src/Json';
import { VariantDialog } from '../src/VariantDialog';
import { DeploymentWizard } from '../src/DeploymentWizard';
import type { CatalogFiles, CatalogRevision } from '../src/types';
import '../src/theme.css';
import { object, number } from '../src/decode';
import '../src/style.css';

function JsonHarness() {
  const [value, setValue] = useState({ count: 1 });
  const [version, setVersion] = useState(0);
  const [reports, setReports] = useState<string[]>([]);
  return (
    <>
      <button onClick={() => setVersion((n) => n + 1)}>Rerender parent</button>
      <button onClick={() => setValue({ count: 2 })}>Replace value</button>
      <output aria-label="Validation reports">{reports.join(',')}</output>
      <JsonEdit
        label="JSON value"
        decode={object<{ count: number }>({ count: number })}
        value={value}
        onChange={setValue}
        onValid={(valid) =>
          setReports((items) => [...items, `${version}:${valid}`])
        }
      />
    </>
  );
}

const files = (revision: string): CatalogFiles => ({
  revision,
  files: [{ name: 'example-7B-Q4_K_M.gguf', size: 4096 }],
});
let resolveOriginal: (() => void) | undefined;

function VariantHarness() {
  const [client, setClient] = useState('original');
  const [calls, setCalls] = useState<string[]>([]);
  useEffect(() => {
    const replace = () => setClient('replacement');
    const resolve = () => resolveOriginal?.();
    window.addEventListener('replace-client', replace);
    window.addEventListener('resolve-original', resolve);
    return () => {
      window.removeEventListener('replace-client', replace);
      window.removeEventListener('resolve-original', resolve);
    };
  }, []);
  const request = useMemo(
    () =>
      async (path: string): Promise<unknown> => {
        setCalls((items) => [
          ...items,
          `${client}:${path.includes('/files?') ? 'files' : 'revisions'}`,
        ]);
        if (path.includes('/files?')) {
          if (client === 'original')
            await new Promise<void>((resolve) => {
              resolveOriginal = resolve;
            });
          if (client === 'original')
            setCalls((items) => [...items, 'original:completed']);
          return files(client);
        }
        return [{ name: client, kind: 'branch' }] satisfies CatalogRevision[];
      },
    [client],
  );
  return (
    <>
      <output aria-label="API calls">{calls.join(',')}</output>
      <VariantDialog
        source="hf"
        name="fixture/model"
        api={request}
        close={() => {}}
        queued={() => {}}
        openModel={() => {}}
      />
    </>
  );
}

function WizardHarness() {
  const [snapshot, setSnapshot] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [engineId, setEngineId] = useState('engine');
  useEffect(() => {
    const poll = () => setSnapshot((n) => n + 1);
    const schema = () => setExpanded(true);
    const replaceEngine = () => setEngineId('replacement-engine');
    window.addEventListener('poll-registry', poll);
    window.addEventListener('change-schema', schema);
    window.addEventListener('replace-engine', replaceEngine);
    return () => {
      window.removeEventListener('poll-registry', poll);
      window.removeEventListener('change-schema', schema);
      window.removeEventListener('replace-engine', replaceEngine);
    };
  }, []);
  return (
    <>
      <output aria-label="Registry snapshot">{snapshot}</output>
      <DeploymentWizard
        data={{
          models: [
            { id: 'model', revision: 1, name: 'Example', format: 'gguf' },
          ],
          runtimes: [
            {
              id: engineId,
              revision: 1,
              name: 'Engine',
              engine: 'llama.cpp',
              capabilities: {
                formats: ['gguf'],
                schema: {
                  'gpu-layers': {
                    type: 'string',
                    default: 'all',
                    description: `Snapshot ${snapshot}`,
                  },
                  ...(expanded
                    ? {
                        'flash-attn': {
                          type: 'string',
                          default: 'on',
                          choices: ['on', 'off', 'auto'],
                        },
                      }
                    : {}),
                },
              },
            },
          ],
          deployments: [],
          profiles: [],
          host: [],
          jobs: [],
        }}
        close={() => {}}
        created={() => {}}
        setupEngine={() => {}}
      />
    </>
  );
}

const scenario = new URLSearchParams(location.search).get('scenario');
createRoot(document.getElementById('root')!).render(
  scenario === 'variant' ? (
    <VariantHarness />
  ) : scenario === 'wizard' ? (
    <WizardHarness />
  ) : (
    <JsonHarness />
  ),
);
