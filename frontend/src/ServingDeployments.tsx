import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Fragment, useEffect, useState } from 'react';
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
  telemetryStale,
  type Registry,
} from './ui';
import { ActivityFeed } from './Views';
import { go } from './navigation';
import { ConfigurationFields } from './Editors';
import { ChatTemplateSettings } from './ChatTemplateSettings';
import { defaults, editable } from './editor-state';
import { Duration, Placement } from './FormControls';
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
import { readApi } from './ui';
import * as contracts from './contracts';
import { artifactLimits } from './artifact-metadata';
import type {
  Deployment,
  DeploymentActions,
  DeploymentDraft,
  DeploymentSet,
  DeploymentSetDraft,
  GpuSnapshot,
  HostSnapshot,
  OperationEvent,
  RuntimeField,
  ServingDeployment,
} from './types';

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
  function primary(d: ServingDeployment, menu = false) {
    const label = !d.enabled ? 'Enable' : active(d) ? 'Unload' : 'Load';
    const onClick = () =>
      !d.enabled
        ? actions.enable(d, true)
        : active(d)
          ? actions.stop('serving-deployments', d)
          : actions.load('serving-deployments', d);
    if (d.state === 'STOPPING') return null;
    return menu ? (
      <DropdownMenuItem onClick={onClick}>{label}</DropdownMenuItem>
    ) : (
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
            <TableHead>Deployment</TableHead>
            <TableHead>State</TableHead>
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
            <TableHead className="numeric">Requests</TableHead>
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
              <TableRow>
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
                    </div>
                  </div>
                  {d.lifecycle?.failure && (
                    <small className="error-text">{d.lifecycle.failure}</small>
                  )}
                </TableCell>
                <TableCell>
                  <Status value={state(d)} />
                </TableCell>
                <TableCell>{mode(d)}</TableCell>
                <TableCell className="numeric">
                  {gib(unitVram(d, host))}
                </TableCell>
                <TableCell className="numeric">{d.inflight || 0}</TableCell>
                {!compact && (
                  <TableCell>
                    <div className="actions">
                      {primary(d)}
                      <Menu label={'Actions for ' + d.name}>
                        <DropdownMenuItem
                          onClick={() => go('deployments/' + d.id)}
                        >
                          Details
                        </DropdownMenuItem>
                        {primary(d, true)}
                        <DropdownMenuItem
                          disabled={active(d)}
                          onClick={() =>
                            actions.edit(
                              d.multi_model ? 'deployment_sets' : 'deployments',
                              d,
                            )
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
                            Disable for clients
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
                      <a href={'#/deployments/' + d.id + '/models'}>
                        {member.name}
                      </a>
                    </TableCell>
                    <TableCell>
                      <Status value={state(member)} />
                    </TableCell>
                    <TableCell />
                    <TableCell className="numeric">
                      {gib(host.deployments?.[member.id]?.gpu_mib)}
                    </TableCell>
                    <TableCell className="numeric">
                      {member.inflight || 0}
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
}: {
  initial?: DeploymentSet;
  modelId?: string;
  data: Registry;
  close: () => void;
  saved: (id: string) => void;
}) {
  const { confirm, confirmation } = useConfirmation();
  const [value, setValue] = useState<DeploymentSetDraft>({
    name: 'New deployment',
    residency: 'on-demand',
    priority: 50,
    idle_timeout: 300,
    allow_eviction: false,
    allow_uncertain: false,
    enabled: true,
    queue_timeout: 300,
    ...(initial
      ? {
          id: initial.id,
          name: initial.name,
          residency: initial.residency || 'on-demand',
          priority: initial.priority ?? 50,
          idle_timeout: initial.idle_timeout ?? 300,
          allow_eviction: initial.allow_eviction ?? false,
          allow_uncertain: initial.allow_uncertain ?? false,
          enabled: initial.enabled,
          queue_timeout: initial.queue_timeout ?? 300,
        }
      : {}),
    members: (initial?.members || []).map((m) => editable('deployments', m)),
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [separate, setSeparate] = useState(false);
  const [artifactId, setArtifactId] = useState(
      modelId || data.models?.[0]?.id || '',
    ),
    [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState(0);
  const preview = useResourcePreview(value.members, data.host?.[0]?.ts);
  const [original] = useState(() => JSON.stringify(value));
  const changed =
    JSON.stringify(value) !== original || Object.values(invalid).some(Boolean);
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
      compatible.find((r) => r.engine === recommended) || compatible[0];
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
    const schema: Record<string, RuntimeField> =
      runtime?.capabilities?.schema || {};
    const config: Record<string, import('./types').JsonValue> = {};
    for (const [key, field] of Object.entries(schema)) {
      if (field.default === undefined) continue;
      config[key] =
        ['threads', 'threads-batch'].includes(key) &&
        typeof field.default === 'number' &&
        data.host[0]?.cpu_count
          ? Math.min(field.default, data.host[0].cpu_count)
          : field.default;
    }
    if (runtime?.managed?.backend === 'cpu') config['gpu-layers'] = '0';
    const { context: modelContext } = artifactLimits(model);
    if (modelContext)
      for (const key of ['ctx-size', 'max-model-len'])
        if (typeof config[key] === 'number')
          config[key] = Math.min(config[key], modelContext);
    const gpus = data.host?.[0]?.gpus || [];
    const gpu =
      [...gpus].sort(
        (a: GpuSnapshot, b: GpuSnapshot) =>
          (b.free_mib ?? 0) -
          (preview.data?.gpus?.find((g) => g.index === b.index)?.draft_mib ||
            0) -
          ((a.free_mib ?? 0) -
            (preview.data?.gpus?.find((g) => g.index === a.index)?.draft_mib ||
              0)),
      )[0]?.index ?? 0;
    const member: DeploymentDraft = {
      ...defaults.deployments,
      name: model.name,
      alias,
      port,
      gpu,
      configuration: {
        name: model.name,
        artifact_id: model.id,
        runtime_id: runtime?.id || '',
        config,
        raw_args: [],
        catalog: {},
      },
    };
    set('members', [...value.members, member]);
    setSelected(value.members.length);
    setError('');
    setBusy(true);
    try {
      if (!runtime) return;
      const budget = await readApi(
        '/api/resources/preview',
        contracts.resourcePreview,
        {
          members: [...value.members, member],
        },
      );
      const rec = budget.members.at(-1)?.recommendation;
      const contextKey = rec?.context_key;
      const contextDefault = rec?.context_default;
      if (typeof contextDefault === 'number' && contextKey)
        setValue((v) => ({
          ...v,
          members: v.members.map((m) =>
            m.port === port &&
            m.configuration &&
            JSON.stringify(m.configuration?.config) === JSON.stringify(config)
              ? {
                  ...m,
                  configuration: {
                    ...m.configuration,
                    config: {
                      ...config,
                      [contextKey]: contextDefault,
                    },
                  },
                }
              : m,
          ),
        }));
    } catch {
      /* Keep engine defaults when telemetry/preview is unavailable; the preview explains the gap. */
    } finally {
      setBusy(false);
    }
  }
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const single = !initial && value.members.length === 1;
      const path =
        (single ? '/api/deployments' : '/api/deployment-sets') +
        (initial ? '?expected=' + initial.revision : '');
      const shared = {
        residency: value.residency,
        priority: value.priority,
        idle_timeout: value.idle_timeout,
        allow_eviction: value.allow_eviction,
        allow_uncertain: value.allow_uncertain,
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
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
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
          void submit();
        }}
      >
        <FieldSet disabled={busy}>
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
                <ConfigurationFields
                  value={m.configuration!}
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
                />
                {m.configuration && (
                  <ChatTemplateSettings
                    label="Chat template"
                    model={data.models.find(
                      (x) => x.id === m.configuration?.artifact_id,
                    )}
                    override={m.template_override || null}
                    onChange={(selection) =>
                      updateMember(index, { template_override: selection })
                    }
                  />
                )}
                <details>
                  <summary>Placement</summary>
                  <Placement
                    value={m}
                    change={(v) => updateMember(index, v)}
                    host={data.host?.[0]}
                  />
                </details>
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
          <Field label="Mode">
            <Select
              disabled={busy}
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
                onCheckedChange={(checked) => set('allow_eviction', checked)}
              />
              Can unload to make room for another deployment
            </label>
          )}
          {value.residency === 'on-demand' && (
            <label className="check">
              <Checkbox
                checked={value.allow_uncertain}
                onCheckedChange={(checked) => set('allow_uncertain', checked)}
              />
              Allow on-demand loading with uncertain memory estimates
            </label>
          )}
          <details>
            <summary>Advanced</summary>
            <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
              <Field label="Priority">
                <Input
                  required
                  type="number"
                  min={0}
                  max={100}
                  value={value.priority}
                  onChange={(e) => set('priority', Number(e.target.value))}
                />
              </Field>
              <Field label="Switch timeout (seconds)">
                <Input
                  required
                  type="number"
                  min={1}
                  max={1800}
                  value={value.queue_timeout}
                  onChange={(e) => set('queue_timeout', Number(e.target.value))}
                />
              </Field>
            </FieldGroup>
            <label className="check">
              <Switch
                disabled={busy}
                checked={value.enabled}
                onCheckedChange={(checked) => set('enabled', checked)}
              />
              Enabled for clients
            </label>
          </details>
        </FieldSet>
        {value.members.length > 0 && (
          <DraftResources preview={preview.data} error={preview.error} />
        )}
        <div className="dialog-actions">
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
    </Dialog>
  );
}

export function MultiDeploymentDetail({
  d,
  tab,
  data,
  host,
  actions,
  events,
}: {
  d: DeploymentSet;
  tab: string;
  data: Registry;
  host: HostSnapshot;
  actions: DeploymentActions;
  events: OperationEvent[];
}) {
  const [logMember, setLogMember] = useState(d.member_ids[0] || ''),
    [logs, setLogs] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    if (tab !== 'Logs') return;
    let alive = true;
    const load = () =>
      readApi(`/api/deployments/${logMember}/logs`, contracts.logs)
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
  }, [logMember, tab]);
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
          <Button
            variant="outline"
            type="button"
            disabled={active(d)}
            onClick={() => actions.edit('deployment_sets', d)}
          >
            Edit
          </Button>
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
        items={['Models', 'Policy', 'Activity', 'Logs']}
        value={tab}
        onChange={(t) => go(`deployments/${d.id}/${t.toLowerCase()}`)}
      />
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
            {d.members.map((m) => (
              <Card className="mb-5 min-w-0 gap-0 p-0 library-card" key={m.id}>
                <CardContent className="p-0">
                  <Status value={state(m)} />
                  <h2>{m.name}</h2>
                  <dl className="properties">
                    <dt>API model</dt>
                    <dd>
                      <code>{m.alias}</code>
                    </dd>
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
                      disabled={active(d)}
                      onClick={() =>
                        actions.edit('deployments', {
                          ...m,
                          unit_id: d.id,
                          member_only: true,
                        })
                      }
                    >
                      Edit model
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
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
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
                value={logMember}
                onChange={(e) => setLogMember(e.target.value)}
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
