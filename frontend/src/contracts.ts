import * as d from './decode.ts';
import type * as T from './types';

export const jsonValue: d.Decoder<T.JsonValue> = (value, path = '$') => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') return d.number(value, path);
  if (Array.isArray(value)) return d.array(jsonValue)(value, path);
  return d.record(jsonValue)(value, path);
};
export const jsonObject = d.record(jsonValue);
export const stringArray = d.array(d.string);
export const environment = d.record(d.string);
const opt = d.optional;
const maybeNumber = opt(d.nullable(d.number));
const maybeString = opt(d.nullable(d.string));
const unknownObject = d.record(d.unknown);

export const runtimeField = d.object<T.RuntimeField>({
  type: opt(d.string),
  label: opt(d.string),
  description: opt(d.string),
  default: opt(jsonValue),
  min: opt(d.number),
  max: opt(d.number),
  enum: opt(d.array(jsonValue)),
  options: opt(d.array(jsonValue)),
  choices: opt(stringArray),
  units: opt(d.string),
  cpu_only: opt(d.boolean),
});
const reasoning = d.union(
  d.boolean,
  d.object<{ supported: boolean }>({ supported: d.boolean }),
);
export const modelCapabilities = d.object<T.ModelCapabilities>({
  tools: opt(d.boolean),
  input: stringArray,
  output: stringArray,
  reasoning: opt(reasoning),
});
const partialCapabilities: d.Decoder<Partial<T.ModelCapabilities>> = (
  value,
  path,
) => {
  const fields = d.object({
    tools: opt(d.boolean),
    input: opt(stringArray),
    output: opt(stringArray),
    reasoning: opt(reasoning),
  });
  return fields(value, path);
};
const preset = d.object<T.ReasoningPreset>({
  id: d.string,
  enabled: d.boolean,
  body: jsonObject,
  source: opt(d.string),
});
const variant = d.object<{
  id: string;
  body?: T.JsonObject;
  settings?: T.JsonObject;
}>({ id: d.string, body: opt(jsonObject), settings: opt(jsonObject) });
const catalogSettings = d.object<T.ModelCatalogSettings>({
  name: opt(d.string),
  capabilities: opt(partialCapabilities),
  limit: opt(d.object({ output: opt(d.number), context: opt(d.number) })),
  variants: opt(d.array(variant)),
});
export const modelCatalog = d.object<T.ModelCatalog>({
  catalog_id: opt(d.string),
  model: opt(catalogSettings),
  reasoning: opt(d.object({ presets: opt(d.array(preset)) })),
});
const dependency = d.object<{ name: string; size?: number | null }>({
  name: d.string,
  size: maybeNumber,
});
export const discoveredCapabilities = d.object<T.DiscoveredCapabilities>({
  input: opt(stringArray),
  tools: opt(d.boolean),
  reasoning: opt(reasoning),
  reasoning_effort: opt(stringArray),
  thinking_toggle: opt(d.boolean),
  evidence: opt(stringArray),
  note: opt(d.string),
  warnings: opt(stringArray),
  dependencies: opt(d.array(dependency)),
});
const metadata: d.Decoder<T.ArtifactMetadata> = (value, path) => {
  const result = unknownObject(value, path);
  if (result.config !== undefined && result.config !== null) {
    const config = unknownObject(result.config, `${path}.config`);
    if (config.text_config !== undefined && config.text_config !== null)
      config.text_config = unknownObject(
        config.text_config,
        `${path}.config.text_config`,
      );
    result.config = config;
  }
  if (result.projector !== undefined && result.projector !== null)
    result.projector = d.object({ name: d.string, path: d.string })(
      result.projector,
      `${path}.projector`,
    );
  return result as T.ArtifactMetadata;
};
export const artifact = d.object<T.Artifact>({
  id: d.string,
  revision: d.number,
  name: d.string,
  format: d.string,
  repo: maybeString,
  source_revision: maybeString,
  source: opt(d.string),
  architecture: maybeString,
  size_bytes: opt(d.number),
  quantization: maybeString,
  local_path: opt(d.string),
  sha256: maybeString,
  metadata: opt(metadata),
  discovered_capabilities: opt(discoveredCapabilities),
});
const runtimeCapabilities = d.object<T.RuntimeCapabilities>({
  formats: opt(stringArray),
  schema: opt(d.record(runtimeField)),
});
export const runtime = d.object<T.Runtime>({
  id: d.string,
  revision: d.number,
  name: d.string,
  engine: d.string,
  execution_kind: opt(d.string),
  executable: opt(d.string),
  env: opt(environment),
  command_template: opt(stringArray),
  trust: opt(d.boolean),
  version: maybeString,
  commit: maybeString,
  fork_url: maybeString,
  formats: opt(stringArray),
  managed: opt(d.object({ recipe_id: opt(d.string), backend: opt(d.string) })),
  capabilities: opt(runtimeCapabilities),
});
export const runtimeDraft = d.object<T.RuntimeDraft>({
  id: opt(d.string),
  name: d.string,
  engine: d.string,
  execution_kind: d.string,
  executable: d.string,
  env: environment,
  command_template: stringArray,
  trust: d.boolean,
  version: maybeString,
  commit: maybeString,
  fork_url: maybeString,
  formats: opt(stringArray),
});
export const profileDraft = d.object<T.ProfileDraft>({
  id: opt(d.string),
  name: d.string,
  artifact_id: d.string,
  runtime_id: d.string,
  config: jsonObject,
  raw_args: stringArray,
  catalog: modelCatalog,
});
export const profile = d.object<T.Profile>({
  id: d.string,
  name: d.string,
  artifact_id: d.string,
  runtime_id: d.string,
  config: jsonObject,
  raw_args: stringArray,
  catalog: modelCatalog,
  revision: d.number,
});
const lifecycle = d.object<T.DeploymentLifecycle>({
  deployed: opt(d.boolean),
  runtime: opt(d.string),
  serving: opt(d.boolean),
  failure: maybeString,
  last_stop_reason: maybeString,
});
export const deployment: d.Decoder<T.Deployment> = (value, path) =>
  d.object<T.Deployment>({
    id: d.string,
    name: d.string,
    profile_id: maybeString,
    profile_snapshot: opt(profile),
    alias: d.string,
    port: opt(d.number),
    residency: opt(d.string),
    priority: opt(d.number),
    idle_timeout: opt(d.number),
    reservation_mib: opt(d.number),
    allow_eviction: opt(d.boolean),
    allow_uncertain: opt(d.boolean),
    enabled: d.boolean,
    state: d.string,
    gpu: opt(d.number),
    queue_timeout: opt(d.number),
    revision: d.number,
    member_only: opt(d.boolean),
    unit_id: opt(d.string),
    lifecycle: opt(lifecycle),
    inflight: opt(d.number),
  })(value, path);
export const servingDeployment: d.Decoder<T.ServingDeployment> = (
  value,
  path = '$',
) => {
  const input = d.recordValue(value, path);
  const members = d.array(deployment)(input.members, `${path}.members`);
  const member_ids = stringArray(input.member_ids, `${path}.member_ids`);
  const multi = d.boolean(input.multi_model, `${path}.multi_model`);
  if (!multi)
    return {
      ...deployment(value, path),
      multi_model: false,
      members,
      member_ids,
    };
  // A group has no member-specific alias, private port, or profile snapshot.
  for (const key of [
    'alias',
    'port',
    'gpu',
    'profile_id',
    'profile_snapshot',
    'configuration',
  ]) {
    if (input[key] !== undefined)
      d.fail(`${path}.${key}`, 'no member-specific field on a serving group');
  }
  const common = d.object({
    id: d.string,
    name: d.string,
    enabled: d.boolean,
    state: d.string,
    residency: opt(d.string),
    priority: opt(d.number),
    idle_timeout: opt(d.number),
    queue_timeout: opt(d.number),
    allow_eviction: opt(d.boolean),
    allow_uncertain: opt(d.boolean),
    revision: d.number,
    lifecycle: opt(lifecycle),
    inflight: opt(d.number),
  })(value, path);
  return { ...common, multi_model: true, members, member_ids };
};
export const deploymentDraft = d.object<T.DeploymentDraft>({
  id: opt(d.string),
  name: d.string,
  profile_id: opt(d.string),
  configuration: opt(profileDraft),
  alias: d.string,
  port: d.number,
  residency: d.string,
  priority: d.number,
  idle_timeout: d.number,
  reservation_mib: d.number,
  allow_eviction: d.boolean,
  allow_uncertain: d.boolean,
  enabled: d.boolean,
  gpu: d.number,
  queue_timeout: d.number,
});
export const deploymentSetDraft = d.object<T.DeploymentSetDraft>({
  id: opt(d.string),
  name: d.string,
  residency: d.string,
  priority: d.number,
  idle_timeout: d.number,
  allow_eviction: d.boolean,
  allow_uncertain: d.boolean,
  enabled: d.boolean,
  queue_timeout: d.number,
  members: d.array(deploymentDraft),
});
export const gpu = d.object<T.GpuSnapshot>({
  index: d.number,
  name: d.string,
  total_mib: maybeNumber,
  used_mib: maybeNumber,
  free_mib: maybeNumber,
  utilization: maybeNumber,
  temperature: maybeNumber,
  power_w: maybeNumber,
  clock_mhz: maybeNumber,
});
const deploymentMetrics = d.object<T.HostDeploymentMetrics>({
  gpu_mib: maybeNumber,
  rss_mib: maybeNumber,
  cpu_percent: maybeNumber,
  swap_mib: maybeNumber,
  pids: opt(d.array(d.number)),
});
export const host = d.object<T.HostSnapshot>({
  ts: opt(d.number),
  age_seconds: opt(d.number),
  stale: opt(d.boolean),
  cpu_count: maybeNumber,
  cpu_percent: opt(d.number),
  ram_total_mib: opt(d.number),
  ram_available_mib: maybeNumber,
  swap_used_mib: opt(d.number),
  disk_free_gib: opt(d.number),
  disk_total_gib: opt(d.number),
  load_average: opt(d.array(d.number)),
  gpus: opt(d.array(gpu)),
  processes: opt(
    d.array(
      d.object<T.ProcessSample>({
        pid: d.number,
        name: d.string,
        gpu_mib: d.nullable(d.number),
      }),
    ),
  ),
  errors: opt(stringArray),
  pressure: opt(d.boolean),
  deployments: opt(d.record(deploymentMetrics)),
  runtime_metrics: opt(d.record(d.record(d.number))),
});
export const settings = d.object<T.HostSettings>({
  gpu_headroom_mib: d.number,
  ram_headroom_mib: d.number,
  temperature_limit: d.number,
  max_queue: d.number,
  sample_seconds: d.number,
  retention_days: d.number,
  summary_days: d.number,
  history_quota_mib: d.number,
  expose_on_demand: d.boolean,
});
export const status = d.object<T.AppStatus>({
  version: d.string,
  csrf_token: d.string,
  host,
  collector: opt(
    d.object<T.CollectorHealth>({
      consecutive_errors: d.number,
      last_error: maybeString,
      last_error_at: maybeNumber,
    }),
  ),
  deployments: d.array(deployment),
  serving_deployments: opt(d.array(servingDeployment)),
  settings,
  queue: d.number,
  gateway: d.string,
  gateway_url: d.string,
  state_path: d.string,
});
export function eventPayload(event: T.OperationEvent): T.OperationEventPayload {
  const data = event.data || {};
  if (event.kind === 'state')
    return {
      ...d.object<{ to?: string; state?: string; reason?: string | null }>({
        to: opt(d.string),
        state: opt(d.string),
        reason: maybeString,
      })(data),
      kind: 'state',
    };
  if (event.kind === 'deployment' && typeof data.enabled === 'boolean')
    return { kind: 'deployment', enabled: data.enabled };
  return { kind: 'other', value: data };
}
export const operationEvent: d.Decoder<T.OperationEvent> = (value, path) => {
  const event = d.object<T.OperationEvent>({
    seq: d.number,
    ts: d.number,
    kind: d.string,
    deployment_id: maybeString,
    data: opt(unknownObject),
  })(value, path);
  eventPayload(event);
  return event;
};
export const job = d.object<T.Job>({
  id: d.string,
  revision: d.number,
  name: d.string,
  state: d.string,
  created_at: d.number,
  progress: opt(d.string),
  error: opt(d.string),
});
export const recommendation = d.object<T.RuntimeRecommendation>({
  gpu_layers_max: maybeNumber,
  gpu_memory_utilization_min: opt(d.number),
  gpu_memory_utilization_max: opt(d.number),
  context_key: opt(d.string),
  context_recommended_max: maybeNumber,
  context_default: maybeNumber,
  parallel_recommended_max: maybeNumber,
  reason: opt(d.string),
});
export const engineRecommendation = d.object<T.EngineRecommendation>({
  engine: maybeString,
  reason: opt(d.string),
});
export const resourceEstimate = d.object<T.ResourceEstimate>({
  idle_mib: opt(d.number),
  peak_mib: d.number,
  ram_mib: opt(d.number),
  components: opt(d.nullable(d.record(d.number))),
  confidence: d.string,
  provenance: d.string,
  reservation_mib: d.number,
});
export const resourcePreview = d.object<T.ResourcePreview>({
  members: d.array(
    d.object<T.ResourcePreviewMember>({
      key: d.string,
      name: d.string,
      gpu: d.number,
      estimate: resourceEstimate,
      recommendation: opt(recommendation),
    }),
  ),
  gpus: d.array(
    d.object<T.ResourcePreviewGpu>({
      index: d.number,
      name: d.string,
      total_mib: d.number,
      used_mib: d.number,
      reserve_mib: d.number,
      draft_mib: d.number,
      remaining_mib: d.number,
      reservation_error: d.boolean,
      verdict: d.string,
    }),
  ),
  ram_available_mib: d.nullable(d.number),
  ram_reserve_mib: d.number,
  sample_ts: maybeNumber,
  note: opt(d.string),
});
export const resourcePreviewDraft = d.object<T.ResourcePreviewDraft>({
  name: opt(d.string),
  gpu: opt(d.number),
  reservation_mib: opt(d.number),
  configuration: opt(profileDraft),
});
export const resourceDraft = d.object<T.ResourceDraft>({
  name: d.string,
  gpu: d.number,
  reservation_mib: d.number,
  configuration: profileDraft,
});
export const resourcePreviewRequest = d.object<T.ResourcePreviewRequest>({
  members: d.array(resourceDraft),
});
export const launchPlan = d.object<T.LaunchPlan>({
  estimates: d.record(
    d.object<T.ReservationEstimate>({
      reservation_mib: d.number,
      confidence: d.string,
    }),
  ),
  stops: stringArray,
  errors: stringArray,
  warnings: stringArray,
  plan_token: d.string,
});
export const engineCatalog = d.object<T.EngineReleaseCatalog>({
  engines: d.array(
    d.object<T.EngineCatalogEntry>({
      id: d.string,
      name: d.string,
      description: opt(d.string),
      note: opt(d.string),
      releases: d.array(
        d.object<T.EngineRelease>({
          id: d.string,
          version: d.string,
          backend: d.string,
          requirements: opt(d.string),
        }),
      ),
    }),
  ),
  note: opt(d.string),
});
export const catalogModel = d.object<T.CatalogModel>({
  id: d.string,
  tags: opt(d.nullable(stringArray)),
  downloads: maybeNumber,
  likes: maybeNumber,
  pipeline_tag: maybeString,
  gated: opt(d.nullable(d.union(d.boolean, d.string))),
});
const catalogFile = d.object<import('./variants').CatalogFile>({
  name: d.string,
  size: d.nullable(d.number),
  sha256: maybeString,
});
export const catalogFiles = d.object<T.CatalogFiles>({
  revision: d.string,
  files: d.array(catalogFile),
  capabilities: opt(
    d.object({
      input: stringArray,
      tools: opt(d.boolean),
      reasoning: opt(reasoning),
      evidence: stringArray,
      note: opt(d.string),
      warnings: opt(stringArray),
      dependencies: d.array(catalogFile),
    }),
  ),
});
export const catalogRevision = d.object<T.CatalogRevision>({
  name: d.string,
  kind: d.string,
});
export const historySession = d.object<T.HistorySession>({
  id: d.string,
  started_at: d.number,
  deployment_snapshot: (value, path) => {
    const input = d.recordValue(value, path);
    return {
      ...deployment(value, path),
      profile_snapshot: profile(
        input.profile_snapshot,
        `${path}.profile_snapshot`,
      ),
    };
  },
  peak_gpu_mib: opt(d.number),
  peak_ram_mib: opt(d.number),
  outcome: opt(d.string),
});
export const historyRequest = d.object<T.HistoryRequest>({
  id: d.string,
  data: d.object({
    model_alias: opt(d.string),
    latency: maybeNumber,
    ttft: maybeNumber,
    output_tokens: maybeNumber,
    error: maybeString,
  }),
});
export const historyActivation = d.object<T.HistoryActivation>({
  id: d.string,
  state: d.string,
  started_at: d.number,
  deployment_name: opt(d.string),
});
export const logs = d.object<{ text: string }>({ text: d.string });
export const backup = d.object<{ path: string }>({ path: d.string });
export const integration = d.object<{ endpoint: string }>({
  endpoint: d.string,
});
export const identity = d.object<{ id: string }>({ id: d.string });
export const sourceBuildPlan = d.object<T.SourceBuildPlan>({
  warning: d.string,
  commands: d.array(stringArray),
  token: d.string,
});
