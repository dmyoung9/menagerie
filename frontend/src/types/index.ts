/** JSON-compatible values accepted by runtime configuration and request bodies. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;
export type UnknownRecord = Record<string, unknown>;

export type RuntimeField = {
  type?: string;
  label?: string;
  description?: string;
  default?: JsonValue;
  min?: number;
  max?: number;
  enum?: JsonValue[];
  options?: JsonValue[];
  choices?: string[];
  units?: string;
  cpu_only?: boolean;
};

export type ModelCapabilities = {
  tools?: boolean;
  input: string[];
  output: string[];
  reasoning?: boolean | { supported: boolean };
};
export type ReasoningPreset = {
  id: string;
  enabled: boolean;
  body: JsonObject;
  source?: string;
};
export type ModelCatalogSettings = {
  name?: string;
  capabilities?: Partial<ModelCapabilities>;
  limit?: { output?: number; context?: number };
  variants?: { id: string; body?: JsonObject; settings?: JsonObject }[];
};
export type ModelCatalog = {
  catalog_id?: string;
  model?: ModelCatalogSettings;
  reasoning?: { presets?: ReasoningPreset[] };
};
export type ConfiguredModelCatalog = Omit<
  ModelCatalog,
  'model' | 'reasoning'
> & {
  model: ModelCatalogSettings & { capabilities: ModelCapabilities };
  reasoning: { presets: ReasoningPreset[] };
};

export type DiscoveredCapabilities = {
  input?: string[];
  tools?: boolean;
  reasoning?: boolean | { supported: boolean };
  reasoning_effort?: string[];
  thinking_toggle?: boolean;
  evidence?: string[];
  note?: string;
  warnings?: string[];
  dependencies?: { name: string; size?: number | null }[];
};
export type ArtifactMetadata = UnknownRecord & {
  config?: (UnknownRecord & { text_config?: UnknownRecord | null }) | null;
  projector?: { name: string; path: string } | null;
};
export type Artifact = {
  id: string;
  revision: number;
  name: string;
  format: string;
  repo?: string | null;
  source_revision?: string | null;
  source?: string;
  architecture?: string | null;
  size_bytes?: number;
  quantization?: string | null;
  local_path?: string;
  sha256?: string | null;
  metadata?: ArtifactMetadata;
  discovered_capabilities?: DiscoveredCapabilities;
};
export type RuntimeCapabilities = {
  formats?: string[];
  schema?: Record<string, RuntimeField>;
};
export type Runtime = {
  id: string;
  revision: number;
  name: string;
  engine: string;
  execution_kind?: string;
  executable?: string;
  env?: Record<string, string>;
  command_template?: string[];
  trust?: boolean;
  version?: string | null;
  commit?: string | null;
  fork_url?: string | null;
  formats?: string[];
  managed?: { recipe_id?: string; backend?: string };
  capabilities?: RuntimeCapabilities;
};
export type Profile = {
  id: string;
  name: string;
  artifact_id: string;
  runtime_id: string;
  config: Record<string, JsonValue>;
  raw_args: string[];
  catalog: ModelCatalog;
  revision: number;
};
export type ProfileDraft = Omit<Profile, 'id' | 'revision'> & {
  id?: string;
};
export type DeploymentDraft = {
  id?: string;
  name: string;
  profile_id?: string;
  configuration?: ProfileDraft;
  alias: string;
  port: number;
  residency: string;
  priority: number;
  idle_timeout: number;
  reservation_mib: number;
  allow_eviction: boolean;
  allow_uncertain: boolean;
  enabled: boolean;
  gpu: number;
  queue_timeout: number;
};
export type DeploymentSetDraft = {
  id?: string;
  name: string;
  residency: string;
  priority: number;
  idle_timeout: number;
  allow_eviction: boolean;
  allow_uncertain: boolean;
  enabled: boolean;
  queue_timeout: number;
  members: DeploymentDraft[];
};
export type DeploymentLifecycle = {
  deployed?: boolean;
  runtime?: string;
  serving?: boolean;
  failure?: string | null;
  last_stop_reason?: string | null;
};
export type Deployment = {
  id: string;
  name: string;
  profile_id?: string | null;
  profile_snapshot?: Profile;
  alias: string;
  port?: number;
  residency?: string;
  priority?: number;
  idle_timeout?: number;
  reservation_mib?: number;
  allow_eviction?: boolean;
  allow_uncertain?: boolean;
  enabled: boolean;
  state: string;
  gpu?: number;
  queue_timeout?: number;
  revision: number;
  member_only?: boolean;
  unit_id?: string;
  lifecycle?: DeploymentLifecycle;
  inflight?: number;
};
export type StandaloneServingDeployment = Deployment & {
  multi_model: false;
  members: Deployment[];
  member_ids: string[];
};
export type DeploymentSet = Omit<
  Deployment,
  'alias' | 'profile_id' | 'profile_snapshot' | 'port' | 'gpu'
> & {
  multi_model: true;
  alias?: never;
  members: Deployment[];
  member_ids: string[];
};
export type ServingDeployment = StandaloneServingDeployment | DeploymentSet;
export type LaunchTarget = Deployment | ServingDeployment;
export type LaunchKind = 'deployments' | 'serving-deployments';
export type Registry = {
  models: Artifact[];
  runtimes: Runtime[];
  profiles: Profile[];
  deployments: Deployment[];
  deployment_sets?: DeploymentSet[];
  jobs: Job[];
  host: HostSnapshot[];
  serving?: ServingDeployment[];
};

export type GpuSnapshot = {
  index: number;
  name: string;
  total_mib?: number | null;
  used_mib?: number | null;
  free_mib?: number | null;
  utilization?: number | null;
  temperature?: number | null;
  power_w?: number | null;
  clock_mhz?: number | null;
};
export type HostDeploymentMetrics = {
  gpu_mib?: number | null;
  rss_mib?: number | null;
  cpu_percent?: number | null;
  swap_mib?: number | null;
  pids?: number[];
};
export type ProcessSample = {
  pid: number;
  name: string;
  gpu_mib: number | null;
};
export type HostSnapshot = {
  ts?: number;
  cpu_count?: number | null;
  cpu_percent?: number;
  ram_total_mib?: number;
  ram_available_mib?: number | null;
  swap_used_mib?: number;
  disk_free_gib?: number;
  disk_total_gib?: number;
  load_average?: number[];
  gpus?: GpuSnapshot[];
  processes?: ProcessSample[];
  errors?: string[];
  pressure?: boolean;
  deployments?: Record<string, HostDeploymentMetrics>;
  runtime_metrics?: Record<string, Record<string, number>>;
};
export type HostSettings = {
  gpu_headroom_mib: number;
  ram_headroom_mib: number;
  temperature_limit: number;
  max_queue: number;
  sample_seconds: number;
  retention_days: number;
  summary_days: number;
  history_quota_mib: number;
  expose_on_demand: boolean;
};
export type Settings = HostSettings;
export type HostPolicyDraft = HostSettings;
export type RuntimeRecommendation = {
  gpu_layers_max?: number | null;
  gpu_memory_utilization_min?: number;
  gpu_memory_utilization_max?: number;
  context_key?: string;
  context_recommended_max?: number | null;
  context_default?: number | null;
  parallel_recommended_max?: number | null;
  reason?: string;
};
export type EngineRecommendation = {
  engine?: string | null;
  reason?: string;
};
export type AppStatus = {
  version: string;
  csrf_token: string;
  host: HostSnapshot;
  deployments: Deployment[];
  serving_deployments?: ServingDeployment[];
  settings: HostSettings;
  queue: number;
  gateway: string;
  gateway_url: string;
  state_path: string;
};
export type OperationEvent = {
  seq: number;
  ts: number;
  kind: string;
  deployment_id?: string | null;
  data?: UnknownRecord;
};
export type OperationEventPayload =
  | { kind: 'state'; to?: string; state?: string; reason?: string | null }
  | { kind: 'deployment'; enabled: boolean }
  | { kind: 'other'; value: UnknownRecord };
export type SourceBuildDraft = {
  engine: 'llama.cpp' | 'prism';
  url: string;
  commit: string;
};
export type SourceBuildPlan = {
  warning: string;
  commands: string[][];
  token: string;
};
export type Job = {
  id: string;
  revision: number;
  name: string;
  state: string;
  created_at: number;
  progress?: string;
  error?: string;
};
export type MetricSample = HostSnapshot;
export type EngineRelease = {
  id: string;
  version: string;
  backend: string;
  requirements?: string;
};
export type EngineCatalogEntry = {
  id: string;
  name: string;
  description?: string;
  note?: string;
  releases: EngineRelease[];
};
export type EngineReleaseCatalog = {
  engines: EngineCatalogEntry[];
  note?: string;
};
export type ResourceEstimate = {
  idle_mib?: number;
  peak_mib: number;
  ram_mib?: number;
  components?: Record<string, number> | null;
  confidence: string;
  provenance: string;
  reservation_mib: number;
};
export type ResourcePreviewMember = {
  key: string;
  name: string;
  gpu: number;
  estimate: ResourceEstimate;
  recommendation?: RuntimeRecommendation & {
    context_default?: number | null;
    context_recommended_max?: number | null;
    parallel_recommended_max?: number | null;
  };
};
export type ResourcePreviewGpu = {
  index: number;
  name: string;
  total_mib: number;
  used_mib: number;
  reserve_mib: number;
  draft_mib: number;
  remaining_mib: number;
  reservation_error: boolean;
  verdict: string;
};
export type ResourcePreview = {
  gpus: ResourcePreviewGpu[];
  members: ResourcePreviewMember[];
  ram_available_mib: number | null;
  ram_reserve_mib: number;
  sample_ts?: number | null;
  note?: string;
};
export type ResourcePreviewDraft = {
  name?: string;
  gpu?: number;
  reservation_mib?: number;
  configuration?: ProfileDraft;
};
export type ResourceDraft = Required<ResourcePreviewDraft>;
export type ResourcePreviewRequest = { members: ResourceDraft[] };

export type RuntimeDraft = {
  id?: string;
  name: string;
  engine: string;
  execution_kind: string;
  executable: string;
  env: Record<string, string>;
  command_template: string[];
  trust: boolean;
  version?: string | null;
  commit?: string | null;
  fork_url?: string | null;
  formats?: string[];
};
export type EditorDraftMap = {
  profiles: ProfileDraft;
  deployments: DeploymentDraft;
  runtimes: RuntimeDraft;
};
export type EditorKind = keyof EditorDraftMap;
export type EditorDraft = EditorDraftMap[EditorKind];
export type EditableSourceMap = {
  profiles: Profile;
  deployments: Deployment;
  runtimes: Runtime;
  deployment_sets: DeploymentSet;
};
export type EditableSource = EditableSourceMap[keyof EditableSourceMap];
export type EditAction = <K extends keyof EditableSourceMap>(
  kind: K,
  row?: EditableSourceMap[K],
  clone?: boolean,
) => void;
export type EditorState = {
  [K in EditorKind]: { kind: K; value: EditorDraftMap[K] };
}[EditorKind];
export type EditModal = EditorState & {
  type: 'edit';
  memberOnly?: boolean;
  expected?: number;
  pull?: boolean;
};
export type DeleteModal = EditorState & {
  type: 'delete';
  memberOnly?: boolean;
  expected?: number;
  pull?: boolean;
};

export type LaunchModal = {
  type: 'launch';
  kind: LaunchKind;
  row: LaunchTarget;
};
export type ModalState =
  | { type: 'wizard'; modelId?: string }
  | { type: 'new-deployment' }
  | {
      type: 'deployment-set';
      row?: DeploymentSet;
      modelId?: string;
    }
  | { type: 'connect' }
  | { type: 'source' }
  | LaunchModal
  | { type: 'stop'; kind: LaunchKind; row: LaunchTarget }
  | { type: 'enable'; row: LaunchTarget; enabled: boolean }
  | EditModal
  | DeleteModal
  | { type: 'inspect'; title: string; value: unknown }
  | {
      type: 'revisions';
      title: string;
      row: Profile;
      value?: ProfileRevision[];
    }
  | { type: 'model'; title: string; value: Artifact }
  | { type: 'local-model'; path: string }
  | { type: 'policy' }
  | { type: 'purge'; days: number }
  | { type: 'backup'; path?: string }
  | { type: 'restore'; path: string; text: string };

export type CatalogModel = {
  id: string;
  tags?: string[] | null;
  downloads?: number | null;
  likes?: number | null;
  pipeline_tag?: string | null;
  gated?: boolean | string | null;
};
export type CatalogFiles = {
  revision: string;
  files: import('../variants').CatalogFile[];
  capabilities?: {
    input: string[];
    tools?: boolean;
    reasoning?: boolean | { supported: boolean };
    evidence: string[];
    note?: string;
    warnings?: string[];
    dependencies: import('../variants').CatalogFile[];
  };
};
export type CatalogRevision = { name: string; kind: string };
export type DeploymentActions = {
  enable: (row: LaunchTarget, enabled: boolean) => void;
  stop: (kind: LaunchKind, row: LaunchTarget) => void;
  load: (kind: LaunchKind, row: LaunchTarget) => void;
  edit: EditAction;
};
export type ReservationEstimate = {
  reservation_mib: number;
  confidence: string;
};
export type LaunchPlan = {
  estimates: Record<string, ReservationEstimate>;
  stops: string[];
  errors: string[];
  warnings: string[];
  plan_token: string;
};

export type HistoryRequest = {
  id: string;
  data: {
    model_alias?: string;
    latency?: number | null;
    ttft?: number | null;
    output_tokens?: number | null;
    error?: string | null;
  } & UnknownRecord;
};
export type HistorySession = {
  id: string;
  started_at: number;
  deployment_snapshot: Deployment & {
    profile_snapshot: Profile;
  };
  peak_gpu_mib?: number;
  peak_ram_mib?: number;
  outcome?: string;
};
export type HistoryActivation = {
  id: string;
  state: string;
  started_at: number;
  deployment_name?: string;
};
export type ProfileRevision = Profile & { revision: number };
