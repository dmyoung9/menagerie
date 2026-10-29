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
import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Database,
  Layers,
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
  MemoryChart,
  ModelLibrary,
  SettingsPage,
} from './Views';
import { go } from './navigation';
import {
  api,
  Dialog,
  Empty,
  Field,
  gib,
  Json,
  message,
  number,
  Tabs,
} from './ui';
import brandLogo from './assets/logo-mono.png';
import type {
  AppStatus,
  EditableSource,
  HostSnapshot,
  MetricSample,
  ModalState,
  OperationEvent,
  Profile,
  Registry,
  ServingDeployment,
} from './types';

const navigation = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'models', label: 'Models', icon: Database },
  { id: 'deployments', label: 'Deployments', icon: Layers },
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
  const [route, setRoute] = useState(() =>
    window.location.hash.slice(2).split('/'),
  );
  useEffect(() => {
    const change = () => setRoute(window.location.hash.slice(2).split('/'));
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  return route;
}
export default function App() {
  const route = useRoute(),
    page = route[0] || 'overview';
  const [status, setStatus] = useState<AppStatus | null>(null),
    [data, setData] = useState<Registry>({
      models: [],
      runtimes: [],
      profiles: [],
      deployments: [],
      jobs: [],
      host: [],
    }),
    [samples, setSamples] = useState<MetricSample[]>([]),
    [events, setEvents] = useState<OperationEvent[]>([]);
  const [connection, setConnection] = useState(false),
    [loading, setLoading] = useState(true),
    [fetchError, setFetchError] = useState('');
  const [modal, setModal] = useState<ModalState | null>(null),
    [modalError, setModalError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''),
    [endpoint, setEndpoint] = useState('');
  const refresh = useCallback(async () => {
    const [s, models, runtimes, profiles, deployments, jobs] =
      await Promise.all([
        readApi('/api/status', contracts.status),
        readApi('/api/registry/models', array(contracts.artifact)),
        readApi('/api/registry/runtimes', array(contracts.runtime)),
        readApi('/api/registry/profiles', array(contracts.profile)),
        readApi('/api/registry/deployments', array(contracts.deployment)),
        readApi('/api/registry/jobs', array(contracts.job)),
      ]);
    setStatus(s);
    setData({
      models,
      runtimes,
      profiles,
      deployments,
      jobs,
      host: s.host ? [s.host] : [],
      ...(s.serving_deployments ? { serving: s.serving_deployments } : {}),
    });
    if (s.gateway_url) setEndpoint(s.gateway_url);
    setFetchError('');
    setLoading(false);
  }, []);
  useEffect(() => {
    let alive = true,
      pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        await refresh();
      } catch {
        if (alive) {
          setFetchError('Connection lost. Displayed data may be out of date.');
          setLoading(false);
        }
      } finally {
        pending = false;
      }
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
        setStatus((s) => (s ? { ...s, host } : s));
        setSamples((s) => [...s.slice(-499), host]);
      } catch {
        setFetchError(
          'Received invalid telemetry. Waiting for a valid update.',
        );
      }
    });
    stream.addEventListener('operation', (e) => {
      let event: OperationEvent;
      try {
        const value: unknown = JSON.parse((e as MessageEvent<string>).data);
        event = contracts.operationEvent(value);
      } catch {
        setFetchError('Received an invalid event. Refresh to reconnect.');
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
  const reload = () =>
    refresh().catch(() =>
      setFetchError('Could not refresh. Displayed data may be out of date.'),
    );
  const completed = (text = '') => {
    open(null);
    if (text) setNotice(text);
    void reload();
  };
  async function perform<T>(
    action: () => Promise<T>,
    text = '',
    dismiss = true,
  ): Promise<T | null> {
    setBusy(true);
    setModalError('');
    try {
      const result = await action();
      if (dismiss) completed(text);
      else {
        if (text) setNotice(text);
        void reload();
      }
      return result;
    } catch (e) {
      setModalError(message(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  const deployments = data.deployments || [],
    jobs = data.jobs || [],
    host: HostSnapshot = status?.host || { gpus: [] };
  const serving: ServingDeployment[] =
    data.serving ||
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
  const depView = route[1] || 'enabled',
    detail =
      page === 'deployments' && !['enabled', 'inactive'].includes(depView);
  const selected = detail
    ? serving.find((d) => d.id === depView || d.member_ids?.includes(depView))
    : undefined;
  const modelTab = route[1] === 'discover' ? 'Discover' : 'Installed';
  const activityTab = [
    'events',
    'operations',
    'requests',
    'sessions',
    'launches',
  ].includes(route[1])
    ? titleCase(route[1])
    : 'Events';
  const settingsTab = ['engines', 'host', 'recovery'].includes(route[1])
    ? titleCase(route[1])
    : 'Engines';
  const busyJobs = jobs.filter((j) => ['QUEUED', 'RUNNING'].includes(j.state));
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
            <i className={connection && !fetchError ? 'online' : ''} />
            {connection && !fetchError ? 'Connected' : 'Reconnecting'}
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
          {loading ? (
            <div
              role="status"
              aria-label="Loading workspace"
              className="flex flex-col gap-5"
            >
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-72 w-full" />
              <span className="sr-only">Loading workspace…</span>
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
                            {gib(g.used_mib)}{' '}
                            <small>/ {gib(g.total_mib)} GiB</small>
                          </strong>
                          <meter
                            aria-label={
                              'GPU ' + (g.index ?? index) + ' memory used'
                            }
                            value={g.used_mib || 0}
                            max={g.total_mib || 1}
                          />
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
                            ? gib(host.ram_total_mib - host.ram_available_mib)
                            : '—'}{' '}
                          <small>GiB</small>
                        </strong>
                        <small>
                          {gib(host.ram_available_mib)} GiB available
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
                        events={events
                          .filter(
                            (e) =>
                              ![
                                'QUEUED',
                                'VALIDATING',
                                'STARTING',
                                'LOADING',
                                'STOPPING',
                              ].includes(
                                typeof e.data?.to === 'string' ? e.data.to : '',
                              ),
                          )
                          .slice(0, 4)}
                        deployments={deployments}
                      />
                    </CardContent>
                  </Card>
                  <MemoryChart samples={samples} />
                  <Card>
                    <CardContent>
                      <details className="m-0">
                        <summary>Hardware</summary>
                        <div className="hardware-grid">
                          {(host.gpus || []).map((g, i: number) => (
                            <dl className="properties" key={g.index ?? i}>
                              <dt>GPU {g.index ?? i}</dt>
                              <dd>{g.name}</dd>
                              <dt>Utilization</dt>
                              <dd>{number(g.utilization, 0)}%</dd>
                              <dt>Temperature</dt>
                              <dd>{number(g.temperature, 0)} °C</dd>
                              <dt>Power</dt>
                              <dd>{number(g.power_w, 0)} W</dd>
                            </dl>
                          ))}
                        </div>
                        <dl className="properties">
                          <dt>Disk free</dt>
                          <dd>{number(host.disk_free_gib)} GiB</dd>
                          <dt>CPU</dt>
                          <dd>{number(host.cpu_percent)}%</dd>
                          <dt>Swap used</dt>
                          <dd>{gib(host.swap_used_mib)} GiB</dd>
                        </dl>
                        <details>
                          <summary>GPU processes</summary>
                          <Json value={host.processes || []} />
                        </details>
                      </details>
                    </CardContent>
                  </Card>
                </>
              )}
              {page === 'models' && (
                <>
                  <Tabs
                    items={['Installed', 'Discover']}
                    value={modelTab}
                    onChange={(t) => go('models/' + t.toLowerCase())}
                  />
                  {modelTab === 'Installed' ? (
                    <ModelLibrary
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
                  ) : (
                    <ModelCatalog
                      api={api}
                      queued={() => {
                        setNotice('Download queued');
                        void reload();
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
                          ['policy', 'activity', 'logs'].includes(route[2])
                            ? titleCase(route[2])
                            : 'Models'
                        }
                        data={data}
                        host={host}
                        actions={actions}
                        events={events}
                      />
                    ) : (
                      <DeploymentDetail
                        key={selected.id}
                        d={selected}
                        tab={
                          ['configuration', 'activity', 'logs'].includes(
                            route[2],
                          )
                            ? titleCase(route[2])
                            : 'Overview'
                        }
                        data={data}
                        host={host}
                        inflight={selected.inflight || 0}
                        actions={actions}
                        events={events}
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
                        `Inactive (${inactive.length})`,
                      ]}
                      value={
                        depView === 'inactive'
                          ? `Inactive (${inactive.length})`
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
                  inspect={inspect}
                  restore={(path, text) =>
                    open({ type: 'restore', path, text })
                  }
                />
              )}
              {page === 'settings' && (
                <SettingsPage
                  tab={settingsTab}
                  data={data}
                  status={status}
                  actions={actions}
                  policy={() => open({ type: 'policy' })}
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
            <a className="operation-indicator" href="#/activity/operations">
              <RefreshCw size={14} className="spin" />
              {busyJobs.length === 1
                ? busyJobs[0].name
                : `${busyJobs.length} operations running`}
              <ArrowUpRight size={14} />
            </a>
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
            void reload();
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
          done={() => completed('Launch queued')}
        />
      )}
      {modal?.type === 'connect' && (
        <Connect endpoint={endpoint} deployments={deployments} close={close} />
      )}
      {modal?.type === 'source' && (
        <SourceBuild close={close} done={() => completed('Build queued')} />
      )}
      {modal?.type === 'deployment-set' && (
        <DeploymentSetEditor
          initial={modal.row}
          modelId={modal.modelId}
          data={data}
          close={close}
          saved={(id) => {
            completed('Deployment saved');
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
                  caches. Active requests finish first.
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
                          api(`/api/${modal.kind}/${modal.row.id}/stop`, {}),
                        'Unload queued',
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
                    'Model registration queued',
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
