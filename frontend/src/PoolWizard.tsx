import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { SettingsSection } from '@/components/settings-section';
import { CardAdvanced } from '@/components/card-advanced';
import { useState } from 'react';
import { Placement, Duration } from './FormControls';
import { NumberControl } from './NumberControl';
import { api, message, Dialog, Field, type Registry } from './ui';

const PORT_MIN = 1024;
const PORT_MAX = 65535;
const RESERVED_PORTS = new Set([8001, 8017]);

/**
 * The "New pool" entry point. A pool is the deployment unit: one native
 * runtime installation, one device and one serving port shared by its model
 * members. This wizard creates an empty engine pool — no members are added
 * here; models join it through "New deployment".
 */
export function PoolWizard({
  data,
  close,
  saved,
}: {
  data: Registry;
  close: () => void;
  saved: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [runtimeId, setRuntimeId] = useState('');
  const [gpu, setGpu] = useState<number | null>(null);
  const [port, setPort] = useState<number | null>(null);
  const [priority, setPriority] = useState(50);
  const [idleTimeout, setIdleTimeout] = useState(300);
  const [allowEviction, setAllowEviction] = useState(false);
  const [queueTimeout, setQueueTimeout] = useState(300);
  const [maxLoaded, setMaxLoaded] = useState(4);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // A runtime pool needs a native router runtime; mirror the filter the
  // pool editor uses so the create form and the pool form agree on which
  // engines qualify.
  const poolRuntimes = (data.runtimes || []).filter(
    (runtime) =>
      runtime.execution_kind === 'native' &&
      runtime.engine === 'llama.cpp' &&
      (runtime.capabilities?.flags || []).includes('models-preset'),
  );

  const portInvalid =
    port !== null &&
    (port < PORT_MIN || port > PORT_MAX || RESERVED_PORTS.has(port));

  const incomplete = !name.trim() || !runtimeId || port === null || portInvalid;

  const save = async () => {
    if (busy || incomplete) return;
    setBusy(true);
    setError('');
    try {
      const result = await api('/api/deployment-sets', {
        name: name.trim(),
        engine_pool: true,
        runtime_id: runtimeId,
        gpu,
        port,
        residency: 'on-demand',
        priority,
        idle_timeout: idleTimeout,
        allow_eviction: allowEviction,
        queue_timeout: queueTimeout,
        max_loaded: maxLoaded,
        enabled,
        members: [],
      });
      const id = (result as { id: string }).id;
      if (id) saved(id);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New pool"
      close={close}
      busy={busy}
      wide
      editor
      guardChanges={false}
    >
      {error && (
        <Alert variant="destructive" className="mb-5" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
            {error}
          </AlertDescription>
        </Alert>
      )}
      <form
        className="resource-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <SettingsSection name="pool" title="Pool">
          <Field label="Name">
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Shared installed engine">
            {poolRuntimes.length ? (
              <NativeSelect
                required
                value={runtimeId}
                onChange={(e) => setRuntimeId(e.target.value)}
              >
                <NativeSelectOption value="">
                  Choose a runtime…
                </NativeSelectOption>
                {poolRuntimes.map((runtime) => (
                  <NativeSelectOption key={runtime.id} value={runtime.id}>
                    {runtime.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : (
              <div className="empty">
                <h3>No pool-ready engines</h3>
                <p className="muted">
                  A pool needs a native runtime that advertises model routing.
                  Add one in Engines first.
                </p>
              </div>
            )}
          </Field>
          <Field label="Shared device">
            <Placement
              part="gpu"
              value={{ gpu }}
              host={data.host?.[0]}
              change={(placement) => setGpu(placement.gpu ?? null)}
            />
          </Field>
          <Field label="Serving port" hint="Menagerie reserves 8001 and 8017.">
            <NumberControl
              label="Serving port"
              required
              min={PORT_MIN}
              max={PORT_MAX}
              value={port ?? undefined}
              change={(v) => setPort(v ?? null)}
            />
          </Field>
        </SettingsSection>
        <SettingsSection name="policy" title="Availability policy">
          <Field label="Mode">
            <p className="muted">
              On demand — required for runtime pools. Loads when requested and
              unloads after idle.
            </p>
          </Field>
          <Duration value={idleTimeout} change={(v) => setIdleTimeout(v)} />
          <label className="check">
            <Checkbox
              checked={allowEviction}
              onCheckedChange={(checked) => setAllowEviction(checked)}
            />
            Can unload to make room for another deployment
          </label>
          <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
            <Field label="Priority">
              <NumberControl
                label="Priority"
                required
                min={0}
                max={100}
                value={priority}
                change={(v) => setPriority(v ?? 0)}
              />
            </Field>
          </FieldGroup>
          <CardAdvanced title="Advanced availability">
            <Field label="Queue timeout (seconds)">
              <NumberControl
                label="Queue timeout (seconds)"
                required
                min={1}
                max={1800}
                value={queueTimeout}
                change={(v) => setQueueTimeout(v ?? 0)}
              />
            </Field>
            <Field label="Maximum resident models">
              <NumberControl
                label="Maximum resident models"
                min={1}
                max={128}
                value={maxLoaded}
                change={(v) => setMaxLoaded(v ?? 4)}
              />
            </Field>
          </CardAdvanced>
          <label className="check">
            <Switch
              disabled={busy}
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked)}
            />
            Enabled for clients
          </label>
        </SettingsSection>
        {poolRuntimes.length && (
          <Button
            type="submit"
            disabled={busy || incomplete}
            className="mt-5 w-full"
          >
            {busy ? 'Creating pool…' : 'Create pool'}
          </Button>
        )}
      </form>
    </Dialog>
  );
}
