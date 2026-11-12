import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  CpuAi,
  Server,
  Plus,
  RefreshCw,
  Settings,
} from 'lucide-react';
import { ModelCatalog } from './ModelCatalog';
import { readApi } from './ui';
import * as contracts from './contracts';
import { array } from './decode';
import { DeploymentWizard } from './DeploymentWizard';
import { LiveResources } from './Resources';
import { memory } from '@/lib/formatters';
import { Downloads } from '@/components/downloads';
import { ProcessResources } from '@/components/process-resources';
import { TelemetrySeries } from '@/components/charts/telemetry-series';
import { Editor } from './Editors';
import { editable } from './editor-state';
import { Connect, LaunchReview, PolicyEditor, SourceBuild } from './Operations';
import {
  DeploymentSetEditor,
  MultiDeploymentDetail,
  ServingTable,
} from './ServingDeployments';
import {
  ActivityFeed,
  ActivityPage,
  DeploymentDetail,
  ModelLibrary,
  SettingsPage,
} from './Views';
import { go, canNavigate } from './navigation';
import {
  api,
  Dialog,
  Empty,
  Field,
  Json,
  message,
  number,
  telemetryStale,
  Tabs,
} from './ui';
import brandLogo from './assets/logo-mono.png';
import type {
  AppStatus,
  Artifact,
  Deployment,
  EditableSource,
  HostSnapshot,
  Job,
  MetricSample,
  ModalState,
  OperationEvent,
  Profile,
  Registry,
  Runtime,
  ServingDeployment,
} from './types';

const navigation = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'models', label: 'Models', icon: CpuAi },
  { id: 'deployments', label: 'Deployments', icon: Server },
  { id: 'activity', label: 'Activity', icon: RefreshCw },
  { id: 'settings', label: 'Settings', icon: Settings },
];
function MainNavigation({
  page,
  busyCount,
}: {
  page: string;
  busyCount: number;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <nav aria-label="Main navigation" className="px-2">
      <SidebarMenu>
        {navigation.map((n) => (
          <SidebarMenuItem key={n.id}>
            <SidebarMenuButton
              isActive={page === n.id}
              onClick={() => setOpenMobile(false)}
              render={
                <a
                  href={'#/' + n.id}
                  aria-current={page === n.id ? 'page' : undefined}
                />
              }
            >
              <n.icon />
              <span>{n.label}</span>
            </SidebarMenuButton>
            {n.id === 'activity' && busyCount > 0 && (
              <SidebarMenuBadge>{busyCount}</SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </nav>
  );
}
const titleCase = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
function useRoute() {
  const readRoute = () => {
    const parts = window.location.hash.slice(2).split('?')[0].split('/');
    // The retired Advanced tab now lives inside Configuration cards.
    if (parts[0] === 'deployments' && parts[2] === 'advanced') {
      parts[2] = 'configuration';
      window.history.replaceState(
        null,
        '',
        window.location.hash.replace('/advanced', '/configuration'),
      );
    }
    return parts;
  };
  const [route, setRoute] = useState(() => readRoute());
  useEffect(() => {
    let previous = window.location.hash,
      pending = false;
    const change = async () => {
      if (pending) return;
      pending = true;
      if (await canNavigate()) {
        setRoute(readRoute());
        previous = window.location.hash;
      } else window.history.replaceState(null, '', previous || '#/overview');
      pending = false;
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  return route;
}

type SliceKey =
  'status' | 'models' | 'runtimes' | 'profiles' | 'deployments' | 'jobs';

/** The six inventory endpoints, fetched independently. A slice that errors or
 * is slow keeps its last-good value and only its own error/loading state. */
const ENDPOINTS: Record<
  SliceKey,
  { path: string; decode: (value: unknown, path?: string) => unknown }
> = {
  status: { path: '/api/status', decode: contracts.status },
  models: { path: '/api/registry/models', decode: array(contracts.artifact) },
  runtimes: {
    path: '/api/registry/runtimes',
    decode: array(contracts.runtime),
  },
  profiles: {
    path: '/api/registry/profiles',
    decode: array(contracts.profile),
  },
  deployments: {
    path: '/api/registry/deployments',
    decode: array(contracts.deployment),
  },
  jobs: { path: '/api/registry/jobs', decode: array(contracts.job) },
};

const SLICE_KEYS = Object.keys(ENDPOINTS) as SliceKey[];

/** Slices a mutation to the named resource invalidates. Unmapped kinds fall
 * back to a full refresh; the 5 s polling fallback keeps the registry
 * consistent either way. */
const affectedSlices = (kind?: string): SliceKey[] => {
  if (!kind) return SLICE_KEYS;
  switch (kind) {
    case 'models':
    case 'artifacts':
    case 'local-model':
      return ['models'];
    case 'runtimes':
      return ['runtimes'];
    case 'profiles':
      return ['profiles'];
    case 'deployments':
    case 'serving-deployments':
    case 'deployment_sets':
    case 'deployment-set':
      return ['deployments', 'status'];
    case 'settings':
    case 'policy':
      return ['status'];
    default:
      return SLICE_KEYS;
  }
};

const BUSY_STATES: ReadonlyArray<string> = ['QUEUED', 'RUNNING'];

const completedJobSlices = (job: Job): SliceKey[] => {
  if (
    job.operation === 'download' ||
    job.repo !== undefined ||
    job.filename !== undefined
  ) {
    return ['models'];
  }
  if (job.deployment_id !== undefined) return ['deployments', 'status'];
  const name = job.name || '';
  if (/^build runtime/i.test(name) || /^pull runtime/i.test(name)) {
    return ['runtimes'];
  }
  if (job.model_id !== undefined) return ['models'];
  return SLICE_KEYS;
};

/** Typed payload for each slice; the keyed state maps to it one-to-one. */
type SliceData = {
  status: AppStatus | null;
  models: Artifact[];
  runtimes: Runtime[];
  profiles: Profile[];
  deployments: Deployment[];
  jobs: Job[];
};
type Slice<T> = {
  data: T;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
};
type Slices = { [K in keyof SliceData]: Slice<SliceData[K]> };
/** The union of every slice's data shape; enough to type a decoupled fetch result. */
type SliceDataValue =
  AppStatus | null | Artifact[] | Runtime[] | Profile[] | Deployment[] | Job[];

function initSlice<T>(data: T): Slice<T> {
  return { data, loading: true, error: null, updatedAt: null };
}

export default function App() {
  const route = useRoute(),
    page = route[0] || 'overview';
  const [slices, setSlices] = useState<Slices>({
      status: initSlice<AppStatus | null>(null),
      models: initSlice<Artifact[]>([]),
      runtimes: initSlice<Runtime[]>([]),
      profiles: initSlice<Profile[]>([]),
      deployments: initSlice<Deployment[]>([]),
      jobs: initSlice<Job[]>([]),
    }),
    [samples, setSamples] = useState<MetricSample[]>([]),
    [events, setEvents] = useState<OperationEvent[]>([]);
  const [connection, setConnection] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null),
    [modalError, setModalError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''),
    [endpoint, setEndpoint] = useState('');
  // Per-slice sequence counters guard against stale responses: a refresh that
  // starts after one in-flight discards the older one's result.
  const seq = useRef<Record<SliceKey, number>>({
    status: 0,
    models: 0,
    runtimes: 0,
    profiles: 0,
    deployments: 0,
    jobs: 0,
  });
  const fetchSlice = useCallback(async (key: SliceKey): Promise<void> => {
    const spec = ENDPOINTS[key];
    const mySeq = ++seq.current[key];
    setSlices((s) => ({ ...s, [key]: { ...s[key], loading: true } }));
    try {
      const value = await readApi(spec.path, spec.decode);
      if (mySeq !== seq.current[key]) return;
      setSlices((s) => ({
        ...s,
        [key]: {
          data: value as SliceDataValue,
          loading: false,
          error: null,
          updatedAt: Date.now(),
        },
      }));
    } catch (e) {
      if (mySeq !== seq.current[key]) return;
      setSlices((s) => ({
        ...s,
        [key]: { ...s[key], loading: false, error: message(e) },
      }));
    }
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all(SLICE_KEYS.map((key) => fetchSlice(key)));
  }, [fetchSlice]);
  useEffect(() => {
    let alive = true;
    const poll = () => {
      void refresh();
    };
    void poll();
    const timer = setInterval(poll, 5000);
    readApi('/api/integration/opencode', contracts.integration)
      .then((r) => {
        if (alive && r.endpoint) setEndpoint(r.endpoint);
      })
      .catch(() => {});
    readApi('/api/history/metrics?hours=1', array(contracts.host))
      .then((r) => {
        if (alive) setSamples(r);
      })
      .catch(() => {});
    const stream = new EventSource('/api/events/stream');
    stream.onopen = () => setConnection(true);
    stream.onerror = () => setConnection(false);
    stream.addEventListener('telemetry', (e) => {
      try {
        const value: unknown = JSON.parse((e as MessageEvent<string>).data);
        const host = contracts.host(value);
        // Refresh the host sample inside the status slice; the registry data
        // (models, runtimes, ...) stays untouched by telemetry.
        setSlices((s) => {
          if (!s.status.data) return s;
          return {
            ...s,
            status: { ...s.status, data: { ...s.status.data, host } },
          };
        });
        setSamples((s) =>
          [...s.filter((old) => old.ts !== host.ts), host]
            .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
            .slice(-500),
        );
      } catch {
        // Malformed telemetry: the next sample recovers; never mask registry data.
      }
    });
    stream.addEventListener('operation', (e) => {
      let event: OperationEvent;
      try {
        const value: unknown = JSON.parse((e as MessageEvent<string>).data);
        event = contracts.operationEvent(value);
      } catch {
        return;
      }
      setEvents((s) =>
        s.some((old) => old.seq === event.seq)
          ? s
          : [event, ...s].slice(0, 200),
      );
    });
    return () => {
      alive = false;
      clearInterval(timer);
      stream.close();
    };
  }, [refresh]);
  useEffect(() => {
    setQuery('');
    document.title =
      (navigation.find((n) => n.id === page)?.label || 'Menagerie') +
      ' · Menagerie';
  }, [page]);
  useEffect(() => {
    if (notice) {
      toast.success(notice);
      setNotice('');
    }
  }, [notice]);
  const revisionId = modal?.type === 'revisions' ? modal.row.id : undefined;
  useEffect(() => {
    if (!revisionId) return;
    let alive = true;
    readApi(`/api/profiles/${revisionId}/revisions`, array(contracts.profile))
      .then((value) => {
        if (alive)
          setModal((current) =>
            current?.type === 'revisions' ? { ...current, value } : current,
          );
      })
      .catch((e) => {
        if (alive) setModalError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [revisionId]);
  const open = (value: ModalState | null) => {
    setModalError('');
    setModal(value);
  };
  const close = () => {
    if (!busy) open(null);
  };
  // Refresh a subset of the registry slices. A missing set is a full refresh
  // (used by the global "Retry"); the 5 s polling fallback covers the rest.
  const refreshSlices = useCallback(
    async (invalidates?: SliceKey[]): Promise<void> => {
      await Promise.all((invalidates ?? SLICE_KEYS).map(fetchSlice));
    },
    [fetchSlice],
  );
  const reload = () => {
    void refreshSlices();
  };
  const completed = (text = '', invalidates?: SliceKey[]) => {
    open(null);
    if (text) setNotice(text);
    void refreshSlices(invalidates);
  };
  async function perform<T>(
    action: () => Promise<T>,
    text = '',
    dismiss = true,
    invalidates?: SliceKey[],
  ): Promise<T | null> {
    setBusy(true);
    setModalError('');
    try {
      const result = await action();
      if (dismiss) completed(text, invalidates);
      else {
        if (text) setNotice(text);
        void refreshSlices(invalidates);
      }
      return result;
    } catch (e) {
      setModalError(message(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  const status = slices.status.data,
    deployments = slices.deployments.data,
    jobs = slices.jobs.data,
    host: HostSnapshot = status?.host || { gpus: [] };
  const serving: ServingDeployment[] =
    status?.serving_deployments ||
    deployments.map((d) => ({
      ...d,
      multi_model: false,
      members: [d],
      member_ids: [d.id],
      inflight: status?.deployments.find((m) => m.id === d.id)?.inflight || 0,
    }));
  const enabled = serving.filter((d) => d.enabled),
    inactive = serving.filter((d) => !d.enabled),
    running = deployments.filter((d) => d.state === 'READY');
  // A slice is only "pending" before its first successful answer; once a slice
  // has responded, refreshes keep its last-good data and must not re-gate the
  // destination.
  const pageKeys: Record<string, SliceKey[]> = {
    overview: ['status', 'deployments'],
    models: ['models', 'jobs'],
    deployments: ['deployments', 'status'],
    activity: ['jobs'],
    settings: ['status'],
  };
  const pageName = navigation.find((n) => n.id === page)?.label || 'Workspace',
    pagePending = pageKeys[page]
      ? pageKeys[page].some(
          (k) => slices[k].loading && slices[k].updatedAt === null,
        )
      : false,
    fetchError = SLICE_KEYS.some((k) => slices[k].error)
      ? 'Connection lost. Displayed data may be out of date.'
      : '',
    connLabel = fetchError
      ? 'Reconnecting'
      : connection
        ? telemetryStale(host)
          ? 'Samples stale'
          : 'Connected'
        : 'Events offline',
    connectionIconClass = fetchError
      ? ''
      : connection && !telemetryStale(host)
        ? 'online'
        : 'caution';
  const data: Registry = {
    models: slices.models.data,
    runtimes: slices.runtimes.data,
    profiles: slices.profiles.data,
    deployments,
    jobs,
    host: status?.host ? [status.host] : [],
    ...(status?.serving_deployments ? { serving } : {}),
  };
  function edit<K extends keyof import('./types').EditableSourceMap>(
    kind: K,
    row?: import('./types').EditableSourceMap[K],
    clone?: boolean,
  ): void;
  function edit(
    kind: keyof import('./types').EditableSourceMap,
    row?: EditableSource,
    clone = false,
  ) {
    if (kind === 'deployment_sets') {
      const group = row ? contracts.servingDeployment(row) : undefined;
      if (group && !group.multi_model)
        throw new Error('Expected a multi-model deployment.');
      open({
        type: 'deployment-set',
        row: group,
      });
      return;
    }
    let editor: import('./types').EditorState;
    if (kind === 'profiles') {
      const value = editable(
        kind,
        row ? contracts.profile(row) : undefined,
        clone,
      );
      if (!row) {
        value.artifact_id = data.models?.[0]?.id || '';
        value.runtime_id = data.runtimes?.[0]?.id || '';
        for (const [key, field] of Object.entries(
          data.runtimes?.[0]?.capabilities?.schema || {},
        )) {
          if (field.default !== undefined) value.config[key] = field.default;
        }
      }
      editor = { kind, value };
    } else if (kind === 'runtimes') {
      editor = {
        kind,
        value: editable(kind, row ? contracts.runtime(row) : undefined, clone),
      };
    } else {
      const value = editable(
        kind,
        row ? contracts.deployment(row) : undefined,
        clone,
      );
      if (clone) {
        const ports = new Set(deployments.map((d) => d.port));
        const port = Array.from({ length: 50000 }, (_, i) => 8120 + i).find(
          (p) => !ports.has(p),
        );
        if (port === undefined)
          throw new Error('No free private port is available.');
        value.port = port;
        value.enabled = false;
      }
      editor = { kind, value };
    }
    open({
      type: 'edit',
      ...editor,
      memberOnly:
        row && 'member_only' in row ? Boolean(row.member_only) : undefined,
      expected:
        clone ||
        !row ||
        !('revision' in row) ||
        typeof row.revision !== 'number'
          ? undefined
          : row.revision,
    });
  }
  const inspect = (title: string, value: unknown) =>
    open({ type: 'inspect', title, value });
  const actions = {
    edit,
    inspect,
    revisions: (row: Profile) =>
      open({ type: 'revisions', title: row.name + ' revisions', row }),
    load: (
      kind: import('./types').LaunchKind,
      row: import('./types').LaunchTarget,
    ) =>
      open({
        type: 'launch',
        kind:
          kind === 'deployments' && data.serving
            ? 'serving-deployments'
            : kind === 'serving-deployments' && !data.serving
              ? 'deployments'
              : kind,
        row,
      }),
    stop: (
      kind: import('./types').LaunchKind,
      row: import('./types').LaunchTarget,
    ) =>
      open({
        type: 'stop',
        kind:
          kind === 'deployments' && data.serving
            ? 'serving-deployments'
            : kind === 'serving-deployments' && !data.serving
              ? 'deployments'
              : kind,
        row,
      }),
    enable: (row: import('./types').LaunchTarget, enabled: boolean) =>
      open({ type: 'enable', row, enabled }),
  };
  const newDeployment = (modelId?: string) => {
    if (!data.models?.length) {
      go('models');
      return;
    }
    open({ type: 'deployment-set', modelId });
  };
  const depView = route[1] === 'disabled' ? 'inactive' : route[1] || 'enabled',
    detail =
      page === 'deployments' && !['enabled', 'inactive'].includes(depView);
  const selected = detail
    ? serving.find((d) => d.id === depView || d.member_ids?.includes(depView))
    : undefined;
  const modelTab =
    route[1] === 'discover'
      ? 'Discover'
      : route[1] === 'downloads'
        ? 'Downloads'
        : 'Installed';
  const activityTab = route[1] === 'requests' ? 'Requests' : 'Events';
  const settingsTab = ['engines', 'host', 'history', 'recovery'].includes(
    route[1],
  )
    ? titleCase(route[1])
    : 'Engines';
  const busyJobs = jobs.filter((j) => ['QUEUED', 'RUNNING'].includes(j.state));
  useEffect(() => {
    if (page === 'activity' && ['operations', 'launches'].includes(route[1]))
      go('activity/events');
    if (page === 'activity' && route[1] === 'sessions')
      go('settings/history/runs');
    if (page === 'deployments' && route[2] === 'policy')
      go(`deployments/${route[1]}/configuration`);
  }, [page, route]);

  const finishedJobs = useRef<Record<string, string>>({});
  useEffect(() => {
    const current: Record<string, string> = {};
    const affected: SliceKey[] = [];
    for (const job of jobs) {
      current[job.id] = job.state;
      const prev = finishedJobs.current[job.id];
      if (
        prev !== undefined &&
        BUSY_STATES.includes(prev) &&
        !BUSY_STATES.includes(job.state)
      ) {
        affected.push(...completedJobSlices(job));
      }
    }
    for (const [id, state] of Object.entries(finishedJobs.current)) {
      if (BUSY_STATES.includes(state) && !(id in current)) {
        affected.push(...SLICE_KEYS);
      }
    }
    const unique = [...new Set(affected)];
    if (unique.length) void refreshSlices(unique);
    finishedJobs.current = current;
  }, [jobs, refreshSlices]);
  return (
    <SidebarProvider>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <Sidebar>
        <SidebarHeader>
          <a className="brand" href="#/overview">
            <img src={brandLogo} width="32" height="32" alt="" />
            <span>menagerie</span>
          </a>
        </SidebarHeader>
        <SidebarContent>
          <MainNavigation page={page} busyCount={busyJobs.length} />
        </SidebarContent>
        <SidebarFooter>
          <div className="connection" role="status">
            <i className={connectionIconClass || undefined} />
            {connLabel}
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset id="main" tabIndex={-1} className="outline-none">
        <div className="flex items-center gap-2 border-b p-3 md:hidden">
          <SidebarTrigger />
          <a className="brand" href="#/overview">
            <img src={brandLogo} width="24" height="24" alt="" />
            <span>menagerie</span>
          </a>
        </div>
        <div className="mx-auto w-full max-w-[1600px] min-w-0 p-4 pb-20 sm:p-6 lg:p-10">
          {fetchError && (
            <Alert variant="destructive" className="mb-5" role="alert">
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
                {fetchError}
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => void reload()}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!detail && (
            <div className="page-head">
              <h1>
                {navigation.find((n) => n.id === page)?.label ||
                  'Page not found'}
              </h1>
              <div className="actions">
                {page === 'overview' && (
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => open({ type: 'connect' })}
                  >
                    Connect client <ArrowUpRight size={16} />
                  </Button>
                )}
                {page === 'models' && (
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => open({ type: 'local-model', path: '' })}
                  >
                    <Plus size={16} />
                    Add from File
                  </Button>
                )}
                {page === 'deployments' && (
                  <Button
                    variant="default"
                    type="button"
                    onClick={() => newDeployment()}
                  >
                    <Plus size={16} />
                    New deployment
                  </Button>
                )}
              </div>
            </div>
          )}
          {pagePending ? (
            <div
              role="status"
              aria-label={`Loading ${pageName}`}
              className="flex flex-col gap-5"
            >
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-72 w-full" />
              <span className="sr-only">Loading {pageName}…</span>
            </div>
          ) : (
            <>
              {host.pressure && (
                <Alert variant="destructive" className="mb-5" role="alert">
                  <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
                    Low memory headroom. Review running deployments.
                  </AlertDescription>
                </Alert>
              )}
              {page === 'overview' && (
                <>
                  <div className="section-heading">
                    <h2>Deployments</h2>
                    <a href="#/deployments">
                      View all <ArrowUpRight size={14} />
                    </a>
                  </div>
                  <Card className="mb-5 min-w-0 gap-0 p-0">
                    <CardContent className="p-0">
                      {enabled.length ? (
                        <ServingTable
                          rows={enabled}
                          host={host}
                          actions={actions}
                          compact
                        />
                      ) : (
                        <Empty
                          title={
                            data.models?.length
                              ? 'No enabled deployments'
                              : 'Add your first model'
                          }
                        >
                          <Button
                            variant="default"
                            type="button"
                            onClick={() =>
                              data.models?.length
                                ? newDeployment()
                                : go('models/discover')
                            }
                          >
                            {data.models?.length
                              ? 'Create deployment'
                              : 'Discover models'}
                          </Button>
                          {!data.models?.length && (
                            <Button
                              variant="outline"
                              type="button"
                              onClick={() =>
                                open({ type: 'local-model', path: '' })
                              }
                            >
                              <Plus size={16} />
                              Add from File
                            </Button>
                          )}
                        </Empty>
                      )}
                    </CardContent>
                  </Card>
                  <div className="stats">
                    {(host.gpus || []).map((g, index: number) => (
                      <Card
                        className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3"
                        key={g.index ?? index}
                      >
                        <CardHeader className="p-0 pb-3">
                          <CardDescription>
                            {host.gpus?.length && host.gpus.length > 1
                              ? `GPU ${g.index ?? index} memory`
                              : 'GPU memory'}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-3 p-0">
                          <strong>
                            {memory(g.used_mib)}{' '}
                            <small>/ {memory(g.total_mib)}</small>
                          </strong>
                          {g.used_mib != null &&
                            g.total_mib != null &&
                            g.total_mib > 0 && (
                              <meter
                                aria-label={
                                  'GPU ' + (g.index ?? index) + ' memory used'
                                }
                                value={g.used_mib || 0}
                                max={g.total_mib || 1}
                              />
                            )}
                        </CardContent>
                      </Card>
                    ))}
                    <Card className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3">
                      <CardHeader className="p-0 pb-3">
                        <CardDescription>Available models</CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3 p-0">
                        <strong>
                          {
                            deployments.filter((d) => d.lifecycle?.serving)
                              .length
                          }
                        </strong>
                        <small>{running.length} loaded</small>
                      </CardContent>
                    </Card>
                    <Card className="mb-5 min-w-0 gap-0 p-5 flex flex-col gap-3">
                      <CardHeader className="p-0 pb-3">
                        <CardDescription>System RAM</CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3 p-0">
                        <strong>
                          {typeof host.ram_total_mib === 'number' &&
                          typeof host.ram_available_mib === 'number'
                            ? memory(
                                host.ram_total_mib - host.ram_available_mib,
                              )
                            : 'Unavailable'}
                        </strong>
                        <small>
                          {memory(host.ram_available_mib)} available
                        </small>
                      </CardContent>
                    </Card>
                  </div>
                  <LiveResources
                    host={host}
                    deployments={deployments}
                    settings={status?.settings || {}}
                  />
                  <div className="section-heading">
                    <h2>Activity</h2>
                    <a href="#/activity">
                      View all <ArrowUpRight size={14} />
                    </a>
                  </div>
                  <Card className="mb-5 min-w-0 gap-0 p-0">
                    <CardContent className="p-0">
                      <ActivityFeed
                        events={events}
                        jobs={jobs}
                        limit={4}
                        deployments={deployments}
                      />
                    </CardContent>
                  </Card>
                  <ProcessResources
                    host={host}
                    deployments={data.deployments || []}
                  />
                  <TelemetrySeries
                    temperatureLimit={status?.settings.temperature_limit}
                    samples={samples}
                    deployments={data.deployments || []}
                    interval={status?.settings.sample_seconds || 2}
                  />
                </>
              )}
              {page === 'models' && (
                <>
                  <Tabs
                    items={['Installed', 'Discover', 'Downloads']}
                    value={modelTab}
                    onChange={(t) => go('models/' + t.toLowerCase())}
                  />
                  {modelTab === 'Installed' ? (
                    <ModelLibrary
                      key={route[2] || 'library'}
                      data={data}
                      query={query}
                      setQuery={setQuery}
                      create={newDeployment}
                      inspect={(title, value) =>
                        open({ type: 'model', title, value })
                      }
                      addFromFile={() =>
                        open({ type: 'local-model', path: '' })
                      }
                      discover={() => go('models/discover')}
                    />
                  ) : modelTab === 'Downloads' ? (
                    <Downloads jobs={jobs} models={data.models} />
                  ) : (
                    <ModelCatalog
                      api={api}
                      queued={() => {
                        void refreshSlices(['jobs']);
                      }}
                    />
                  )}
                </>
              )}
              {page === 'deployments' &&
                (detail ? (
                  selected ? (
                    selected.multi_model ? (
                      <MultiDeploymentDetail
                        key={selected.id}
                        d={selected}
                        tab={
                          [
                            'configuration',
                            'requests',
                            'policy',
                            'activity',
                            'logs',
                          ].includes(route[2])
                            ? titleCase(route[2])
                            : 'Models'
                        }
                        data={data}
                        host={host}
                        actions={actions}
                        events={events}
                        saved={() =>
                          void refreshSlices(affectedSlices('deployment_set'))
                        }
                      />
                    ) : (
                      <DeploymentDetail
                        key={selected.id}
                        d={selected}
                        tab={
                          [
                            'configuration',
                            'requests',
                            'activity',
                            'logs',
                          ].includes(route[2])
                            ? titleCase(route[2])
                            : 'Overview'
                        }
                        data={data}
                        host={host}
                        inflight={selected.inflight || 0}
                        actions={actions}
                        events={events}
                        saved={() =>
                          void refreshSlices(affectedSlices('deployments'))
                        }
                      />
                    )
                  ) : (
                    <Empty title="Deployment not found">
                      <Button
                        nativeButton={false}
                        variant="outline"
                        render={<a href="#/deployments" />}
                      >
                        Back to deployments
                      </Button>
                    </Empty>
                  )
                ) : (
                  <>
                    <Tabs
                      items={[
                        `Enabled (${enabled.length})`,
                        `Disabled (${inactive.length})`,
                      ]}
                      value={
                        depView === 'inactive'
                          ? `Disabled (${inactive.length})`
                          : `Enabled (${enabled.length})`
                      }
                      onChange={(t) =>
                        go('deployments/' + t.split(' ')[0].toLowerCase())
                      }
                    />
                    <Input
                      className="search"
                      type="search"
                      aria-label="Search deployments"
                      placeholder="Search deployments…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <Card className="mb-5 min-w-0 gap-0 p-0">
                      <CardContent className="p-0">
                        {(depView === 'inactive' ? inactive : enabled)
                          .length ? (
                          <ServingTable
                            rows={(depView === 'inactive'
                              ? inactive
                              : enabled
                            ).filter((d) =>
                              (
                                d.name +
                                ' ' +
                                (d.members || [d])
                                  .map((m) => m.alias + ' ' + m.name)
                                  .join(' ')
                              )
                                .toLowerCase()
                                .includes(query.toLowerCase()),
                            )}
                            host={host}
                            actions={actions}
                          />
                        ) : (
                          <Empty
                            title={
                              depView === 'inactive'
                                ? 'No inactive deployments'
                                : 'No enabled deployments'
                            }
                          />
                        )}
                      </CardContent>
                    </Card>
                  </>
                ))}
              {page === 'activity' && (
                <ActivityPage
                  tab={activityTab}
                  jobs={jobs}
                  events={events}
                  deployments={deployments}
                />
              )}
              {page === 'settings' && (
                <SettingsPage
                  tab={settingsTab}
                  data={data}
                  status={status}
                  actions={actions}
                  savePolicy={async (value) => {
                    await api('/api/settings', value);
                    await refresh();
                  }}
                  purge={() => open({ type: 'purge', days: 7 })}
                  backup={() => open({ type: 'backup' })}
                  install={() => open({ type: 'source' })}
                  pull={() =>
                    open({
                      type: 'edit',
                      kind: 'runtimes',
                      pull: true,
                      value: {
                        ...editable('runtimes'),
                        name: 'vLLM container',
                        engine: 'vllm',
                        execution_kind: 'docker',
                      },
                    })
                  }
                />
              )}
            </>
          )}
          {busyJobs.length > 0 && (
            <div
              className="operation-notifications"
              aria-label="Operations running"
            >
              {busyJobs.map((job) => (
                <a
                  key={job.id}
                  className="operation-indicator"
                  href="#/activity/events"
                >
                  <RefreshCw
                    size={14}
                    className={job.state === 'RUNNING' ? 'spin' : undefined}
                  />
                  {job.name}
                  <ArrowUpRight size={14} />
                </a>
              ))}
            </div>
          )}
        </div>
      </SidebarInset>
      {modal?.type === 'wizard' && (
        <DeploymentWizard
          data={data}
          modelId={modal.modelId}
          close={close}
          setupEngine={() => {
            close();
            go('settings/engines');
          }}
          created={(row, load) => {
            void refreshSlices(affectedSlices('deployments'));
            go('deployments/' + row.id);
            open(load ? { type: 'launch', kind: 'deployments', row } : null);
            if (!load) setNotice('Deployment created');
          }}
        />
      )}
      {modal?.type === 'launch' && (
        <LaunchReview
          modal={modal}
          deployments={deployments}
          host={host}
          close={close}
          done={() => completed('', ['deployments', 'status', 'jobs'])}
        />
      )}
      {modal?.type === 'connect' && (
        <Connect endpoint={endpoint} deployments={deployments} close={close} />
      )}
      {modal?.type === 'source' && (
        <SourceBuild
          close={close}
          done={() => completed('', ['runtimes', 'jobs'])}
        />
      )}
      {modal?.type === 'deployment-set' && (
        <DeploymentSetEditor
          initial={modal.row}
          modelId={modal.modelId}
          data={data}
          close={close}
          saved={(id) => {
            completed('Deployment saved', affectedSlices('deployment_set'));
            go(id ? 'deployments/' + id : 'deployments');
          }}
        />
      )}
      {modal &&
        !['wizard', 'launch', 'connect', 'source', 'deployment-set'].includes(
          modal.type,
        ) && (
          <Dialog
            title={
              modal.type === 'new-deployment'
                ? 'New deployment'
                : modal.type === 'edit'
                  ? modal.memberOnly
                    ? 'Edit model'
                    : (modal.value.id
                        ? 'Edit '
                        : modal.pull
                          ? 'Pull '
                          : 'New ') +
                      (
                        {
                          runtimes: 'engine',
                          profiles: 'profile',
                          deployments: 'deployment',
                        } as Record<string, string>
                      )[modal.kind]
                  : modal.type === 'stop'
                    ? 'Unload ' + modal.row.name + '?'
                    : modal.type === 'enable'
                      ? (modal.enabled ? 'Enable ' : 'Disable ') +
                        modal.row.name +
                        '?'
                      : modal.type === 'delete'
                        ? 'Remove ' + modal.value.name + '?'
                        : modal.type === 'local-model'
                          ? 'Add from File'
                          : modal.type === 'policy'
                            ? 'Host policy'
                            : modal.type === 'purge'
                              ? 'Purge telemetry'
                              : modal.type === 'backup'
                                ? 'Registry backup'
                                : modal.type === 'restore'
                                  ? 'Restore configuration?'
                                  : ('title' in modal && modal.title) ||
                                    'Details'
            }
            close={close}
            busy={busy}
            editor={modal.type === 'edit' || modal.type === 'policy'}
            wide={['inspect', 'model', 'edit'].includes(modal.type)}
          >
            {modalError && (
              <Alert variant="destructive" className="mb-5" role="alert">
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
                  {modalError}
                </AlertDescription>
              </Alert>
            )}
            {modal.type === 'new-deployment' && (
              <div className="creation-options">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => open({ type: 'wizard' })}
                >
                  Single model
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => open({ type: 'deployment-set' })}
                >
                  Multiple models
                </Button>
              </div>
            )}
            {modal.type === 'edit' && (
              <Editor
                key={modal.kind + (modal.value.id || 'new')}
                initial={modal}
                data={data}
                busy={busy}
                memberOnly={modal.memberOnly}
                save={(editor) =>
                  void perform(
                    () =>
                      api(
                        modal.pull
                          ? '/api/runtimes/pull'
                          : '/api/' +
                              editor.kind +
                              (modal.expected
                                ? '?expected=' + modal.expected
                                : ''),
                        editor.value,
                      ),
                    modal.pull ? 'Image pull queued' : 'Saved',
                    true,
                    affectedSlices(modal.pull ? 'runtimes' : editor.kind),
                  )
                }
                remove={
                  modal.value.id && !modal.memberOnly
                    ? () => open({ ...modal, type: 'delete' })
                    : undefined
                }
              />
            )}
            {modal.type === 'delete' && (
              <>
                <p>
                  Remove the registry entry? Model files and history will be
                  kept.
                </p>
                <div className="dialog-actions">
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => open({ ...modal, type: 'edit' })}
                  >
                    Back
                  </Button>
                  <Button
                    variant="destructive"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () =>
                          api(
                            `/api/registry/${modal.kind}/${modal.value.id}/delete`,
                            {},
                          ),
                        'Entry removed',
                        true,
                        affectedSlices(modal.kind),
                      )
                    }
                  >
                    Remove entry
                  </Button>
                </div>
              </>
            )}
            {modal.type === 'stop' && (
              <>
                <p>
                  Unloads every model in this deployment and discards its KV
                  caches. Active requests finish first.{' '}
                  {'members' in modal.row && modal.row.members.length > 1
                    ? 'Sibling models remain available so dependent work can finish.'
                    : 'New requests are paused while waiting.'}{' '}
                  To interrupt generation, choose Cancel requests and unload.
                </p>
                {modal.row.residency === 'on-demand' && (
                  <p className="muted">
                    It stays enabled. The next client request can load it again.
                  </p>
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
                    variant="destructive"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () =>
                          api(`/api/${modal.kind}/${modal.row.id}/stop`, {
                            cancel_requests: true,
                          }),
                        'Cancelling requests and unloading',
                        true,
                        ['deployments', 'status'],
                      )
                    }
                  >
                    Cancel requests and unload
                  </Button>
                  <Button
                    variant="destructive"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () =>
                          api(`/api/${modal.kind}/${modal.row.id}/stop`, {}),
                        'Unload queued',
                        true,
                        ['deployments', 'status'],
                      )
                    }
                  >
                    Unload
                  </Button>
                </div>
              </>
            )}
            {modal.type === 'enable' && (
              <>
                <p>
                  {modal.enabled
                    ? 'Enable this deployment for clients? It will not load immediately.'
                    : 'Remove this deployment’s models from client discovery? Their configuration will be kept.'}
                </p>
                <div className="dialog-actions">
                  <Button variant="outline" type="button" onClick={close}>
                    Cancel
                  </Button>
                  <Button
                    variant="default"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () =>
                          api(
                            `/api/${data.serving ? 'serving-deployments' : 'deployments'}/${modal.row.id}/enabled`,
                            { enabled: modal.enabled },
                          ),
                        modal.enabled
                          ? 'Deployment enabled'
                          : 'Deployment disabled',
                        true,
                        ['deployments', 'status'],
                      )
                    }
                  >
                    {modal.enabled ? 'Enable' : 'Disable'}
                  </Button>
                </div>
              </>
            )}
            {modal.type === 'local-model' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void perform(
                    () => api('/api/models/local', { path: modal.path }),
                    '',
                    true,
                    ['models', 'jobs'],
                  );
                }}
              >
                <Field
                  label="Path on the Menagerie host"
                  hint="GGUF file or safetensors directory. Files stay in place; this does not upload files from your browser."
                >
                  <Input
                    autoFocus
                    required
                    placeholder="/path/to/model.gguf"
                    value={modal.path}
                    onChange={(e) =>
                      setModal({ ...modal, path: e.target.value })
                    }
                  />
                </Field>
                <div className="dialog-actions">
                  <Button
                    variant="default"
                    type="submit"
                    disabled={busy || !modal.path}
                  >
                    Add from File
                  </Button>
                </div>
              </form>
            )}
            {modal.type === 'inspect' && (
              <StructuredDetails value={modal.value} />
            )}
            {modal.type === 'revisions' &&
              (modal.value ? (
                <StructuredDetails value={modal.value} />
              ) : (
                <p className="muted">Loading revisions…</p>
              ))}
            {modal.type === 'model' && (
              <>
                <dl className="properties">
                  {[
                    ['Format', modal.value.format],
                    ['Architecture', modal.value.architecture],
                    [
                      'Size (GiB)',
                      number(
                        typeof modal.value.size_bytes === 'number'
                          ? modal.value.size_bytes / 1024 ** 3
                          : undefined,
                      ),
                    ],
                    ['Source', modal.value.source],
                    ['Path', modal.value.local_path],
                    [
                      'Checksum',
                      modal.value.sha256 ? 'Verified' : 'Not verified',
                    ],
                  ].map(([label, value]) => (
                    <div className="property-pair" key={label}>
                      <dt>{label}</dt>
                      <dd>{value || '—'}</dd>
                    </div>
                  ))}
                </dl>
                <details>
                  <summary>Provenance</summary>
                  <Json value={modal.value} />
                </details>
                <div className="dialog-actions">
                  <Button
                    variant="default"
                    type="button"
                    onClick={() => newDeployment(modal.value.id)}
                  >
                    Create deployment
                  </Button>
                </div>
              </>
            )}
            {modal.type === 'policy' && status && (
              <PolicyEditor
                initial={status.settings}
                busy={busy}
                save={(value) =>
                  void perform(
                    () => api('/api/settings', value),
                    'Policy saved',
                    true,
                    ['status'],
                  )
                }
                purge={() => open({ type: 'purge', days: 7 })}
              />
            )}
            {modal.type === 'purge' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void perform(
                    () =>
                      api('/api/history/purge', {
                        older_than_days: modal.days,
                        confirm: true,
                      }),
                    'Telemetry purged',
                  );
                }}
              >
                <Field label="Remove telemetry older than (days)">
                  <Input
                    type="number"
                    required
                    min={1}
                    max={365}
                    value={modal.days}
                    onChange={(e) =>
                      setModal({ ...modal, days: Number(e.target.value) })
                    }
                  />
                </Field>
                <p>
                  Configuration, sessions, model files, and operational events
                  will be kept.
                </p>
                <div className="dialog-actions">
                  <Button variant="destructive" type="submit" disabled={busy}>
                    Purge telemetry
                  </Button>
                </div>
              </form>
            )}
            {modal.type === 'backup' && (
              <>
                <p>
                  Back up the registry, including configuration and history.
                  Model files are not included.
                </p>
                {modal.path ? (
                  <p className="path" role="status">
                    Saved to {modal.path}
                  </p>
                ) : (
                  <div className="dialog-actions">
                    <Button
                      variant="default"
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        const result = await perform(
                          () => readApi('/api/backup', contracts.backup, {}),
                          '',
                          false,
                        );
                        if (result) setModal({ ...modal, path: result.path });
                      }}
                    >
                      Create backup
                    </Button>
                  </div>
                )}
              </>
            )}
            {modal.type === 'restore' && (
              <>
                <p>{modal.text}</p>
                <div className="dialog-actions">
                  <Button
                    variant="default"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(() => api(modal.path, {}), modal.text)
                    }
                  >
                    Restore
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        )}
    </SidebarProvider>
  );
}

function StructuredDetails({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    const rows: unknown[] = value;
    return (
      <>
        {rows.map((v, i) => (
          <section className="comparison-section" key={i}>
            <h3>
              {v && typeof v === 'object'
                ? String(
                    ('deployment' in v && v.deployment) ||
                      ('name' in v && v.name) ||
                      `Record ${i + 1}`,
                  )
                : `Record ${i + 1}`}
            </h3>
            <StructuredDetails value={v} />
          </section>
        ))}
      </>
    );
  }
  if (!value || typeof value !== 'object') return <p>{String(value ?? '—')}</p>;
  return (
    <>
      <dl className="properties">
        {Object.entries(value)
          .filter(([, v]) => v === null || typeof v !== 'object')
          .map(([k, v]) => (
            <div className="property-pair" key={k}>
              <dt>{k.replaceAll('_', ' ')}</dt>
              <dd>
                {typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v ?? '—')}
              </dd>
            </div>
          ))}
      </dl>
      {Object.entries(value)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([k, v]) => (
          <details key={k}>
            <summary>{k.replaceAll('_', ' ')}</summary>
            <StructuredDetails value={v} />
          </details>
        ))}
    </>
  );
}
