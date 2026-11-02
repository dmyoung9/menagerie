import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus } from 'lucide-react';
import {
  active,
  api,
  CopyButton,
  Dialog,
  Empty,
  Field,
  Json,
  Menu,
  isRecord,
  message,
  mode,
  number,
  state,
  Status,
  Tabs,
  templateKindLabel,
  visible,
  type Registry,
} from './ui';
import { ModelCard } from './ModelCard';
import { ResourceHistory } from '@/components/resource-history';
import { InstalledVariants } from '@/components/installed-variants';
import { CapabilityBadges } from '@/components/capability-badges';
import { EventFeed } from '@/components/event-feed';
import { DeploymentConfiguration } from '@/components/deployment-configuration';
import { DeploymentPerformance } from '@/components/deployment-performance';
import { RequestHistory } from '@/components/request-history';
import { HistorySettings } from '@/components/history-settings';
import { PolicyEditor } from './Operations';
import { memory } from '@/lib/formatters';
import { EngineCatalog } from './EngineCatalog';
import { byteSize, parameterSize, quantization } from './variants';
import { useConfirmation } from '@/hooks/use-confirmation';
import type {
  AppStatus,
  Artifact,
  Deployment,
  DeploymentActions,
  HostSnapshot,
  Job,
  MetricSample,
  OperationEvent,
  Profile,
  Runtime,
  TemplateAssetPublic,
  TemplateSelection,
  TemplateSource,
} from './types';

import { go } from './navigation';
import { readApi } from './ui';
import * as contracts from './contracts';
function InspectModel({ id }: { id: string }) {
  const [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/api/models/${id}/inspect`, {});
            setNotice(
              'Inspection queued. Results refresh automatically; see Activity for progress.',
            );
          } catch (e) {
            setNotice(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Refresh capability metadata
      </Button>
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
type Actions = DeploymentActions & {
  inspect: (title: string, value: unknown) => void;
  revisions: (row: Profile) => void;
};
export function ActivityFeed({
  events,
  deployments,
  jobs,
  limit,
}: {
  events: OperationEvent[];
  deployments: Pick<Deployment, 'id' | 'name'>[];
  jobs?: Job[];
  limit?: number;
}) {
  return (
    <EventFeed
      events={events}
      deployments={deployments}
      jobs={jobs}
      limit={limit}
    />
  );
}
export function MemoryChart({ samples }: { samples: MetricSample[] }) {
  const [gpuIndex, setGpuIndex] = useState(0);
  const container = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(920);
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(280, Math.min(920, entries[0].contentRect.width - 32))),
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const gpus = samples.at(-1)?.gpus || [];
  const values = samples.filter(
    (s) => typeof s.gpus?.[gpuIndex]?.used_mib === 'number',
  );
  const max = values.at(-1)?.gpus?.[gpuIndex]?.total_mib;
  const start = values[0]?.ts,
    end = values.at(-1)?.ts;
  const points = values
    .map((s, i) => {
      const sampleTs = s.ts ?? 0;
      const sampleGpu = s.gpus?.[gpuIndex];
      const used =
        typeof sampleGpu?.used_mib === 'number' ? sampleGpu.used_mib : 0;
      const capacity = typeof max === 'number' && max > 0 ? max : 1;
      return `${50 + (end !== undefined && start !== undefined && end > start ? (sampleTs - start) / (end - start) : i / Math.max(1, values.length - 1)) * (width - 80)},${160 - (used / capacity) * 140}`;
    })
    .join(' ');
  return (
    <Card className="mb-5 min-w-0" ref={container}>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle>GPU memory</CardTitle>
        {gpus.length > 1 && (
          <NativeSelect
            aria-label="Chart GPU"
            value={gpuIndex}
            onChange={(e) => setGpuIndex(Number(e.target.value))}
          >
            {gpus.map((g, i: number) => (
              <NativeSelectOption key={i} value={i}>
                {g.name} · GPU {g.index ?? i}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {values.length < 2 || !max ? (
          <p className="muted padded">Collecting memory history…</p>
        ) : (
          <>
            <svg
              className="chart"
              viewBox={`0 0 ${width} 205`}
              role="img"
              aria-label={'GPU ' + gpuIndex + ' memory history in GiB'}
            >
              {[0, 0.5, 1].map((f) => (
                <g key={f}>
                  <line
                    x1="50"
                    x2={width - 30}
                    y1={160 - f * 140}
                    y2={160 - f * 140}
                  />
                  <text x="38" y={164 - f * 140} textAnchor="end">
                    {number((max * f) / 1024)}
                  </text>
                </g>
              ))}
              <text x="50" y="12">
                GiB
              </text>
              <polyline points={points} />
              <text x="50" y="190">
                {start
                  ? new Date(start * 1000).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'Earlier'}
              </text>
              <text x={width - 30} y="190" textAnchor="end">
                {end
                  ? new Date(end * 1000).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'Now'}
              </text>
            </svg>
          </>
        )}
      </CardContent>
    </Card>
  );
}
export function DeploymentDetail({
  d,
  tab,
  data,
  host,
  inflight,
  actions,
  events,
  saved,
}: {
  d: Deployment;
  tab: string;
  data: Registry;
  host: HostSnapshot;
  inflight: number;
  actions: Actions;
  events: OperationEvent[];
  saved: () => void;
}) {
  const profile = d.profile_snapshot;
  const [logs, setLogs] = useState(''),
    [error, setError] = useState('');
  const logRun = new URLSearchParams(window.location.hash.split('?')[1]).get(
    'run',
  );
  useEffect(() => {
    if (tab !== 'Logs') return;
    let alive = true;
    const load = () =>
      readApi(
        `/api/deployments/${d.id}/logs${logRun ? '?session_id=' + encodeURIComponent(logRun) : ''}`,
        contracts.logs,
      )
        .then((r) => {
          if (alive) {
            setLogs(r.text || 'No logs yet.');
            setError('');
          }
        })
        .catch((e) => {
          if (alive) setError(message(e));
        });
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tab, d.id, logRun]);
  const process = host.deployments?.[d.id] || {};
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
          {d.enabled && !active(d) && (
            <Button
              variant="default"
              type="button"
              onClick={() => actions.load('deployments', d)}
            >
              Load now
            </Button>
          )}
          {['READY', 'DEGRADED', 'LOADING', 'STARTING', 'QUEUED'].includes(
            d.state,
          ) && (
            <Button
              variant="outline"
              type="button"
              onClick={() => actions.stop('deployments', d)}
            >
              Unload
            </Button>
          )}
          {!d.enabled && (
            <Button
              variant="default"
              type="button"
              onClick={() => actions.enable(d, true)}
            >
              Enable for clients
            </Button>
          )}
        </div>
      </div>
      {d.lifecycle?.failure && (
        <Alert variant="destructive" className="mb-5" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
            {d.lifecycle.failure}
          </AlertDescription>
        </Alert>
      )}
      <Tabs
        items={[
          'Overview',
          'Configuration',
          'Advanced',
          'Activity',
          'Requests',
          'Logs',
        ]}
        value={tab}
        onChange={(t) =>
          go(
            'deployments/' +
              d.id +
              (t === 'Overview' ? '' : '/' + t.toLowerCase()),
          )
        }
      />
      {tab === 'Overview' && (
        <>
          <div className="stats">
            <Card className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3">
              <CardHeader className="p-0 pb-3">
                <CardDescription>VRAM</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 p-0">
                <strong>{active(d) ? memory(process.gpu_mib) : 'N/A'}</strong>
              </CardContent>
            </Card>
            <Card className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3">
              <CardHeader className="p-0 pb-3">
                <CardDescription>Context / request</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 p-0">
                <strong>
                  {number(profile?.catalog?.model?.limit?.context, 0)}
                </strong>
              </CardContent>
            </Card>
            <Card className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3">
              <CardHeader className="p-0 pb-3">
                <CardDescription>Active requests</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 p-0">
                <strong>{inflight}</strong>
              </CardContent>
            </Card>
          </div>
          <div className="detail-grid">
            <Card className="mb-5 min-w-0 gap-0 p-5">
              <CardHeader className="p-0 pb-3">
                <CardTitle>Serving</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 p-0">
                <dl className="properties">
                  <dt>API model</dt>
                  <dd className="copy-value">
                    <code>{d.alias}</code>
                    <CopyButton value={d.alias} label="Copy API model" />
                  </dd>
                  <dt>Client discovery</dt>
                  <dd>{visible(d) ? 'Available' : 'Not listed'}</dd>
                  <dt>Mode</dt>
                  <dd>{mode(d)}</dd>
                  {d.residency === 'on-demand' && (
                    <>
                      <dt>Unload after idle</dt>
                      <dd>
                        {d.idle_timeout ? d.idle_timeout + ' seconds' : 'Never'}
                      </dd>
                    </>
                  )}
                  <dt>Automatic eviction</dt>
                  <dd>
                    {d.residency !== 'pinned' && d.allow_eviction
                      ? 'Allowed when idle'
                      : 'Not allowed'}
                  </dd>
                  {d.lifecycle?.last_stop_reason && (
                    <>
                      <dt>Last unload</dt>
                      <dd>{d.lifecycle.last_stop_reason}</dd>
                    </>
                  )}
                </dl>
              </CardContent>
            </Card>
          </div>
          <DeploymentPerformance deployment={d} />
          {profile?.artifact_id && (
            <ResourceHistory
              key={profile.artifact_id}
              artifactId={profile.artifact_id}
            />
          )}
        </>
      )}
      {tab === 'Configuration' && (
        <DeploymentConfiguration deployment={d} data={data} saved={saved} />
      )}
      {tab === 'Requests' && (
        <RequestHistory deploymentId={d.id} deployments={data.deployments} />
      )}
      {tab === 'Advanced' && (
        <Card className="mb-5 min-w-0 gap-0 p-5">
          <CardContent className="p-0">
            <dl className="properties">
              <dt>Model</dt>
              <dd>
                {data.models?.find((m) => m.id === profile?.artifact_id)
                  ?.name || profile?.artifact_id}
              </dd>
              <dt>Engine</dt>
              <dd>
                {data.runtimes?.find((r) => r.id === profile?.runtime_id)
                  ?.name || profile?.runtime_id}
              </dd>
              {Object.entries(profile?.config || {}).map(([k, v]) => (
                <div className="property-pair" key={k}>
                  <dt>{k}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
            </dl>
            <details>
              <summary>Advanced</summary>
              <dl className="properties">
                <dt>Private port</dt>
                <dd>{d.port}</dd>
                <dt>GPU</dt>
                <dd>{d.gpu}</dd>
                <dt>Priority</dt>
                <dd>{d.priority}</dd>
                <dt>Queue timeout (s)</dt>
                <dd>{d.queue_timeout}</dd>
              </dl>
              <Json
                value={{
                  arguments: profile?.raw_args,
                  capabilities: profile?.catalog,
                }}
              />
            </details>
          </CardContent>
        </Card>
      )}
      {tab === 'Activity' && (
        <Card className="mb-5 min-w-0 gap-0 p-0">
          <CardContent className="p-0">
            <ActivityFeed
              events={events.filter((e) => e.deployment_id === d.id)}
              deployments={data.deployments || []}
            />
          </CardContent>
        </Card>
      )}
      {tab === 'Logs' && (
        <Card className="mb-5 min-w-0 gap-0 p-5">
          <CardContent className="p-0">
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <pre className="logs" tabIndex={0}>
              {logs || 'Loading logs…'}
            </pre>
          </CardContent>
        </Card>
      )}
    </>
  );
}

export function ModelLibrary({
  data,
  query,
  setQuery,
  create,
  inspect,
  addFromFile,
  discover,
}: {
  data: Registry;
  query: string;
  setQuery: (q: string) => void;
  create: (id: string) => void;
  inspect: (title: string, value: Artifact) => void;
  addFromFile: () => void;
  discover: () => void;
}) {
  const [format, setFormat] = useState(''),
    [capability, setCapability] = useState(''),
    [selected, setSelected] = useState(
      () => window.location.hash.slice(2).split('/')[2] || '',
    );
  const { confirm, confirmation } = useConfirmation();
  const [modelDefault, setModelDefault] = useState<
      TemplateSelection | null | undefined
    >(undefined),
    [editingTemplate, setEditingTemplate] =
      useState<TemplateAssetPublic | null>(null),
    // Whether the custom-template editor is open. Distinct from which template
    // is being edited: "New custom template" opens it with no asset selected.
    [templateOpen, setTemplateOpen] = useState(false),
    [templateContent, setTemplateContent] = useState(''),
    [templateBusy, setTemplateBusy] = useState(false),
    [templateError, setTemplateError] = useState(''),
    [templateNotice, setTemplateNotice] = useState(''),
    [refreshingTemplates, setRefreshingTemplates] = useState(false);
  function chips(m: Artifact): string[] {
    const hints = m.discovered_capabilities || {};
    const params = parameterSize(m.repo || m.name);
    const quant = quantization(m.name);
    const quantLabel =
      quant.quant !== 'Other / default'
        ? quant.quant + (quant.suffix !== 'None' ? '_' + quant.suffix : '')
        : m.quantization;
    return [
      m.source === 'huggingface' ? 'Hugging Face' : 'Local file',
      m.format.toUpperCase(),
      params !== 'Unspecified' && params,
      quantLabel && `Quantization: ${quantLabel}`,
      m.architecture,
      byteSize(m.size_bytes ?? null),
      (typeof hints.reasoning === 'object'
        ? hints.reasoning.supported
        : hints.reasoning) && 'reasoning',
      hints.tools && 'tools',
      ...(hints.input || []),
    ].filter((value): value is string => typeof value === 'string');
  }
  const rows = (data.models || []).filter(
    (m) =>
      [m.name, m.repo, m.architecture]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (!format || m.format === format) &&
      (!capability || chips(m).includes(capability)),
  );
  const groups = new Map<string, Artifact[]>();
  for (const row of rows) {
    const key = row.repo ? `${row.source}:${row.repo}` : row.id;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const current = data.models?.find((m) => m.id === selected);
  const siblings = current
    ? (data.models || []).filter((m) =>
        current.repo
          ? m.repo === current.repo && m.source === current.source
          : m.id === current.id,
      )
    : [];
  useEffect(
    () => {
      if (!current) return;
      setModelDefault(current.template_default ?? null);
      setEditingTemplate(null);
      setTemplateOpen(false);
      setTemplateContent('');
      setTemplateError('');
      setTemplateNotice('');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current?.id],
  );
  if (!data.models?.length)
    return (
      <Empty title="No models yet">
        <div className="actions">
          <Button variant="default" type="button" onClick={discover}>
            Discover models
          </Button>
          <Button variant="outline" type="button" onClick={addFromFile}>
            <Plus size={16} />
            Add from File
          </Button>
        </div>
      </Empty>
    );
  const templates = current?.templates || [];
  async function applyModelDefault(
    source: TemplateSource,
    asset_id: string | null,
  ) {
    if (!current) return;
    setModelDefault({ source, asset_id: asset_id ?? null });
    setTemplateError('');
    try {
      const saved = await api(`/api/models/${current.id}/template-default`, {
        source,
        asset_id: asset_id ?? null,
      });
      if (isRecord(saved) && isRecord(saved.template_default))
        setModelDefault(saved.template_default as TemplateSelection);
      setTemplateNotice('Model template default saved.');
    } catch (e) {
      setTemplateError(message(e));
    }
  }
  async function refreshTemplates() {
    if (!current) return;
    setRefreshingTemplates(true);
    setTemplateError('');
    try {
      await api(`/api/models/${current.id}/refresh-templates`, {});
      setTemplateNotice('Chat templates refreshed.');
    } catch (e) {
      setTemplateError(message(e));
    } finally {
      setRefreshingTemplates(false);
    }
  }
  async function startEditing(template: TemplateAssetPublic | null) {
    setTemplateError('');
    setEditingTemplate(template);
    setTemplateOpen(true);
    setTemplateContent('');
    if (template) {
      try {
        const full = await api(`/api/templates/${template.id}`);
        if (isRecord(full) && typeof full.content === 'string')
          setTemplateContent(full.content);
      } catch (e) {
        setTemplateError(message(e));
      }
    }
  }
  async function saveTemplate() {
    const content = templateContent.trim();
    if (!content) {
      setTemplateError('Template content is required.');
      return;
    }
    if (!current) return;
    setTemplateBusy(true);
    setTemplateError('');
    try {
      if (editingTemplate) {
        await api(`/api/templates/${editingTemplate.id}`, { content });
      } else {
        await api('/api/templates', { artifact_id: current.id, content });
      }
      setTemplateNotice(
        editingTemplate ? 'Custom template saved.' : 'Custom template created.',
      );
      setEditingTemplate(null);
      setTemplateOpen(false);
      setTemplateContent('');
    } catch (e) {
      setTemplateError(message(e));
    } finally {
      setTemplateBusy(false);
    }
  }
  async function deleteTemplate(template: TemplateAssetPublic) {
    if (
      !(await confirm(
        `Remove custom template “${template.name}”? Its content will be deleted.`,
      ))
    )
      return;
    try {
      await api(`/api/templates/${template.id}/delete`, {});
      setTemplateNotice('Custom template removed.');
      setEditingTemplate(null);
      setTemplateOpen(false);
    } catch (e) {
      setTemplateError(message(e));
    }
  }
  return (
    <>
      {confirmation}
      <div className="toolbar">
        <Input
          className="search"
          type="search"
          aria-label="Search installed models"
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <NativeSelect
          aria-label="Filter model format"
          value={format}
          onChange={(e) => setFormat(e.target.value)}
        >
          <NativeSelectOption value="">All formats</NativeSelectOption>
          {[...new Set((data.models || []).map((m) => m.format))].map((f) => (
            <NativeSelectOption key={f}>{f}</NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter model capability"
          value={capability}
          onChange={(e) => setCapability(e.target.value)}
        >
          <NativeSelectOption value="">All capabilities</NativeSelectOption>
          {['reasoning', 'tools', 'image', 'audio', 'video'].map((c) => (
            <NativeSelectOption key={c}>{c}</NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="catalog-grid">
        {[...groups].map(([key, models]) => {
          const m = models[0];
          return (
            <ModelCard
              key={key}
              name={m.repo || m.name}
              url={
                m.source === 'huggingface' && m.repo
                  ? `https://huggingface.co/${m.repo}`
                  : undefined
              }
              chips={
                models.length === 1
                  ? chips(m)
                  : [...new Set(models.flatMap(chips))]
              }
              footer={`${models.length} installed variant${models.length === 1 ? '' : 's'}`}
            >
              <div className="actions">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() =>
                    models.length === 1 ? create(m.id) : setSelected(m.id)
                  }
                >
                  {models.length === 1 ? 'Create deployment' : 'Choose variant'}
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => setSelected(m.id)}
                >
                  Details
                </Button>
              </div>
            </ModelCard>
          );
        })}
      </div>
      {!rows.length && <Empty title="No matching models" />}
      {current && (
        <Dialog
          title={current.repo || current.name}
          close={() => {
            setSelected('');
            if (window.location.hash.split('/')[3]) go('models/installed');
          }}
          wide
        >
          <InstalledVariants
            models={siblings}
            selected={selected}
            select={setSelected}
          />
          <div className="catalog-chips">
            {chips(current)
              .filter(
                (c) =>
                  ![
                    'text',
                    'image',
                    'audio',
                    'video',
                    'reasoning',
                    'tools',
                  ].includes(c),
              )
              .map((c) => (
                <Badge
                  variant="secondary"
                  className="max-w-full whitespace-normal break-words"
                  key={c}
                >
                  {c}
                </Badge>
              ))}
          </div>
          <section className="model-section">
            <h3>Capabilities</h3>
            <CapabilityBadges hints={current.discovered_capabilities} />
            {!!current.discovered_capabilities?.dependencies?.length && (
              <>
                <h3>Companion files</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {current.discovered_capabilities.dependencies.map((d) => (
                      <TableRow key={d.name}>
                        <TableCell>{d.name}</TableCell>
                        <TableCell>Projector</TableCell>
                        <TableCell>
                          {current.metadata?.projector?.name === d.name
                            ? 'Downloaded'
                            : 'Candidate'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
            <InspectModel key={current.id} id={current.id} />
          </section>
          <ResourceHistory
            key={'history-' + current.id}
            artifactId={current.id}
          />
          <h3>Deployments</h3>
          {(data.deployments || [])
            .filter((d) => d.profile_snapshot?.artifact_id === current.id)
            .map((d) => (
              <p key={d.id}>
                <a
                  href={`#/deployments/${d.id}`}
                  onClick={() => setSelected('')}
                >
                  {d.name}
                </a>{' '}
                · {d.state}
              </p>
            ))}
          <h3>Chat templates</h3>
          <Field label="Model default">
            <NativeSelect
              value={
                modelDefault && modelDefault.source !== 'automatic'
                  ? (modelDefault.asset_id ?? 'automatic')
                  : 'automatic'
              }
              onChange={(e) => {
                const value = e.target.value;
                if (value === 'automatic') {
                  applyModelDefault('automatic', null);
                } else {
                  const t = templates.find((x) => x.id === value);
                  if (t) applyModelDefault(t.kind, t.id);
                }
              }}
            >
              <NativeSelectOption value="automatic">
                Automatic (engine default)
              </NativeSelectOption>
              {templates.map((t) => (
                <NativeSelectOption key={t.id} value={t.id}>
                  {templateKindLabel(t.kind)} · {t.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {templates.length === 0 ? (
            <p className="muted">
              No chat templates available. Refresh after download or add a
              custom template.
            </p>
          ) : (
            <ul className="template-list mb-3">
              {templates.map((t) => (
                <li key={t.id} className="text-sm">
                  <span className="mr-2 text-muted-foreground">
                    {templateKindLabel(t.kind)}
                  </span>
                  {t.name}
                  {t.status && t.status !== 'available' && (
                    <span className="ml-2 text-destructive-foreground">
                      ({t.status})
                    </span>
                  )}
                  {t.kind === 'custom' && (
                    <span className="ml-4 inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEditing(t)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteTemplate(t)}
                      >
                        Delete
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              type="button"
              disabled={refreshingTemplates}
              onClick={refreshTemplates}
            >
              {refreshingTemplates ? 'Refreshing…' : 'Refresh templates'}
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => startEditing(null)}
            >
              New custom template
            </Button>
          </div>
          {(templateError || templateNotice) && (
            <p
              role="status"
              className={
                templateError
                  ? 'text-destructive-foreground'
                  : 'text-success-foreground'
              }
            >
              {templateError || templateNotice}
            </p>
          )}
          {templateOpen && (
            <details
              className="mt-2"
              open
              onToggle={(e) =>
                setTemplateOpen((e.target as HTMLDetailsElement).open)
              }
            >
              <summary>
                {editingTemplate
                  ? `Edit “${editingTemplate.name}”`
                  : 'New custom template'}
              </summary>
              <textarea
                className="mb-2 h-48 w-full rounded-md border border-neutral-300 bg-white p-2 font-mono text-sm"
                placeholder='Paste a Jinja chat template, e.g. {{" - prompt }}{{ - ... }}'
                value={templateContent}
                onChange={(e) => setTemplateContent(e.target.value)}
              />
              <div className="dialog-actions">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setEditingTemplate(null);
                    setTemplateOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="default"
                  type="button"
                  disabled={templateBusy || !templateContent.trim()}
                  onClick={saveTemplate}
                >
                  {templateBusy ? 'Saving…' : 'Save template'}
                </Button>
              </div>
            </details>
          )}
          <details>
            <summary>Local file</summary>
            <code>{current.local_path}</code>
          </details>
          <div className="dialog-actions">
            <Button
              variant="outline"
              type="button"
              onClick={() => inspect(current.name, current)}
            >
              Inspect metadata
            </Button>
            <Button
              variant="default"
              type="button"
              onClick={() => {
                setSelected('');
                create(current.id);
              }}
            >
              Create deployment
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function ActivityPage({
  tab,
  jobs,
  events,
  deployments,
}: {
  tab: string;
  jobs: Job[];
  events: OperationEvent[];
  deployments: Deployment[];
}) {
  return (
    <>
      <Tabs
        items={['Events', 'Requests']}
        value={tab}
        onChange={(t) => go('activity/' + t.toLowerCase())}
      />
      {tab === 'Events' && (
        <Card className="mb-5 min-w-0 gap-0 p-0">
          <CardContent className="p-0">
            <ActivityFeed
              events={events}
              deployments={deployments}
              jobs={jobs}
            />
          </CardContent>
        </Card>
      )}
      {tab === 'Requests' && <RequestHistory deployments={deployments} />}
    </>
  );
}

export function SettingsPage({
  tab,
  data,
  status,
  actions,
  savePolicy,
  purge,
  backup,
  install,
  pull,
}: {
  tab: string;
  data: Registry;
  status: AppStatus | null;
  actions: Actions;
  savePolicy: (value: import('./types').HostPolicyDraft) => Promise<void>;
  purge: () => void;
  backup: () => void;
  install: () => void;
  pull: () => void;
}) {
  const { confirm, confirmation } = useConfirmation();
  const [notice, setNotice] = useState(''),
    [policyBusy, setPolicyBusy] = useState(false);
  async function removeEngine(runtime: Runtime) {
    if (
      !(await confirm(
        `Remove ${runtime.name} and its installed files? Referenced engines cannot be removed.`,
      ))
    )
      return;
    try {
      await api(
        `/api/registry/runtimes/${runtime.id}/delete?remove_files=true`,
        {},
      );
      setNotice('Engine removed.');
    } catch (e) {
      setNotice(message(e));
    }
  }
  return (
    <>
      {confirmation}
      <Tabs
        items={['Engines', 'Host', 'History', 'Recovery']}
        value={tab}
        onChange={(t) => go('settings/' + t.toLowerCase())}
      />
      {tab === 'Engines' && (
        <>
          <EngineCatalog
            runtimes={data.runtimes || []}
            actions={
              <>
                <Button
                  variant="outline"
                  onClick={() => actions.edit('runtimes')}
                >
                  <Plus data-icon="inline-start" />
                  Register existing engine
                </Button>
                <Button variant="outline" onClick={install}>
                  Build from source
                </Button>
                <Button variant="outline" onClick={pull}>
                  Pull image
                </Button>
              </>
            }
          />
          <h2>Installed engines</h2>
          {notice && <p role="status">{notice}</p>}
          <div className="engine-list">
            {(data.runtimes || []).map((r) => (
              <section className="engine-row" key={r.id}>
                <div>
                  <h3>{r.name}</h3>
                  <p className="muted">{r.engine}</p>
                </div>
                <div>
                  <Badge
                    variant="secondary"
                    className="max-w-full whitespace-normal break-words"
                  >
                    {r.managed ? 'Managed' : r.execution_kind}
                  </Badge>
                </div>
                <div className="card-actions">
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => actions.inspect(r.name, r)}
                  >
                    Details
                  </Button>
                  <Menu label={'Actions for ' + r.name}>
                    <DropdownMenuItem
                      onClick={() => actions.edit('runtimes', r)}
                    >
                      Edit
                    </DropdownMenuItem>
                    {r.managed ? (
                      <DropdownMenuItem onClick={() => removeEngine(r)}>
                        Remove engine files
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onClick={() => actions.edit('runtimes', r, true)}
                      >
                        Duplicate
                      </DropdownMenuItem>
                    )}
                  </Menu>
                </div>
              </section>
            ))}
          </div>
          {!data.runtimes?.length && <Empty title="No engines installed" />}
        </>
      )}
      {tab === 'History' && <HistorySettings />}
      {tab === 'Host' && status && (
        <Card className="mb-5 min-w-0 gap-0 p-5">
          <CardContent className="p-0">
            {notice && <p role="status">{notice}</p>}
            <PolicyEditor
              initial={status.settings}
              busy={policyBusy}
              purge={purge}
              embedded
              save={async (value) => {
                setPolicyBusy(true);
                setNotice('');
                try {
                  await savePolicy(value);
                  setNotice('Policy saved');
                } catch (e) {
                  setNotice(message(e));
                } finally {
                  setPolicyBusy(false);
                }
              }}
            />
          </CardContent>
        </Card>
      )}
      {tab === 'Recovery' && (
        <Card className="mb-5 min-w-0 gap-0 p-5">
          <CardHeader className="p-0 pb-3">
            <CardTitle>Registry backup</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 p-0">
            <p className="muted">
              Includes configuration and history, not model files.
            </p>
            <Button variant="outline" type="button" onClick={backup}>
              Create backup
            </Button>
            <details>
              <summary>Storage</summary>
              <code className="path">{status?.state_path}</code>
            </details>
          </CardContent>
        </Card>
      )}
    </>
  );
}
