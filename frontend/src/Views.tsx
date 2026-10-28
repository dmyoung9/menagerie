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
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Plus } from 'lucide-react';
import {
  active,
  api,
  CopyButton,
  date,
  Dialog,
  Empty,
  eventText,
  gib,
  Json,
  Menu,
  message,
  mode,
  number,
  state,
  Status,
  Tabs,
  visible,
  type Registry,
} from './ui';
import { ModelCard } from './ModelCard';
import { EngineCatalog } from './EngineCatalog';
import { byteSize, parameterSize, quantization } from './variants';
import { useConfirmation } from '@/hooks/use-confirmation';
import type {
  AppStatus,
  Artifact,
  Deployment,
  DeploymentActions,
  HistoryActivation,
  HistoryRequest,
  HistorySession,
  HostSnapshot,
  Job,
  MetricSample,
  OperationEvent,
  Profile,
  Runtime,
} from './types';

import { go } from './navigation';
import { readApi } from './ui';
import * as contracts from './contracts';
import { array } from './decode';
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
}: {
  events: OperationEvent[];
  deployments: Pick<Deployment, 'id' | 'name'>[];
}) {
  return events.length ? (
    <ol className="activity-feed">
      {events.map((e) => (
        <li key={e.seq}>
          <span
            className={
              'event-dot ' +
              (e.data?.to === 'FAILED' || e.data?.error ? 'failed' : '')
            }
          />
          <span>{eventText(e, deployments)}</span>
          <time
            dateTime={new Date(e.ts * 1000).toISOString()}
            title={date(e.ts)}
          >
            {new Date(e.ts * 1000).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </li>
      ))}
    </ol>
  ) : (
    <p className="muted padded">No recent activity.</p>
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
}: {
  d: Deployment;
  tab: string;
  data: Registry;
  host: HostSnapshot;
  inflight: number;
  actions: Actions;
  events: OperationEvent[];
}) {
  const profile = d.profile_snapshot;
  const [logs, setLogs] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    if (tab !== 'Logs') return;
    let alive = true;
    const load = () =>
      readApi(`/api/deployments/${d.id}/logs`, contracts.logs)
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
  }, [tab, d.id]);
  const metrics = host.runtime_metrics?.[d.id] || {},
    process = host.deployments?.[d.id] || {};
  const rate = (tokens: string, seconds: string) => {
    const sum = (name: string) =>
      Object.entries(metrics)
        .filter(([k]) => k.split('{')[0].replace(/^llamacpp:/, '') === name)
        .reduce((n, [, v]) => n + Number(v), 0);
    return sum(seconds) > 0 ? sum(tokens) / sum(seconds) : null;
  };
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
          <Button
            variant="outline"
            type="button"
            disabled={active(d)}
            onClick={() => actions.edit('deployments', d)}
          >
            Edit
          </Button>
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
        items={['Overview', 'Configuration', 'Activity', 'Logs']}
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
                <strong>
                  {gib(process.gpu_mib)} <small>GiB</small>
                </strong>
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
            <Card className="mb-5 min-w-0 gap-0 p-5">
              <CardHeader className="p-0 pb-3">
                <CardTitle>Performance</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 p-0">
                <dl className="properties">
                  <dt>Prefill (tok/s)</dt>
                  <dd>
                    {number(
                      rate('prompt_tokens_total', 'prompt_seconds_total'),
                    )}
                  </dd>
                  <dt>Generation (tok/s)</dt>
                  <dd>
                    {number(
                      rate(
                        'tokens_predicted_total',
                        'tokens_predicted_seconds_total',
                      ),
                    )}
                  </dd>
                  <dt>Process RAM (GiB)</dt>
                  <dd>{gib(process.rss_mib)}</dd>
                  <dt>CPU (%)</dt>
                  <dd>{number(process.cpu_percent)}</dd>
                </dl>
                <small className="muted">Runtime averages since loading.</small>
              </CardContent>
            </Card>
          </div>
        </>
      )}
      {tab === 'Configuration' && (
        <Card className="mb-5 min-w-0 gap-0 p-5">
          <CardContent className="p-0">
            <Button
              variant="outline"
              type="button"
              disabled={active(d)}
              onClick={() => actions.edit('deployments', d)}
            >
              Edit configuration
            </Button>
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
                <dt>VRAM reservation (MiB)</dt>
                <dd>{d.reservation_mib || 'Estimated'}</dd>
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
    [selected, setSelected] = useState('');
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
      hints.reasoning && 'reasoning',
      hints.tools && 'tools',
      ...(hints.input || []).filter((v: string) => v !== 'text'),
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
  return (
    <>
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
      <p className="muted">
        Capability badges are detected hints. Deployment settings control what
        clients see.
      </p>
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
          close={() => setSelected('')}
          wide
        >
          <label>
            Installed variant
            <NativeSelect
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {siblings.map((m) => (
                <NativeSelectOption key={m.id} value={m.id}>
                  {m.name} · {byteSize(m.size_bytes ?? null)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <div className="catalog-chips">
            {chips(current).map((c) => (
              <Badge
                variant="secondary"
                className="max-w-full whitespace-normal break-words"
                key={c}
              >
                {c}
              </Badge>
            ))}
          </div>
          <h3>Capabilities & dependencies</h3>
          <p>
            {current.discovered_capabilities?.evidence?.join('; ') ||
              'No conclusive capability metadata. Configure declarations in the deployment.'}
          </p>
          <p>{current.discovered_capabilities?.note}</p>
          {current.discovered_capabilities?.dependencies?.map((d) => (
            <p key={d.name}>
              {d.name} —{' '}
              {current.metadata?.projector?.name === d.name
                ? 'Downloaded; confirm compatibility'
                : 'Candidate; compatibility unverified'}
            </p>
          ))}
          <InspectModel key={current.id} id={current.id} />
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
  inspect,
  restore,
}: {
  tab: string;
  jobs: Job[];
  events: OperationEvent[];
  deployments: Deployment[];
  inspect: (title: string, value: unknown) => void;
  restore: (path: string, notice: string) => void;
}) {
  const [sessions, setSessions] = useState<HistorySession[]>([]),
    [requests, setRequests] = useState<HistoryRequest[]>([]),
    [activations, setActivations] = useState<HistoryActivation[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const path =
          tab === 'Sessions'
            ? 'sessions'
            : tab === 'Requests'
              ? 'requests'
              : tab === 'Launches'
                ? 'activations'
                : null;
        if (!path) return;
        if (!alive) return;
        if (path === 'sessions')
          setSessions(
            await readApi(
              '/api/history/sessions',
              array(contracts.historySession),
            ),
          );
        else if (path === 'requests')
          setRequests(
            await readApi(
              '/api/history/requests',
              array(contracts.historyRequest),
            ),
          );
        else
          setActivations(
            await readApi(
              '/api/history/activations',
              array(contracts.historyActivation),
            ),
          );
        setError('');
      } catch (e) {
        if (alive) setError(message(e));
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tab]);
  return (
    <>
      <Tabs
        items={['Events', 'Operations', 'Requests', 'Sessions', 'Launches']}
        value={tab}
        onChange={(t) => go('activity/' + t.toLowerCase())}
      />
      {error && (
        <Alert variant="destructive" className="mb-5" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
            {error}
          </AlertDescription>
        </Alert>
      )}
      {tab === 'Events' && (
        <Card className="mb-5 min-w-0 gap-0 p-0">
          <CardContent className="p-0">
            <ActivityFeed events={events} deployments={deployments} />
          </CardContent>
        </Card>
      )}
      {tab === 'Operations' && (
        <Card className="mb-5 min-w-0 gap-0 p-0">
          <CardContent className="p-0">
            {jobs.length ? (
              [...jobs]
                .sort((a, b) => b.created_at - a.created_at)
                .map((j) => (
                  <div className="operation" key={j.id}>
                    <Status
                      value={j.state.charAt(0) + j.state.slice(1).toLowerCase()}
                    />
                    <div>
                      <strong>{j.name}</strong>
                      <p className={j.error ? 'error-text' : 'muted'}>
                        {j.error || j.progress}
                      </p>
                    </div>
                  </div>
                ))
            ) : (
              <Empty title="No operations yet" />
            )}
          </CardContent>
        </Card>
      )}
      {tab === 'Requests' && (
        <Card className="mb-5 min-w-0 gap-0 p-0 table-wrap">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="numeric">Latency (s)</TableHead>
                  <TableHead className="numeric">First token (s)</TableHead>
                  <TableHead className="numeric">Output tokens</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.data.model_alias}</TableCell>
                    <TableCell className="numeric">
                      {number(r.data.latency, 2)}
                    </TableCell>
                    <TableCell className="numeric">
                      {number(r.data.ttft, 2)}
                    </TableCell>
                    <TableCell className="numeric">
                      {number(r.data.output_tokens, 0)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => inspect('Request', r)}
                      >
                        {r.data.error ? 'Failed' : 'Complete'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!requests.length && <Empty title="No requests yet" />}
          </CardContent>
        </Card>
      )}
      {tab === 'Sessions' && (
        <>
          <div className="toolbar">
            <Button
              variant="outline"
              type="button"
              disabled={selected.length !== 2}
              onClick={() =>
                inspect(
                  'Session comparison',
                  sessions
                    .filter((s) => selected.includes(s.id))
                    .map((s) => ({
                      deployment: s.deployment_snapshot.name,
                      started: date(s.started_at),
                      peak_gpu_mib: s.peak_gpu_mib,
                      peak_ram_mib: s.peak_ram_mib,
                      config: s.deployment_snapshot.profile_snapshot.config,
                      outcome: s.outcome,
                    })),
                )
              }
            >
              Compare {selected.length ? `(${selected.length}/2)` : ''}
            </Button>
          </div>
          <Card className="mb-5 min-w-0 gap-0 p-0 table-wrap">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <span className="sr-only">Compare</span>
                    </TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Deployment</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead className="numeric">Peak VRAM (GiB)</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Checkbox
                          aria-label={
                            'Compare ' + s.deployment_snapshot.name + ' ' + s.id
                          }
                          checked={selected.includes(s.id)}
                          disabled={
                            selected.length >= 2 && !selected.includes(s.id)
                          }
                          onCheckedChange={(checked) =>
                            setSelected(
                              checked
                                ? [...selected, s.id]
                                : selected.filter((id) => id !== s.id),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell>{date(s.started_at)}</TableCell>
                      <TableCell>{s.deployment_snapshot.name}</TableCell>
                      <TableCell>{s.outcome}</TableCell>
                      <TableCell className="numeric">
                        {gib(s.peak_gpu_mib)}
                      </TableCell>
                      <TableCell>
                        <Menu
                          label={
                            'Session actions for ' + s.deployment_snapshot.name
                          }
                        >
                          <DropdownMenuItem
                            onClick={() => inspect('Session', s)}
                          >
                            Details
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              restore(
                                `/api/history/sessions/${s.id}/restore`,
                                'Restore as an inactive deployment. Review it in Deployments → Inactive.',
                              )
                            }
                          >
                            Restore deployment
                          </DropdownMenuItem>
                        </Menu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!sessions.length && <Empty title="No sessions yet" />}
            </CardContent>
          </Card>
        </>
      )}
      {tab === 'Launches' && (
        <Card className="mb-5 min-w-0 gap-0 p-0">
          <CardContent className="p-0">
            {activations.map((a) => (
              <div className="operation" key={a.id}>
                <Status value={a.state} />
                <div>
                  <strong>{a.deployment_name || 'Deployment launch'}</strong>
                  <p className="muted">{date(a.started_at)}</p>
                </div>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() =>
                    restore(
                      `/api/history/activations/${a.id}/restore`,
                      'Restore as an inactive deployment. Review it in Deployments → Inactive.',
                    )
                  }
                >
                  Restore deployment
                </Button>
              </div>
            ))}
            {!activations.length && <Empty title="No launches yet" />}
          </CardContent>
        </Card>
      )}
    </>
  );
}

export function SettingsPage({
  tab,
  data,
  status,
  actions,
  policy,
  backup,
  install,
  pull,
}: {
  tab: string;
  data: Registry;
  status: AppStatus | null;
  actions: Actions;
  policy: () => void;
  backup: () => void;
  install: () => void;
  pull: () => void;
}) {
  const { confirm, confirmation } = useConfirmation();
  const [notice, setNotice] = useState('');
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
        items={['Engines', 'Host', 'Recovery']}
        value={tab}
        onChange={(t) => go('settings/' + t.toLowerCase())}
      />
      {tab === 'Engines' && (
        <>
          <EngineCatalog runtimes={data.runtimes || []} />
          <h2>Installed engines</h2>
          {notice && <p role="status">{notice}</p>}
          <div className="model-grid">
            {(data.runtimes || []).map((r) => (
              <Card className="mb-5 min-w-0 gap-0 p-0 library-card" key={r.id}>
                <CardContent className="p-0">
                  <Badge
                    variant="secondary"
                    className="max-w-full whitespace-normal break-words"
                  >
                    {r.managed ? 'Managed' : r.execution_kind}
                  </Badge>
                  <h2>{r.name}</h2>
                  <p className="muted">{r.engine}</p>
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
                </CardContent>
              </Card>
            ))}
          </div>
          {!data.runtimes?.length && <Empty title="No engines installed" />}
          <details>
            <summary>Advanced engine sources</summary>
            <div className="toolbar">
              <Button
                variant="outline"
                type="button"
                onClick={() => actions.edit('runtimes')}
              >
                <Plus size={16} />
                Register existing engine
              </Button>
              <Button variant="outline" type="button" onClick={install}>
                Build from source
              </Button>
              <Button variant="outline" type="button" onClick={pull}>
                Pull image
              </Button>
            </div>
          </details>
        </>
      )}
      {tab === 'Host' && (
        <Card className="mb-5 min-w-0 gap-0 p-5">
          <CardContent className="p-0">
            <div className="section-heading">
              <h2>Capacity & history</h2>
              <Button variant="outline" type="button" onClick={policy}>
                Edit policy
              </Button>
            </div>
            <dl className="properties">
              <dt>GPU reserve</dt>
              <dd>{gib(status?.settings.gpu_headroom_mib)} GiB</dd>
              <dt>RAM reserve</dt>
              <dd>{gib(status?.settings.ram_headroom_mib)} GiB</dd>
              <dt>Temperature limit</dt>
              <dd>{status?.settings.temperature_limit} °C</dd>
              <dt>Sampling</dt>
              <dd>{status?.settings.sample_seconds} seconds</dd>
              <dt>Detailed history</dt>
              <dd>{status?.settings.retention_days} days</dd>
              <dt>Summary history</dt>
              <dd>{status?.settings.summary_days} days</dd>
            </dl>
            <Button
              nativeButton={false}
              variant="outline"
              render={<a href="/metrics" target="_blank" rel="noreferrer" />}
            >
              Prometheus metrics <ArrowUpRight size={14} />
            </Button>
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
