import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { FieldSet, FieldLegend, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Card,
  CardHeader,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Fragment, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import {
  active,
  api,
  Dialog,
  Empty,
  Field,
  gib,
  Menu,
  message,
  mode,
  number,
  state,
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
import { ConfigurationFields } from './Editors';
import { DraftFormProvider, useDraftForm } from './use-draft-form';
import { ChatTemplateSettings } from './ChatTemplateSettings';
import { defaults, editable } from './editor-state';
import { Duration, Placement } from './FormControls';
import { NumberControl } from './NumberControl';
import { DraftResources } from './Resources';
import { useResourcePreview } from './hooks/use-resource-preview';
import { useConfirmation } from '@/hooks/use-confirmation';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
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
  DeploymentDraft,
  DeploymentSet,
  DeploymentSetDraft,
  HostSnapshot,
  OperationEvent,
  ServingDeployment,
} from './types';

export function ConfiguredModelsTable({
  rows,
  actions,
}: {
  rows: Deployment[];
  actions: DeploymentActions;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>API model ID</TableHead>
          <TableHead>Availability</TableHead>
          <TableHead>Residency</TableHead>
          <TableHead>Active requests</TableHead>
          <TableHead>Total requests</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((model) => (
          <TableRow key={model.id}>
            <TableCell>
              <a href={`#/deployments/${model.id}`}>{model.name}</a>
              {model.state === 'FAILED' && (
                <p>
                  <a href={`#/deployments/${model.id}/logs`}>View logs</a>
                </p>
              )}
              {model.changes_pending && <p>Changes pending</p>}
            </TableCell>
            <TableCell>
              <code>{model.alias}</code>
              {model.active_alias && model.active_alias !== model.alias && (
                <p>Currently serving: {model.active_alias}</p>
              )}
            </TableCell>
            <TableCell>
              {model.changes_pending
                ? 'Changes pending'
                : model.enabled
                  ? 'Available'
                  : 'Disabled'}
            </TableCell>
            <TableCell>
              {model.state === 'FAILED'
                ? 'Failed'
                : model.runtime_observation?.residency === 'resident' ||
                    (!model.engine_pool &&
                      model.state === 'READY' &&
                      !model.runtime_observation)
                  ? 'Loaded'
                  : model.runtime_observation?.residency === 'loading' ||
                      ['STARTING', 'LOADING'].includes(model.state)
                    ? 'Loading'
                    : model.state === 'STOPPING'
                      ? 'Unloading'
                      : 'Not loaded'}
            </TableCell>
            <TableCell>{model.inflight || 0}</TableCell>
            <TableCell>{model.historical_requests || 0}</TableCell>
            <TableCell>
              {model.member_availability !== false && (
                <Button
                  variant="outline"
                  disabled={model.changes_pending}
                  onClick={() =>
                    model.enabled
                      ? actions.load('deployments', model)
                      : actions.enable(model, true)
                  }
                >
                  {model.enabled ? 'Review and load' : 'Make available'}
                </Button>
              )}
              <Menu label={'Actions for ' + model.name}>
                <DropdownMenuItem
                  render={
                    <a href={`#/deployments/${model.id}/configuration`} />
                  }
                >
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => actions.edit('deployments', model, true)}
                >
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem
                  render={<a href={`#/deployments/${model.id}/logs`} />}
                >
                  Logs
                </DropdownMenuItem>
                {model.member_availability !== false && model.enabled && (
                  <DropdownMenuItem
                    disabled={model.changes_pending}
                    onClick={() => actions.enable(model, false)}
                  >
                    Disable
                  </DropdownMenuItem>
                )}
              </Menu>
              {model.unit_id && model.unit_id !== model.id ? (
                <a href={`#/deployments/${model.unit_id}`}>
                  Advanced runtime controls
                </a>
              ) : (
                active(model) && (
                  <Button
                    variant="outline"
                    onClick={() => actions.stop('deployments', model)}
                  >
                    Unload model
                  </Button>
                )
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
}: {
  rows: ServingDeployment[];
  host: HostSnapshot;
  actions: DeploymentActions;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
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
                        <small className="muted">
                          {d.members.length} models
                        </small>
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
                        <DropdownMenuItem
                          render={
                            <a href={`#/deployments/${d.id}/configuration`} />
                          }
                        >
                          Edit
                        </DropdownMenuItem>
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
  modelId,
  data,
  close,
  saved,
  embedded = false,
}: {
  initial?: DeploymentSet;
  modelId?: string;
  data: Registry;
  close: () => void;
  saved: (id: string) => void;
  embedded?: boolean;
}) {
  const { confirm, confirmation } = useConfirmation();
  const {
    form,
    value,
    setValue,
    changed: draftChanged,
    reset,
  } = useDraftForm<DeploymentSetDraft>(
    {
      name: 'New deployment',
      engine_pool: false,
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
    [separate, setSeparate] = useState(false),
    [pendingRevision, setPendingRevision] = useState<number | null>(null),
    [revisionConflict, setRevisionConflict] = useState(false);
  const [artifactId, setArtifactId] = useState(
      modelId || data.models?.[0]?.id || '',
    ),
    [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState(0);
  const preview = useResourcePreview(value.members, data.host?.[0]?.ts);
  const [epoch, setEpoch] = useState(0);
  // Mount-time set draft, the reference for touched-vs-adopted fields. It must
  // not follow the live initial, or untouched fields would adopt stale server
  // values during a conflict review.
  const mountSetRef = useRef<DeploymentSetDraft | null>(null);
  if (mountSetRef.current === null)
    mountSetRef.current = deploymentSetToDraft(initial);
  const changed = draftChanged || Object.values(invalid).some(Boolean);
  const aliasError = (m: DeploymentDraft) =>
    value.members.some((other) => other !== m && other.alias === m.alias) ||
    (data.deployments || []).some(
      (other) =>
        other.alias === m.alias &&
        !value.members.some((member) => member.id === other.id),
    );
  const set = <K extends keyof DeploymentSetDraft>(
    key: K,
    v: DeploymentSetDraft[K],
  ) => setValue((s) => ({ ...s, [key]: v }));
  const updateMember = (index: number, change: Partial<DeploymentDraft>) =>
    setValue((v) => ({
      ...v,
      members: v.members.map((m, i) => (i === index ? { ...m, ...change } : m)),
    }));
  const idleMinutes =
    value.idle_timeout && value.idle_timeout % 60 === 0
      ? value.idle_timeout / 60
      : undefined;
  const sharedPolicy = [
    value.residency === 'pinned'
      ? 'Pinned'
      : value.residency === 'evictable'
        ? 'Evictable'
        : 'On demand',
    `priority ${value.priority}`,
    value.residency === 'on-demand'
      ? value.idle_timeout
        ? `unload after ${idleMinutes ? `${idleMinutes} min` : `${value.idle_timeout}s`} idle`
        : 'never unload'
      : 'always resident',
    value.allow_eviction ? 'may unload for others' : 'no eviction',
    `queue ${value.queue_timeout}s`,
    value.enabled ? 'enabled for clients' : 'disabled for clients',
  ].join(' · ');
  async function addModel() {
    const model = data.models?.find((m) => m.id === artifactId);
    if (!model) {
      setError('Choose a model first.');
      return;
    }
    setBusy(true);
    let recommended: string | null = null;
    try {
      recommended =
        (
          await readApi(
            `/api/models/${model.id}/engine-recommendation`,
            contracts.engineRecommendation,
          )
        ).engine || null;
    } catch {
      /* Manual selection remains available. */
    }
    const compatible = (data.runtimes || []).filter(
      (r) =>
        model.format === 'unknown' ||
        r.capabilities?.formats?.includes(model.format),
    );
    const runtime =
      value.engine_pool && value.members.length
        ? compatible.find(
            (r) => r.id === value.members[0].configuration?.runtime_id,
          )
        : compatible.find((r) => r.engine === recommended) || compatible[0];
    if (value.engine_pool && value.members.length && !runtime) {
      setError('This model is incompatible with the shared pool engine.');
      setBusy(false);
      return;
    }
    const used = [...(data.deployments || []), ...value.members];
    const slug = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || 'model';
    const base = slug(value.name) + '-' + slug(model.name).slice(0, 40);
    let alias = base,
      suffix = 2;
    while (used.some((m) => m.alias === alias)) alias = base + '-' + suffix++;
    const port = Array.from({ length: 50000 }, (_, i) => 8120 + i).find(
      (p) => !used.some((m) => m.port === p),
    );
    if (port === undefined) {
      setError('No free private port is available.');
      setBusy(false);
      return;
    }
    const config: Record<string, import('./types').JsonValue> = {};
    const member: DeploymentDraft = {
      ...defaults.deployments,
      name: model.name,
      alias,
      port,
      gpu: null,
      configuration: {
        name: model.name,
        artifact_id: model.id,
        runtime_id: runtime?.id || '',
        config,
        raw_args: [],
        catalog: structuredClone(defaults.profiles.catalog),
      },
    };
    set('members', [...value.members, member]);
    setSelected(value.members.length);
    setError('');
    setBusy(false);
  }
  const submit = async (value: DeploymentSetDraft) => {
    if (busy || Object.values(invalid).some(Boolean)) return;
    setBusy(true);
    setError('');
    try {
      const single =
        !initial && value.members.length === 1 && !value.engine_pool;
      const path =
        (single ? '/api/deployments' : '/api/deployment-sets') +
        (initial ? '?expected=' + (pendingRevision ?? initial.revision) : '');
      const shared = {
        residency: value.residency,
        priority: value.priority,
        idle_timeout: value.idle_timeout,
        allow_eviction: value.allow_eviction,
        enabled: value.enabled,
        queue_timeout: value.queue_timeout,
      };
      const payload = single
        ? {
            ...value.members[0],
            name: value.name,
            ...shared,
          }
        : value;
      const result = await readApi(path, contracts.identity, payload);
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
      title={initial ? initial.name : 'New deployment'}
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
          onInvalidCapture={(e) => {
            const target = e.target as HTMLElement;
            const section = target.closest<HTMLElement>('[data-model-index]');
            if (section) setSelected(Number(section.dataset.modelIndex));
            target.closest('details')?.setAttribute('open', '');
          }}
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldSet key={epoch} disabled={busy}>
            <Field label="Name">
              <Input
                required
                value={value.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <FieldSet className="model-composer">
              <FieldLegend>Models</FieldLegend>
              <Field label="Add installed model">
                <NativeSelect
                  value={artifactId}
                  onChange={(e) => setArtifactId(e.target.value)}
                >
                  {(data.models || []).map((m) => (
                    <NativeSelectOption key={m.id} value={m.id}>
                      {m.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Button
                variant="outline"
                type="button"
                disabled={!artifactId}
                onClick={addModel}
              >
                Add model
              </Button>
              <div className="model-switcher">
                <ToggleGroup
                  variant="outline"
                  aria-label="Models"
                  value={[String(selected)]}
                  onValueChange={(next) => {
                    if (next.length) setSelected(Number(next[0]));
                  }}
                >
                  {value.members.map((m, index: number) => (
                    <ToggleGroupItem key={m.id || m.port} value={String(index)}>
                      {m.name || `Model ${index + 1}`}
                      {invalid[m.id || m.port] || aliasError(m)
                        ? ' · Check settings'
                        : ''}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              {value.members.map((m, index: number) => (
                <section
                  hidden={selected !== index}
                  data-model-index={index}
                  className="model-edit-section"
                  key={m.id || m.port}
                >
                  <h3>{m.name}</h3>
                  <p className="text-muted-foreground text-sm">
                    Shared policy: {sharedPolicy}. Loading policy, priority,
                    idle unload, eviction and the queue timeout belong to this
                    deployment set; edit them once in Availability.
                  </p>
                  <Field label="Model display name">
                    <Input
                      required
                      value={m.name}
                      onChange={(e) =>
                        updateMember(index, { name: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="API model ID">
                    <Input
                      required
                      aria-label="API model ID"
                      aria-invalid={aliasError(m)}
                      pattern="[a-zA-Z0-9][a-zA-Z0-9_.\/\-]{0,159}"
                      value={m.alias}
                      onChange={(e) =>
                        updateMember(index, { alias: e.target.value })
                      }
                    />
                    {aliasError(m) && (
                      <small className="error-text" role="alert">
                        This API model ID is already in use.
                      </small>
                    )}
                  </Field>
                  <div className="configuration-grid">
                    <ConfigurationFields
                      formPath={`members[${index}].configuration.config`}
                      value={m.configuration!}
                      deploymentId={m.id}
                      templateOverride={m.template_override}
                      runtimeLocked={Boolean(value.engine_pool)}
                      observed={
                        data.deployments?.find((entry) => entry.id === m.id)
                          ?.runtime_observation?.resolved
                      }
                      observedAt={
                        data.deployments?.find((entry) => entry.id === m.id)
                          ?.runtime_observation?.observed_at
                      }
                      data={data}
                      set={(configuration) =>
                        updateMember(index, { configuration })
                      }
                      onValid={(valid) =>
                        setInvalid((v) => ({ ...v, [m.id || m.port]: !valid }))
                      }
                      recommendation={
                        preview.data?.members?.[index]?.recommendation
                      }
                      modelFields={
                        m.configuration && (
                          <ChatTemplateSettings
                            label="Chat template"
                            model={data.models.find(
                              (x) => x.id === m.configuration?.artifact_id,
                            )}
                            override={m.template_override || null}
                            onChange={(selection) =>
                              updateMember(index, {
                                template_override: selection,
                              })
                            }
                          />
                        )
                      }
                      placementFields={
                        value.engine_pool ? (
                          <p className="text-muted-foreground text-sm">
                            Process visibility is shared by all{' '}
                            {value.members.length} pool members. Edit shared
                            devices in Availability. Model-server options below
                            belong to this child preset; native routing and
                            residency remain pool-controlled.
                          </p>
                        ) : (
                          <Placement
                            part="gpu"
                            value={m}
                            change={(v) => updateMember(index, v)}
                            host={data.host?.[0]}
                          />
                        )
                      }
                    />
                  </div>
                  <Button
                    variant="destructive"
                    type="button"
                    onClick={async () => {
                      if (
                        m.id &&
                        !(await confirm(
                          'Remove this model from the deployment? It will be kept as an inactive standalone configuration.',
                        ))
                      )
                        return;
                      set(
                        'members',
                        value.members.filter((_, i) => i !== index),
                      );
                      setSelected(Math.max(0, selected - 1));
                      setInvalid((v) => ({ ...v, [m.id || m.port]: false }));
                    }}
                  >
                    Remove model
                  </Button>
                </section>
              ))}
            </FieldSet>
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
                      value={value.members[0]?.configuration?.runtime_id || ''}
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
                          members: previous.members.map((member) => ({
                            ...member,
                            configuration: member.configuration
                              ? {
                                  ...member.configuration,
                                  runtime_id: runtimeId,
                                  config: {},
                                  raw_args: [],
                                }
                              : undefined,
                          })),
                        }));
                      }}
                    >
                      {data.runtimes
                        .filter(
                          (runtime) =>
                            runtime.id ===
                              value.members[0]?.configuration?.runtime_id ||
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
                  {value.members[0] && (
                    <Placement
                      part="gpu"
                      value={value.members[0]}
                      host={data.host?.[0]}
                      change={(placement) =>
                        setValue((previous) => ({
                          ...previous,
                          members: previous.members.map((member) => ({
                            ...member,
                            gpu: placement.gpu,
                          })),
                        }))
                      }
                    />
                  )}
                </>
              )}
              <Field
                label="Lifecycle owner"
                hint="Runtime pools share one native router and load models independently on request. Pinned and atomic groups use supervised processes. Pools require one compatible native runtime and shared device visibility."
              >
                <NativeSelect
                  value={value.engine_pool ? 'runtime' : 'supervisor'}
                  onChange={(e) => {
                    set('engine_pool', e.target.value === 'runtime');
                    if (e.target.value === 'runtime')
                      set('residency', 'on-demand');
                  }}
                >
                  <NativeSelectOption value="supervisor">
                    Menagerie — coordinated processes
                  </NativeSelectOption>
                  <NativeSelectOption value="runtime">
                    Runtime — native model pool
                  </NativeSelectOption>
                </NativeSelect>
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
                {!value.engine_pool &&
                  value.members.map((member, index) => (
                    <FieldSet key={member.id || member.port}>
                      <FieldLegend>{member.name} endpoint</FieldLegend>
                      <Placement
                        part="network"
                        value={member}
                        change={(placement) => updateMember(index, placement)}
                        host={data.host?.[0]}
                      />
                    </FieldSet>
                  ))}
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
          {value.members.length > 0 && (
            <DraftResources preview={preview.data} error={preview.error} />
          )}
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
                setInvalid({});
                setSelected(0);
                setEpoch((v) => v + 1);
                setError('');
              }}
            >
              Discard
            </Button>
            {initial && value.members.length > 1 && (
              <Button
                variant="destructive"
                type="button"
                disabled={busy}
                onClick={() => setSeparate(true)}
              >
                Separate models…
              </Button>
            )}
            <Button
              variant="default"
              type="submit"
              disabled={
                busy ||
                value.members.length < 1 ||
                value.members.some(aliasError) ||
                Object.values(invalid).some(Boolean)
              }
            >
              {busy ? 'Saving…' : 'Save deployment'}
            </Button>
          </div>
        </form>
      </DraftFormProvider>
      {separate && (
        <section className="warning">
          <p>
            Make each model a standalone deployment? Current shared policies
            will be kept.
          </p>
          <Button
            variant="destructive"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(
                  `/api/deployment-sets/${initial!.id}/dissolve?expected=${initial!.revision}`,
                  {},
                );
                saved('');
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Separate models
          </Button>
        </section>
      )}
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
      <Tabs
        items={['Models', 'Configuration', 'Activity', 'Requests', 'Logs']}
        value={tab}
        onChange={(t) => go(`deployments/${d.id}/${t.toLowerCase()}`)}
      />
      {(tab === 'Configuration' || tab === 'Policy') && (
        <>
          {active(d) ? (
            <p>Unload this deployment before changing its configuration.</p>
          ) : (
            <DeploymentSetEditor
              key={`${d.id}-${d.revision}`}
              initial={d}
              data={data}
              close={() => {}}
              saved={saved}
              embedded
            />
          )}
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
                        onClick={() => {
                          setLogMember(m.id);
                          go(`deployments/${d.id}/logs`);
                        }}
                      >
                        Logs
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
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            <pre tabIndex={0}>{logs || 'Loading logs…'}</pre>
          </CardContent>
        </Card>
      )}
    </>
  );
}
