import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { FieldGroup, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useEffect, useState } from 'react';
import { readApi } from './ui';
import * as contracts from './contracts';
import type {
  Deployment,
  HostPolicyDraft,
  HostSettings,
  HostSnapshot,
  LaunchModal,
  LaunchPlan,
} from './types';
import { api, CopyButton, Dialog, Field, gib, Json, message, Tabs } from './ui';

export function LaunchReview({
  modal,
  deployments,
  close,
  done,
  host,
}: {
  modal: LaunchModal;
  deployments: Deployment[];
  close: () => void;
  done: () => void;
  host: HostSnapshot;
}) {
  const [plan, setPlan] = useState<LaunchPlan | null>(null),
    [error, setError] = useState(''),
    [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    readApi(
      `/api/${modal.kind}/${modal.row.id}/validate`,
      contracts.launchPlan,
      {},
    )
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [modal.kind, modal.row.id]);
  const names = (ids: string[]) =>
    ids.map((id) => deployments.find((d) => d.id === id)?.name || id);
  const needsAcceptance = Boolean(
    plan?.warnings?.length || plan?.stops?.length,
  );
  return (
    <Dialog title="Review launch" close={close} busy={busy} wide>
      <h3>{modal.row.name}</h3>
      {error && (
        <Alert variant="destructive" className="mb-5" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
            {error}
          </AlertDescription>
        </Alert>
      )}
      {!plan && !error && <p className="muted">Checking capacity…</p>}
      {plan && (
        <>
          <div className="table-wrap">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="numeric">
                    Estimated VRAM (GiB)
                  </TableHead>
                  <TableHead>Confidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(plan.estimates).map(([id, estimate]) => (
                  <TableRow key={id}>
                    <TableCell>
                      {deployments.find((d) => d.id === id)?.name ||
                        modal.row.name}
                    </TableCell>
                    <TableCell className="numeric">
                      {gib(estimate.reservation_mib)}
                    </TableCell>
                    <TableCell>{estimate.confidence}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {Object.keys(plan.estimates).length > 1 && (
                <tfoot>
                  <TableRow>
                    <TableCell>Total</TableCell>
                    <TableCell className="numeric">
                      {gib(
                        Object.values(plan.estimates).reduce(
                          (sum, e) => sum + e.reservation_mib,
                          0,
                        ),
                      )}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </tfoot>
              )}
            </Table>
          </div>
          <dl className="properties">
            {(host.gpus || []).map((g, index: number) => (
              <div className="property-pair" key={g.index ?? index}>
                <dt>GPU {g.index ?? index} free (GiB)</dt>
                <dd>{gib(g.free_mib)}</dd>
              </div>
            ))}
          </dl>
          {plan.stops.length > 0 && (
            <div className="warning">
              <h3>Will unload</h3>
              <ul>
                {names(plan.stops).map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <p>
                KV caches will be lost. Failed launches attempt to restore these
                deployments.
              </p>
            </div>
          )}
          {plan.errors.map((e: string) => (
            <Alert variant="destructive" className="mb-5" role="alert" key={e}>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
                {e}
              </AlertDescription>
            </Alert>
          ))}
          {plan.warnings.length > 0 && (
            <details>
              <summary>Memory uncertainty ({plan.warnings.length})</summary>
              {plan.warnings.map((w: string) => (
                <p className="warning" key={w}>
                  {w}
                </p>
              ))}
            </details>
          )}
          {needsAcceptance && (
            <label className="check">
              <Checkbox
                checked={accepted}
                onCheckedChange={(checked) => setAccepted(checked)}
              />
              {plan.stops.length
                ? plan.warnings.length
                  ? 'Approve these unloads and uncertain memory estimates'
                  : 'Approve these unloads'
                : 'Allow loading with uncertain memory estimates'}
            </label>
          )}
          <div className="dialog-actions">
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              variant="default"
              type="button"
              disabled={
                busy || plan.errors.length > 0 || (needsAcceptance && !accepted)
              }
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await api(`/api/${modal.kind}/${modal.row.id}/start`, {
                    override: accepted,
                    plan_token: plan.plan_token,
                  });
                  done();
                } catch (e) {
                  setError(message(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Submitting…' : 'Load'}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

export function Connect({
  endpoint,
  deployments,
  close,
}: {
  endpoint: string;
  deployments: Deployment[];
  close: () => void;
}) {
  const [tab, setTab] = useState('Example request'),
    [alias, setAlias] = useState(
      deployments.find((d) => d.lifecycle?.serving)?.alias || '',
    ),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const available = deployments.filter((d) => d.lifecycle?.serving);
  const pluginCommand = `menagerie plugin install --gateway-port ${new URL(endpoint || 'http://127.0.0.1:8001/v1').port || '80'}`;
  const request = [
    `curl ${endpoint}/chat/completions`,
    `  -H 'Content-Type: application/json'`,
    `  -d '${JSON.stringify({ model: alias, messages: [{ role: 'user', content: 'Hello' }], stream: true })}'`,
  ].join(' \\\n');
  return (
    <Dialog title="Connect client" close={close} wide>
      <div className="endpoint-field">
        <span>Base URL</span>
        <code>{endpoint || 'Loading…'}</code>
        {endpoint && <CopyButton value={endpoint} label="Copy base URL" />}
      </div>
      <Field label="Model">
        <div className="copy-value">
          <NativeSelect
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          >
            {available.map((d) => (
              <NativeSelectOption key={d.id} value={d.alias}>
                {d.alias}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {alias && <CopyButton value={alias} label="Copy model" />}
        </div>
      </Field>
      {!available.length && (
        <p className="muted">No models are available to clients yet.</p>
      )}
      <p className="muted">
        Use this endpoint on the machine running Menagerie. Inference is
        loopback-only.
      </p>
      <Tabs
        items={['Example request', 'OpenCode']}
        value={tab}
        onChange={setTab}
      />
      {tab === 'Example request' && alias && (
        <div className="code-block">
          <CopyButton value={request} label="Copy example request" />
          <pre>{request}</pre>
        </div>
      )}
      {tab === 'OpenCode' && (
        <>
          <p>
            Install Menagerie's bundled discovery plugin on the machine running
            OpenCode:
          </p>
          <div className="code-block">
            <CopyButton
              value={pluginCommand}
              label="Copy plugin install command"
            />
            <pre>{pluginCommand}</pre>
          </div>
          <p className="muted">
            For source installations use .venv/bin/menagerie. Then restart the
            owning OpenCode server and reconnect OpenChamber. Existing client
            settings and model defaults are preserved.
          </p>
          <p>
            Without the plugin, export a static provider fragment to merge into
            your configuration:
          </p>
          <Button
            variant="outline"
            type="button"
            onClick={async () => {
              try {
                const r = await readApi(
                  '/api/integration/opencode/export',
                  contracts.backup,
                  {},
                );
                setNotice('Saved to ' + r.path);
                setError('');
              } catch (e) {
                setError(message(e));
              }
            }}
          >
            Export configuration
          </Button>
          <p className="muted">
            Do not combine static model overrides with discovery unless
            intentional.
          </p>
        </>
      )}
      {notice && (
        <p role="status" className="muted path">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </Dialog>
  );
}

const policyFields: [
  Exclude<keyof HostSettings, 'expose_on_demand'>,
  string,
  number,
  number,
][] = [
  ['gpu_headroom_mib', 'GPU reserve (MiB)', 2048, 1048576],
  ['ram_headroom_mib', 'RAM reserve (MiB)', 4096, 1048576],
  ['temperature_limit', 'Temperature limit (°C)', 60, 85],
  ['max_queue', 'Queued requests', 1, 256],
  ['sample_seconds', 'Sample interval (seconds)', 1, 60],
  ['retention_days', 'Detailed history (days)', 1, 90],
  ['summary_days', 'Summary history (days)', 1, 365],
  ['history_quota_mib', 'History quota (MiB)', 16, 16384],
];
export function PolicyEditor({
  initial,
  save,
  busy,
  purge,
}: {
  initial: HostSettings;
  save: (v: HostPolicyDraft) => void;
  busy: boolean;
  purge: () => void;
}) {
  const [value, setValue] = useState<HostPolicyDraft>({ ...initial });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(value);
      }}
    >
      {[
        ['Capacity & requests', policyFields.slice(0, 4)],
        ['Telemetry & retention', policyFields.slice(4)],
      ].map(([title, fields]) => (
        <section key={String(title)}>
          <h3>{String(title)}</h3>
          <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
            {(fields as typeof policyFields).map(([key, label, min, max]) => {
              const memory = key.endsWith('_mib'),
                scale = memory ? 1024 : 1;
              return (
                <Field
                  label={memory ? label.replace('MiB', 'GiB') : label}
                  key={key}
                >
                  <Input
                    type="number"
                    required
                    min={min / scale}
                    max={max / scale}
                    step={
                      memory ? 1 / 1024 : key === 'sample_seconds' ? 'any' : 1
                    }
                    value={Number(value[key] ?? 0) / scale}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        [key]: memory
                          ? Math.round(Number(e.target.value) * scale)
                          : Number(e.target.value),
                      })
                    }
                  />
                </Field>
              );
            })}
          </FieldGroup>
        </section>
      ))}
      <label className="check">
        <Checkbox
          checked={value.expose_on_demand}
          onCheckedChange={(checked) =>
            setValue({ ...value, expose_on_demand: checked })
          }
        />
        List unloaded on-demand models for clients
      </label>
      <div className="dialog-actions">
        <Button
          variant="destructive"
          type="button"
          disabled={busy}
          onClick={purge}
        >
          Purge telemetry…
        </Button>
        <Button variant="default" type="submit" disabled={busy}>
          Save policy
        </Button>
      </div>
    </form>
  );
}

export function SourceBuild({
  close,
  done,
}: {
  close: () => void;
  done: () => void;
}) {
  const [value, setValue] = useState<import('./types').SourceBuildDraft>({
      engine: 'llama.cpp',
      url: 'https://github.com/ggml-org/llama.cpp',
      commit: '',
    }),
    [plan, setPlan] = useState<import('./types').SourceBuildPlan | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const preview = async () => {
    setBusy(true);
    setError('');
    try {
      setPlan(
        await readApi(
          '/api/runtimes/install/preview',
          contracts.sourceBuildPlan,
          value,
        ),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Build engine from source" close={close} busy={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void preview();
        }}
      >
        <FieldSet disabled={busy}>
          <Field label="Engine">
            <NativeSelect
              value={value.engine}
              onChange={(e) => {
                if (
                  e.target.value !== 'llama.cpp' &&
                  e.target.value !== 'prism'
                )
                  return;
                setValue({ ...value, engine: e.target.value });
                setPlan(null);
              }}
            >
              {['llama.cpp', 'prism'].map((v) => (
                <NativeSelectOption key={v}>{v}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Repository URL">
            <Input
              type="url"
              required
              value={value.url}
              onChange={(e) => {
                setValue({ ...value, url: e.target.value });
                setPlan(null);
              }}
            />
          </Field>
          <Field label="Commit">
            <Input
              required
              spellCheck={false}
              autoCapitalize="none"
              value={value.commit}
              onChange={(e) => {
                setValue({ ...value, commit: e.target.value });
                setPlan(null);
              }}
            />
          </Field>
        </FieldSet>
        <Button variant="outline" type="submit" disabled={busy}>
          Preview commands
        </Button>
      </form>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {plan && (
        <>
          <p className="warning">{plan.warning}</p>
          <Json value={plan.commands} />
          <div className="dialog-actions">
            <Button
              variant="destructive"
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await api('/api/runtimes/install', {
                    ...value,
                    token: plan.token,
                    trust: true,
                  });
                  done();
                } catch (e) {
                  setError(message(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Trust source & build
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
