import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  applyConfiguration,
  applyLabels,
  type ApplyMode,
} from './configuration-apply';
import { PendingChanges } from '@/components/pending-changes';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { FieldSet, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Card,
  CardTitle,
  CardHeader,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Fragment, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import {
  active,
  Dialog,
  Empty,
  Field,
  gib,
  Menu,
  message,
  mode,
  number,
  state,
  api,
  Status,
  Tabs,
  Json,
  telemetryStale,
  type Registry,
} from './ui';
import { ActivityFeed } from './Views';
import { ResourceHistory } from '@/components/resource-history';
import { EmbeddedEditor } from '@/components/embedded-editor';
import { RequestHistory } from '@/components/request-history';
import { DeploymentPerformance } from '@/components/deployment-performance';
import { go, repoPath } from './navigation';
import { DraftFormProvider, useDraftForm } from './use-draft-form';
import { editable } from './editor-state';
import { Duration, Placement } from './FormControls';
import { NumberControl } from './NumberControl';
import { useConfirmation } from '@/hooks/use-confirmation';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SettingsSection } from '@/components/settings-section';
import { CardAdvanced } from '@/components/card-advanced';
import { readApi } from './ui';
import * as contracts from './contracts';
import { reconcileDeep, deploymentSetToDraft } from './reconcile';
import type {
  Deployment,
  DeploymentActions,
  DeploymentSet,
  DeploymentSetDraft,
  HostSnapshot,
  OperationEvent,
  Runtime,
  ServingDeployment,
} from './types';

export function PoolSection({
  d,
  data,
  host,
  actions,
  changed,
}: {
  d: DeploymentSet;
  data: Registry;
  host: HostSnapshot;
  actions: DeploymentActions;
  changed: (text: string) => void;
}) {
  const { confirm, confirmation } = useConfirmation();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const members = d.members || [];
  const runtime = (data.runtimes || []).find((r) => r.id === d.runtime_id);
  const meta = [
    `${members.length} model${members.length === 1 ? '' : 's'}`,
    runtime?.name || d.runtime_id,
    d.port != null ? `:${d.port}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const stale = telemetryStale(host);

  async function remove(member: Deployment) {
    if (
      !(await confirm(
        `Remove ${member.name} from ${d.name}? Model files and history are kept.`,
      ))
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api(
        `/api/deployment-sets/${d.id}/members/${member.id}/remove?expected=${d.revision}`,
        {},
      );
      changed(`${member.name} removed from ${d.name}`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function removePool() {
    if (
      !(await confirm(
        `Delete ${d.name}? ${
          members.length
            ? `${members.length} model${members.length === 1 ? '' : 's'} leave the registry. `
            : ''
        }Model files and the engine installation are kept.`,
      ))
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api(
        `/api/deployment-sets/${d.id}/delete?expected=${d.revision}`,
        {},
      );
      changed(`${d.name} deleted`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-5 min-w-0 gap-0 p-0">
      {confirmation}
      <CardHeader className="flex flex-wrap items-start justify-between gap-3 p-5 pb-3">
        <div className="min-w-0">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <a href={`#/deployments/${d.id}`}>{d.name}</a>
            <Status value={state(d)} />
          </CardTitle>
          <CardDescription>{meta}</CardDescription>
          {d.changes_pending && <p className="muted">Changes pending</p>}
        </div>
        <div className="actions flex flex-wrap items-center gap-2">
          {d.enabled && !active(d) && (
            <Button
              variant="default"
              type="button"
              disabled={busy}
              onClick={() => actions.load('serving-deployments', d)}
            >
              Load
            </Button>
          )}
          {active(d) && d.state !== 'STOPPING' && (
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => actions.stop('serving-deployments', d)}
            >
              Unload
            </Button>
          )}
          <Menu label={'Actions for ' + d.name}>
            <DropdownMenuItem
              onClick={() => actions.edit('deployment_sets', d)}
            >
              Edit pool
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={busy || active(d)}
              onClick={() => void removePool()}
            >
              Delete pool
            </DropdownMenuItem>
          </Menu>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error && (
          <p role="alert" className="error-text px-5 pb-3">
            {error}
          </p>
        )}
        {members.length ? (
          <div className="table-wrap">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Availability</TableHead>
                  <TableHead className="numeric">
                    VRAM (GiB)
                    {stale && (
                      <small
                        className="muted"
                        title="Telemetry has not updated"
                      >
                        {' '}
                        · stale
                      </small>
                    )}
                  </TableHead>
                  <TableHead className="numeric">Active requests</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell>
                      <Status value={state(member)} />
                    </TableCell>
                    <TableCell>
                      <a href={`#/deployments/${member.id}`}>{member.name}</a>
                      <small className="muted">
                        <code>{member.alias}</code>
                      </small>
                      {member.changes_pending && (
                        <p className="muted">Changes pending</p>
                      )}
                    </TableCell>
                    <TableCell>
                      {member.member_availability === false
                        ? 'Unavailable'
                        : !member.enabled
                          ? 'Disabled'
                          : member.runtime_observation?.residency ===
                                'resident' || member.state === 'READY'
                            ? 'Loaded'
                            : ['STARTING', 'LOADING', 'QUEUED'].includes(
                                  member.state,
                                )
                              ? 'Loading'
                              : member.state === 'STOPPING'
                                ? 'Unloading'
                                : 'Not loaded'}
                    </TableCell>
                    <TableCell className="numeric">
                      {gib(host.deployments?.[member.id]?.gpu_mib)}
                    </TableCell>
                    <TableCell className="numeric">
                      {member.inflight || 0}
                    </TableCell>
                    <TableCell>
                      <div className="actions">
                        {member.member_availability !== false && (
                          <Button
                            variant="outline"
                            type="button"
                            aria-label={
                              (member.enabled ? 'Disable ' : 'Enable ') +
                              member.name
                            }
                            disabled={busy || member.changes_pending}
                            onClick={() =>
                              actions.enable(member, !member.enabled)
                            }
                          >
                            {member.enabled ? 'Disable' : 'Enable'}
                          </Button>
                        )}
                        <Menu label={'Actions for ' + member.name}>
                          <DropdownMenuItem
                            render={
                              <a
                                href={`#/deployments/${member.id}/configuration`}
                              />
                            }
                          >
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            render={
                              <a href={`#/deployments/${member.id}/logs`} />
                            }
                          >
                            Logs
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            aria-label={'Remove ' + member.name + ' from pool'}
                            disabled={busy || active(member)}
                            onClick={() => void remove(member)}
                          >
                            Remove from pool
                          </DropdownMenuItem>
                        </Menu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="px-5 pb-5">
            <p className="muted">No models in this pool yet.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function unitVram(
  d: ServingDeployment,
  host: HostSnapshot,
): number | undefined {
  const members = (d.members || [d]).filter(active);
  const values = members.map((m) => host.deployments?.[m.id]?.gpu_mib);
  return values.length && values.every((v: unknown) => typeof v === 'number')
    ? values.reduce((a: number, b: number) => a + b, 0)
    : undefined;
}
export function ServingTable({
  rows,
  host,
  actions,
  compact = false,
  runtimes = [],
}: {
  rows: ServingDeployment[];
  host: HostSnapshot;
  actions: DeploymentActions;
  compact?: boolean;
  runtimes?: Runtime[];
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  function poolSubtitle(d: ServingDeployment) {
    const modelCount = d.members?.length ?? 0;
    if (modelCount <= 1) return null;
    const runtimeName = runtimes.find((r) => r.id === d.runtime_id)?.name;
    const parts: string[] = [`${modelCount} models`];
    if (d.runtime_id) parts.push(runtimeName ? runtimeName : d.runtime_id);
    if (d.port != null) parts.push(`:${d.port}`);
    return parts.join(' · ');
  }
  function primary(d: ServingDeployment) {
    const label = !d.enabled ? 'Enable' : active(d) ? 'Unload' : 'Load';
    const onClick = () =>
      !d.enabled
        ? actions.enable(d, true)
        : active(d)
          ? actions.stop('serving-deployments', d)
          : actions.load('serving-deployments', d);
    if (d.state === 'STOPPING') return null;
    return (
      <Button variant="outline" type="button" onClick={onClick}>
        {label}
      </Button>
    );
  }
  const stale = telemetryStale(host);
  return (
    <div className="table-wrap">
      <Table className={'deployment-table ' + (compact ? 'compact' : '')}>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Deployment</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead className="numeric">
              VRAM (GiB)
              {stale && (
                <small className="muted" title="Telemetry has not updated">
                  {' '}
                  · stale
                </small>
              )}
            </TableHead>
            <TableHead className="numeric">Active requests</TableHead>
            <TableHead
              className="numeric"
              title="All finished requests, including failures and cancellations. Counts start with retained history on upgrade."
            >
              Historical requests
            </TableHead>
            {!compact && (
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => (
            <Fragment key={d.id}>
              <TableRow
                className="deployment-row"
                onClick={(e) => {
                  if (
                    !(e.target as HTMLElement).closest(
                      'a, button, input, [role="menuitem"]',
                    )
                  )
                    go('deployments/' + d.id);
                }}
              >
                <TableCell>
                  <Status
                    value={
                      d.state === 'FAILED' || d.lifecycle?.failure
                        ? 'Errored'
                        : state(d)
                    }
                  />
                </TableCell>
                <TableCell>
                  <div className="deployment-name">
                    {d.members?.length > 1 && (
                      <Button
                        variant="ghost"
                        type="button"
                        aria-label={
                          (expanded.includes(d.id) ? 'Collapse ' : 'Expand ') +
                          d.name
                        }
                        aria-expanded={expanded.includes(d.id)}
                        onClick={() =>
                          setExpanded((s) =>
                            s.includes(d.id)
                              ? s.filter((id) => id !== d.id)
                              : [...s, d.id],
                          )
                        }
                      >
                        {expanded.includes(d.id) ? (
                          <ChevronDown size={15} />
                        ) : (
                          <ChevronRight size={15} />
                        )}
                      </Button>
                    )}
                    <div>
                      <a className="row-link" href={'#/deployments/' + d.id}>
                        {d.name}
                      </a>
                      {d.members?.length > 1 && (
                        <small className="muted">{poolSubtitle(d)}</small>
                      )}
                      {(d.state === 'FAILED' || d.lifecycle?.failure) && (
                        <a
                          className="block text-muted-foreground"
                          href={`#/deployments/${d.id}/logs`}
                        >
                          View logs
                        </a>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>{mode(d)}</TableCell>
                <TableCell className="numeric">
                  {gib(unitVram(d, host))}
                </TableCell>
                <TableCell className="numeric">{d.inflight || 0}</TableCell>
                <TableCell className="numeric">
                  {number(d.historical_requests, 0)}
                </TableCell>
                {!compact && (
                  <TableCell>
                    <div className="actions">
                      {primary(d)}
                      <Menu label={'Actions for ' + d.name}>
                        {d.multi_model ? (
                          <DropdownMenuItem
                            onClick={() => actions.edit('deployment_sets', d)}
                          >
                            Edit
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            render={
                              <a href={`#/deployments/${d.id}/configuration`} />
                            }
                          >
                            Edit
                          </DropdownMenuItem>
                        )}
                        {!d.multi_model && (
                          <DropdownMenuItem
                            onClick={() => actions.edit('deployments', d, true)}
                          >
                            Duplicate
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() => go('deployments/' + d.id + '/logs')}
                        >
                          Logs
                        </DropdownMenuItem>
                        {d.enabled && (
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={active(d)}
                            onClick={() => actions.enable(d, false)}
                          >
                            Disable
                          </DropdownMenuItem>
                        )}
                      </Menu>
                    </div>
                  </TableCell>
                )}
              </TableRow>
              {expanded.includes(d.id) &&
                d.members?.map((member: Deployment) => (
                  <TableRow className="member-row" key={member.id}>
                    <TableCell>
                      <Status value={state(member)} />
                    </TableCell>
                    <TableCell>
                      <a href={'#/deployments/' + d.id + '/models'}>
                        {member.name}
                      </a>
                    </TableCell>
                    <TableCell />
                    <TableCell className="numeric">
                      {gib(host.deployments?.[member.id]?.gpu_mib)}
                    </TableCell>
                    <TableCell className="numeric">
                      {member.inflight || 0}
                    </TableCell>
                    <TableCell className="numeric">
                      {number(member.historical_requests, 0)}
                    </TableCell>
                    {!compact && <TableCell />}
                  </TableRow>
                ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
      {!rows.length && <Empty title="No matching deployments" />}
    </div>
  );
}

export function DeploymentSetEditor({
  initial,
  data,
  close,
  saved,
  embedded = false,
}: {
  initial?: DeploymentSet;
  data: Registry;
  close: () => void;
  saved: (id: string) => void;
  embedded?: boolean;
}) {
  const { confirm, confirmation } = useConfirmation();
  const activity =
    data.serving?.find((unit) => unit.id === initial?.id) ?? initial;
  const loaded = activity?.members.some((m) => active(m));
  const mode: ApplyMode = loaded
    ? activity?.inflight
      ? 'idle'
      : 'reload'
    : 'apply';
  const selectedMode = useRef<ApplyMode | null>(null);
  const [proposed, setProposed] = useState(false);
  const {
    form,
    value,
    setValue,
    changed: draftChanged,
    reset,
  } = useDraftForm<DeploymentSetDraft>(
    {
      name: 'New pool',
      engine_pool: true,
      max_loaded: 4,
      residency: 'on-demand',
      priority: 50,
      idle_timeout: 300,
      allow_eviction: false,
      enabled: true,
      queue_timeout: 300,
      ...(initial
        ? {
            id: initial.id,
            name: initial.name,
            engine_pool: initial.engine_pool ?? false,
            runtime_id: initial.runtime_id ?? null,
            gpu: initial.gpu ?? null,
            port: initial.port ?? null,
            max_loaded: initial.max_loaded ?? 4,
            residency: initial.residency || 'on-demand',
            priority: initial.priority ?? 50,
            idle_timeout: initial.idle_timeout ?? 300,
            allow_eviction: initial.allow_eviction ?? false,
            enabled: initial.enabled,
            queue_timeout: initial.queue_timeout ?? 300,
          }
        : {}),
      members: (initial?.members || []).map((m) => editable('deployments', m)),
    },
    (draft) => submit(draft),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pendingRevision, setPendingRevision] = useState<number | null>(null),
    [revisionConflict, setRevisionConflict] = useState(false);
  // Mount-time set draft, the reference for touched-vs-adopted fields. It must
  // not follow the live initial, or untouched fields would adopt stale server
  // values during a conflict review.
  const mountSetRef = useRef<DeploymentSetDraft | null>(null);
  if (mountSetRef.current === null)
    mountSetRef.current = deploymentSetToDraft(initial);
  const changed = draftChanged;
  const set = <K extends keyof DeploymentSetDraft>(
    key: K,
    v: DeploymentSetDraft[K],
  ) => setValue((s) => ({ ...s, [key]: v }));
  const submit = async (value: DeploymentSetDraft) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const path =
        '/api/deployment-sets' +
        (initial ? '?expected=' + (pendingRevision ?? initial.revision) : '');
      const result = await readApi(path, contracts.identity, value);
      if (loaded) {
        setProposed(true);
        const accepted = await applyConfiguration(
          result.id,
          selectedMode.current ?? mode,
          confirm,
        );
        selectedMode.current = null;
        if (!accepted) return;
      }
      saved(result.id);
    } catch (e) {
      const detail = message(e);
      if (detail.includes('Revision changed')) {
        // Concurrent change: surface it for review; do NOT call saved() so the
        // form is not reset and the user's edits are kept for the re-write.
        setRevisionConflict(true);
      } else {
        setError(detail);
      }
    } finally {
      setBusy(false);
    }
  };
  async function reviewRevision() {
    if (busy || !initial) return;
    try {
      const status = (await readApi('/api/status', contracts.status)) as {
        serving_deployments?: ServingDeployment[];
      };
      const freshSet = (status.serving_deployments || []).find(
        (d): d is DeploymentSet => d.id === initial.id && d.multi_model,
      );
      if (!freshSet) return;
      setValue(
        reconcileDeep(
          mountSetRef.current!,
          deploymentSetToDraft(freshSet),
          value,
        ) as DeploymentSetDraft,
      );
      setPendingRevision(freshSet.revision);
      setRevisionConflict(false);
      setError('');
    } catch {
      /* Ignore: the user can review again. */
    }
  }
  const Shell = embedded ? EmbeddedEditor : Dialog;
  return (
    <Shell
      title={initial ? initial.name : 'New pool'}
      close={close}
      busy={busy}
      wide
      editor
      changed={changed}
    >
      {confirmation}
      {error && (
        <Alert variant="destructive" className="mb-5" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
            {error}
          </AlertDescription>
        </Alert>
      )}
      <DraftFormProvider value={form}>
        <form
          className="resource-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldSet disabled={busy || proposed}>
            <Field label="Name">
              <Input
                required
                value={value.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <SettingsSection name="lifecycle" title="Availability">
              {value.engine_pool && (
                <>
                  <p className="text-muted-foreground text-sm">
                    Shared engine, device visibility, loading policy and
                    resident-model limit affect every pool member. Resource
                    estimates are per-model advice, not individual shares of the
                    pool process allocation. Unload the entire pool before
                    editing.
                  </p>
                  <Field label="Shared installed engine">
                    <NativeSelect
                      value={value.runtime_id ?? ''}
                      onChange={async (e) => {
                        const runtimeId = e.target.value;
                        if (
                          !(await confirm(
                            'Change the shared engine? Engine-specific options for every pool member will be reset.',
                          ))
                        )
                          return;
                        setValue((previous) => ({
                          ...previous,
                          runtime_id: runtimeId,
                          members: previous.members.map((member) => ({
                            ...member,
                            runtime_id: runtimeId,
                            port: null,
                            config: {},
                            raw_args: [],
                          })),
                        }));
                      }}
                    >
                      {data.runtimes
                        .filter(
                          (runtime) =>
                            runtime.id === value.runtime_id ||
                            (runtime.execution_kind === 'native' &&
                              runtime.engine === 'llama.cpp' &&
                              runtime.capabilities?.flags?.includes(
                                'models-preset',
                              )),
                        )
                        .map((runtime) => (
                          <NativeSelectOption
                            key={runtime.id}
                            value={runtime.id}
                          >
                            {runtime.name}
                          </NativeSelectOption>
                        ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Shared device">
                    <Placement
                      part="gpu"
                      value={{ gpu: value.gpu ?? null }}
                      host={data.host?.[0]}
                      change={(placement) =>
                        setValue((previous) => ({
                          ...previous,
                          gpu: placement.gpu ?? null,
                          members: previous.members.map((member) => ({
                            ...member,
                            gpu: placement.gpu ?? null,
                            port: null,
                          })),
                        }))
                      }
                    />
                  </Field>
                  <Field label="Serving port">
                    <NumberControl
                      label="Serving port"
                      required
                      min={1024}
                      max={65535}
                      value={value.port ?? undefined}
                      change={(v) => set('port', v ?? null)}
                    />
                  </Field>
                </>
              )}
              <Field
                label="Lifecycle owner"
                hint="Runtime pools share one native router and load models independently on request. Pools require one compatible native runtime and shared device visibility."
              >
                <p>
                  {value.engine_pool
                    ? 'Runtime — native model pool'
                    : 'Menagerie — coordinated processes'}
                </p>
              </Field>
              {value.engine_pool && value.allow_eviction && (
                <Field label="Maximum resident models">
                  <NumberControl
                    label="Maximum resident models"
                    min={1}
                    max={128}
                    value={value.max_loaded ?? 4}
                    change={(v) => set('max_loaded', v ?? 4)}
                  />
                </Field>
              )}
              <Field label="Mode">
                <Select
                  disabled={busy || value.engine_pool}
                  items={[
                    { value: 'on-demand', label: 'On demand' },
                    { value: 'pinned', label: 'Pinned' },
                    { value: 'evictable', label: 'Evictable' },
                  ]}
                  value={value.residency}
                  onValueChange={(next) => {
                    if (next) set('residency', next);
                  }}
                >
                  <SelectTrigger aria-label="Mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="on-demand">On demand</SelectItem>
                      <SelectItem value="pinned">Pinned</SelectItem>
                      <SelectItem value="evictable">Evictable</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {value.residency === 'on-demand' && (
                <Duration
                  value={value.idle_timeout}
                  change={(v) => set('idle_timeout', v)}
                />
              )}
              {value.residency !== 'pinned' && (
                <label className="check">
                  <Checkbox
                    checked={value.allow_eviction}
                    onCheckedChange={(checked) =>
                      set('allow_eviction', checked)
                    }
                  />
                  Can unload to make room for another deployment
                </label>
              )}
              <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                <Field label="Priority">
                  <NumberControl
                    label="Priority"
                    required
                    min={0}
                    max={100}
                    value={value.priority}
                    change={(v) => set('priority', v ?? 0)}
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
                    value={value.queue_timeout}
                    change={(v) => set('queue_timeout', v ?? 0)}
                  />
                </Field>
              </CardAdvanced>
              <label className="check">
                <Switch
                  disabled={busy}
                  checked={value.enabled}
                  onCheckedChange={(checked) => set('enabled', checked)}
                />
                Enabled for clients
              </label>
            </SettingsSection>
          </FieldSet>
          <details className="card-advanced">
            <summary className="card-advanced-summary">
              Raw deployment set
            </summary>
            <div className="card-advanced-content">
              <Json value={value} />
            </div>
          </details>
          {revisionConflict && (
            <Alert variant="default" className="mb-5" role="alert">
              <AlertDescription className="whitespace-pre-line">
                This configuration changed elsewhere. Your edits have been kept.
              </AlertDescription>
              <AlertAction>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={busy}
                  onClick={() => void reviewRevision()}
                >
                  Review changes
                </Button>
              </AlertAction>
            </Alert>
          )}
          <div className="dialog-actions configuration-save-bar">
            <span className="muted" role="status">
              {changed ? 'Unsaved changes' : 'All changes saved'}
            </span>
            <Button
              variant="outline"
              type="button"
              disabled={busy || !changed}
              onClick={() => {
                reset();
                setError('');
              }}
            >
              Discard
            </Button>
            {initial && (
              <PendingChanges
                deploymentId={initial.id}
                changed={() => saved(initial.id)}
                onPendingChange={setProposed}
              />
            )}
            {!proposed && (
              <>
                {loaded && Boolean(activity?.inflight) && (
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => {
                      selectedMode.current = 'now';
                    }}
                  >
                    Apply and Reload Now
                  </Button>
                )}
                <Button
                  variant="default"
                  type="submit"
                  disabled={busy}
                  onClick={() => {
                    selectedMode.current = mode;
                  }}
                >
                  {busy
                    ? 'Applying…'
                    : initial
                      ? applyLabels[mode]
                      : 'Save pool'}
                </Button>
              </>
            )}
          </div>
        </form>
      </DraftFormProvider>
    </Shell>
  );
}

export function MultiDeploymentDetail({
  d,
  tab,
  data,
  host,
  actions,
  events,
  saved,
}: {
  d: DeploymentSet;
  tab: string;
  data: Registry;
  host: HostSnapshot;
  actions: DeploymentActions;
  events: OperationEvent[];
  saved: () => void;
}) {
  const logQuery = new URLSearchParams(window.location.hash.split('?')[1]);
  const logRun = logQuery.get('run');
  const memberParam = logQuery.get('member');
  const requestedMember =
    memberParam && d.member_ids.includes(memberParam) ? memberParam : null;
  const [logMember, setLogMember] = useState(
      requestedMember && d.member_ids.includes(requestedMember)
        ? requestedMember
        : d.member_ids[0] || '',
    ),
    [logs, setLogs] = useState(''),
    [error, setError] = useState('');
  const { confirm, confirmation } = useConfirmation();
  async function removeMember(member: Deployment) {
    if (
      !(await confirm(
        `Remove ${member.name} from ${d.name}? Model files and history are kept.`,
      ))
    )
      return;
    try {
      await api(
        `/api/deployment-sets/${d.id}/members/${member.id}/remove?expected=${d.revision}`,
        {},
      );
      saved();
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    if (tab !== 'Logs') return;
    let alive = true;
    const load = () =>
      readApi(
        `/api/deployments/${requestedMember || logMember}/logs${logRun ? '?session_id=' + encodeURIComponent(logRun) : ''}`,
        contracts.logs,
      )
        .then((r) => {
          if (alive) {
            setLogs(r.text);
            setError('');
          }
        })
        .catch((e) => {
          if (alive) setError(message(e));
        });
    setLogs('');
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [logMember, tab, logRun, requestedMember]);
  return (
    <>
      {confirmation}
      <a className="back-link" href="#/deployments">
        <ArrowLeft size={16} />
        Deployments
      </a>
      <div className="page-head">
        <div>
          <h1>{d.name}</h1>
          <Status value={state(d)} />
        </div>
        <div className="actions">
          {!active(d) && d.enabled && (
            <Button
              variant="default"
              type="button"
              onClick={() => actions.load('serving-deployments', d)}
            >
              Load
            </Button>
          )}
          {active(d) && d.state !== 'STOPPING' && (
            <Button
              variant="outline"
              type="button"
              onClick={() => actions.stop('serving-deployments', d)}
            >
              Unload
            </Button>
          )}
        </div>
      </div>
      {d.lifecycle?.failure && (
        <Alert variant="destructive" role="alert" className="mb-5">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
            {d.lifecycle.failure}
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" role="alert" className="mb-5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Tabs
        items={['Models', 'Configuration', 'Activity', 'Requests', 'Logs']}
        value={tab}
        onChange={(t) => go(`deployments/${d.id}/${t.toLowerCase()}`)}
      />
      {(tab === 'Configuration' || tab === 'Policy') && (
        <>
          <DeploymentSetEditor
            key={`${d.id}-${d.revision}`}
            initial={d}
            data={data}
            close={() => {}}
            saved={saved}
            embedded
          />
        </>
      )}
      {tab === 'Requests' && (
        <RequestHistory deploymentId={d.id} deployments={data.deployments} />
      )}
      {tab === 'Models' && (
        <>
          <div className="stats">
            <Card className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3">
              <CardHeader className="p-0 pb-3">
                <CardDescription>Models ready</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 p-0">
                <strong>
                  {d.members.filter((m) => m.state === 'READY').length}{' '}
                  <small>/ {d.members.length}</small>
                </strong>
              </CardContent>
            </Card>
            <Card className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3">
              <CardHeader className="p-0 pb-3">
                <CardDescription>VRAM</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 p-0">
                <strong>
                  {gib(unitVram(d, host))} <small>GiB</small>
                </strong>
              </CardContent>
            </Card>
            <Card className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3">
              <CardHeader className="p-0 pb-3">
                <CardDescription>Active requests</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 p-0">
                <strong>{d.inflight || 0}</strong>
              </CardContent>
            </Card>
          </div>
          <div className="model-grid">
            {d.members.map((m) => {
              const artifact =
                data.models?.find(
                  (a) => a.id === m.profile_snapshot?.artifact_id,
                ) || undefined;
              return (
                <Card
                  className="mb-5 min-w-0 gap-0 p-0 library-card"
                  key={m.id}
                >
                  <CardContent className="p-0">
                    <Status value={state(m)} />
                    <h2>{m.name}</h2>
                    <dl className="properties">
                      <dt>API model</dt>
                      <dd>
                        <code>{m.alias}</code>
                      </dd>
                      {artifact?.repo ? (
                        <>
                          <dt>Model</dt>
                          <dd className="copy-value">
                            <code>{artifact.repo || artifact.name}</code>
                            <button
                              type="button"
                              className="view-model"
                              onClick={() =>
                                go(
                                  repoPath(artifact.repo || '', {
                                    revision:
                                      artifact.source_revision || undefined,
                                    returnTo:
                                      window.location.hash.slice(2) ||
                                      'deployments',
                                  }),
                                )
                              }
                            >
                              View model
                            </button>
                          </dd>
                        </>
                      ) : null}
                      <dt>Context / request</dt>
                      <dd>
                        {number(
                          m.profile_snapshot?.catalog?.model?.limit?.context,
                          0,
                        )}
                      </dd>
                      <dt>VRAM (GiB)</dt>
                      <dd>{gib(host.deployments?.[m.id]?.gpu_mib)}</dd>
                    </dl>
                    <div className="card-actions">
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => go(`deployments/${m.id}/configuration`)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => {
                          setLogMember(m.id);
                          go(`deployments/${d.id}/logs`);
                        }}
                      >
                        Logs
                      </Button>
                      <Button
                        variant="destructive"
                        type="button"
                        disabled={active(m)}
                        onClick={() => void removeMember(m)}
                      >
                        Remove
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
      {tab === 'Models' &&
        d.members.map((m) => (
          <DeploymentPerformance key={m.id} deployment={m} />
        ))}
      {tab === 'Models' &&
        [
          ...new Set(
            d.members
              .map((m) => m.profile_snapshot?.artifact_id)
              .filter((id): id is string => !!id),
          ),
        ].map((id) => <ResourceHistory key={id} artifactId={id} />)}
      {tab === 'Policy' && (
        <Card className="mb-5 min-w-0 gap-0 p-5">
          <CardContent className="p-0">
            <dl className="properties">
              <dt>Mode</dt>
              <dd>{mode(d)}</dd>
              {d.residency === 'on-demand' && (
                <>
                  <dt>Unload after idle</dt>
                  <dd>
                    {d.idle_timeout ? `${d.idle_timeout} seconds` : 'Never'}
                  </dd>
                </>
              )}
              <dt>Automatic eviction</dt>
              <dd>
                {d.residency !== 'pinned' && d.allow_eviction
                  ? 'Allowed'
                  : 'Not allowed'}
              </dd>
              <dt>Priority</dt>
              <dd>{d.priority}</dd>
              <dt>Client discovery</dt>
              <dd>{d.lifecycle?.serving ? 'Available' : 'Not listed'}</dd>
              <dt>Switch timeout</dt>
              <dd>{d.queue_timeout} seconds</dd>
            </dl>
          </CardContent>
        </Card>
      )}
      {tab === 'Activity' && (
        <Card className="mb-5 min-w-0 gap-0 p-0">
          <CardContent className="p-0">
            <ActivityFeed
              events={events.filter(
                (e) =>
                  e.deployment_id === d.id ||
                  (typeof e.deployment_id === 'string' &&
                    d.member_ids.includes(e.deployment_id)),
              )}
              deployments={[...(data.deployments || []), d]}
            />
          </CardContent>
        </Card>
      )}
      {tab === 'Logs' && (
        <Card className="mb-5 min-w-0 gap-0 p-5">
          <CardContent className="p-0">
            <Field label="Model">
              <NativeSelect
                value={requestedMember || logMember}
                onChange={(e) => {
                  setLogMember(e.target.value);
                  go(`deployments/${d.id}/logs`);
                }}
              >
                {d.members.map((m) => (
                  <NativeSelectOption key={m.id} value={m.id}>
                    {m.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <pre tabIndex={0}>{logs || 'Loading logs…'}</pre>
          </CardContent>
        </Card>
      )}
    </>
  );
}
