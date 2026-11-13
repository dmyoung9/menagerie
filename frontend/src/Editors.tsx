import { FieldSet, FieldGroup } from '@/components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { SettingsSection } from '@/components/settings-section';
import { CardAdvanced } from '@/components/card-advanced';
import { ConfigurationSearchProvider } from '@/components/configuration-search';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { Field, JsonEdit, Menu, type Registry } from './ui';
import { EngineCatalog } from './EngineCatalog';
import {
  Duration,
  Placement,
  RuntimeControl,
  RuntimeSettings,
} from './FormControls';
import { RuntimeFlagCard } from './RuntimeFlagCard';
import { DraftResources } from './Resources';
import { useResourcePreview } from './hooks/use-resource-preview';
import { Capabilities, OutputLimit } from './Capabilities';
import { DefaultReasoning, Variants } from './ReasoningVariants';
import { useConfirmation } from '@/hooks/use-confirmation';
import { useSuggestedAlias } from '@/hooks/use-suggested-alias';
import { fetchSuggestedAlias } from './alias-suggestion';
import { readApi, api } from './ui';
import {
  engineRecommendation,
  jsonObject,
  stringArray,
  modelCatalog,
  environment,
  profileDraft,
  deploymentDraft,
  runtimeDraft,
  runtimeCapabilities,
} from './contracts';
import { recordValue } from './decode';
import { reconcileDeep } from './reconcile';
import { editable } from './editor-state';
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert';
import { artifactLimits } from './artifact-metadata';
import type {
  Artifact,
  Deployment,
  EditorDraft,
  EditorDraftMap,
  EditorState,
  EngineRecommendation,
  EditableSource,
  JsonValue,
  Profile,
  ProfileDraft,
  Runtime,
  RuntimeRecommendation,
} from './types';
import { ChatTemplateSettings } from './ChatTemplateSettings';
import { ModelCompanions, MtpTuning } from './ModelCompanions';
import { NumberControl } from './NumberControl';
import { byteSize, quantization } from './variants';
import type { RuntimeCapabilities } from './types';
import { DraftFormProvider, useDraftForm } from './use-draft-form';
import type { ConfigPath } from './draft-form';
import {
  CapabilityIntelligence,
  SamplingRecommendations,
} from './CapabilityIntelligence';
import { capabilityPreview } from './contracts';
import type { CapabilityPreview, TemplateSelection } from './types';

const RESOURCE_PRIMARY = [
  'ctx-size',
  'max-model-len',
  'parallel',
  'fit',
  'gpu-layers',
  'gpu-memory-utilization',
];
const RESOURCE_ADVANCED = [
  'fit-target',
  'fit-ctx',
  'device',
  'split-mode',
  'tensor-split',
  'override-tensor',
  'cpu-moe',
  'n-cpu-ffn',
  'n-cpu-moe',
];
const ATTENTION_KEYS = ['flash-attn', 'cache-type-k', 'cache-type-v'];
const BATCH_KEYS = ['threads', 'threads-batch', 'batch-size', 'ubatch-size'];
const GENERATION_KEYS = [
  'temp',
  'top-p',
  'top-k',
  'min-p',
  'presence-penalty',
  'repeat-penalty',
  'reasoning-budget',
];
const MODEL_COMPONENT_KEYS = [
  'mmproj',
  'spec-type',
  'spec-draft-model',
  'model-draft',
];
const MODEL_TUNING_KEYS = [
  'spec-draft-n-min',
  'spec-draft-n-max',
  'draft-min',
  'draft-max',
];
const RESOURCE_KEYS = [
  ...new Set([
    ...RESOURCE_PRIMARY,
    ...RESOURCE_ADVANCED,
    ...ATTENTION_KEYS,
    ...BATCH_KEYS,
  ]),
];
const MODEL_KEYS = [...MODEL_COMPONENT_KEYS, ...MODEL_TUNING_KEYS];

export function ConfigurationFields({
  value,
  data,
  set,
  onValid,
  recommendation,
  modelFields,
  placementFields,
  formPath = 'configuration.config',
  templateOverride,
  runtimeLocked = false,
  observed,
  observedAt,
  deploymentId,
  search = '',
  availability,
  forecast,
}: {
  value: ProfileDraft;
  data: Registry;
  set: (value: ProfileDraft) => void;
  onValid: (valid: boolean) => void;
  recommendation?: RuntimeRecommendation;
  modelFields?: ReactNode;
  placementFields?: ReactNode;
  formPath?: ConfigPath;
  templateOverride?: TemplateSelection | null;
  runtimeLocked?: boolean;
  observed?: Record<string, number>;
  observedAt?: number;
  deploymentId?: string;
  search?: string;
  availability?: ReactNode;
  forecast?: ReactNode;
}) {
  const { confirm, confirmation } = useConfirmation();
  const runtime = data.runtimes?.find((r) => r.id === value.runtime_id);
  const artifact = data.models?.find((m) => m.id === value.artifact_id);
  const [probed, setProbed] = useState<{
    key: string;
    capabilities: RuntimeCapabilities;
  }>();
  const [intelligence, setIntelligence] = useState<{
    key: string;
    value: CapabilityPreview;
  }>();
  const capabilityKey = JSON.stringify([
    value,
    templateOverride,
    runtime?.revision,
    artifact?.revision,
  ]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (value.artifact_id && value.runtime_id)
        readApi('/api/capabilities/preview', capabilityPreview, {
          configuration: value,
          template_override: templateOverride,
          deployment_id: deploymentId,
        })
          .then((result) => {
            if (alive) setIntelligence({ key: capabilityKey, value: result });
          })
          .catch(() => {
            /* Unavailable evidence never blocks manual configuration. */
          });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [capabilityKey, value, templateOverride, deploymentId, observed]);
  const capabilityData =
    intelligence?.key === capabilityKey ? intelligence.value : undefined;
  const runtimeKey = `${runtime?.id}:${runtime?.revision}`;
  useEffect(() => {
    let alive = true;
    if (runtime?.id)
      readApi(`/api/runtimes/${runtime.id}/capabilities`, runtimeCapabilities)
        .then((capabilities) => {
          if (alive) setProbed({ key: runtimeKey, capabilities });
        })
        .catch(() => {
          /* Saved defaults remain usable; missing engine defaults stay unknown. */
        });
    return () => {
      alive = false;
    };
  }, [runtime?.id, runtimeKey]);
  const schema = {
    ...(probed?.key === runtimeKey
      ? probed.capabilities.schema
      : runtime?.capabilities?.schema),
  };
  const { context: modelContext, layers } = artifactLimits(artifact);
  for (const key of ['ctx-size', 'max-model-len'])
    if (schema[key] && modelContext)
      schema[key] = {
        ...schema[key],
        max: Math.min(
          schema[key].max ?? modelContext,
          modelContext *
            (key === 'ctx-size' &&
            typeof value.config.parallel === 'number' &&
            value.config.parallel > 0
              ? value.config.parallel
              : 1),
        ),
      };
  if (
    schema.parallel &&
    typeof value.config['ctx-size'] === 'number' &&
    value.config['ctx-size'] > 0
  )
    schema.parallel = {
      ...schema.parallel,
      max: Math.min(
        schema.parallel.max ?? Number.MAX_SAFE_INTEGER,
        Math.floor(value.config['ctx-size'] / 32),
      ),
    };
  if (schema['gpu-layers'] && runtime?.managed?.backend === 'cpu')
    schema['gpu-layers'] = { ...schema['gpu-layers'], cpu_only: true };
  if (schema['n-cpu-moe'] && layers)
    schema['n-cpu-moe'] = {
      ...schema['n-cpu-moe'],
      max: Math.min(schema['n-cpu-moe'].max ?? layers, layers),
    };
  const [engineHint, setEngineHint] = useState<EngineRecommendation>({}),
    [installing, setInstalling] = useState(false);
  useEffect(() => {
    let alive = true;
    setEngineHint({});
    if (value.artifact_id)
      readApi(
        `/api/models/${value.artifact_id}/engine-recommendation`,
        engineRecommendation,
      )
        .then((hint) => {
          if (alive) setEngineHint(hint);
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [value.artifact_id]);
  const engines = (data.runtimes || []).filter(
    (r) =>
      r.id === value.runtime_id ||
      artifact?.format === 'unknown' ||
      (artifact !== undefined &&
        r.capabilities?.formats?.includes(artifact.format)),
  );
  const [validity, setValidity] = useState<Record<string, boolean>>({});
  const valid = (key: string, ok: boolean) => {
    const next = { ...validity, [key]: ok };
    setValidity(next);
    onValid(Object.values(next).every(Boolean));
  };
  const catalog = structuredClone(value.catalog || {});
  delete catalog.catalog_id;
  if (catalog.model) delete catalog.model.name;

  const query = search.trim().toLowerCase();
  const matches = (...parts: (string | undefined)[]) =>
    !query || parts.filter(Boolean).join(' ').toLowerCase().includes(query);
  const describe = (keys: string[]) =>
    keys.flatMap((key) =>
      schema[key]
        ? [
            key,
            schema[key].label,
            schema[key].description,
            schema[key].presentation?.category,
          ]
        : [key],
    );
  const overrides = (keys: string[]) =>
    keys.filter((key) => value.config[key] !== undefined);
  const setConfig = (key: string, next: JsonValue | undefined) => {
    const config = { ...value.config };
    if (next === undefined) delete config[key];
    else config[key] = next;
    set({ ...value, config });
  };

  const contextKey = schema['ctx-size']
    ? 'ctx-size'
    : schema['max-model-len']
      ? 'max-model-len'
      : undefined;
  const deviceKey = schema['gpu-layers']
    ? 'gpu-layers'
    : schema['gpu-memory-utilization']
      ? 'gpu-memory-utilization'
      : undefined;
  const advancedResourceKeys = [
    ...RESOURCE_ADVANCED,
    ...RESOURCE_PRIMARY.filter(
      (key) => ![contextKey, deviceKey, 'parallel', 'fit'].includes(key),
    ),
  ].filter((key) => schema[key] && key !== deviceKey);
  const attentionKeys = ATTENTION_KEYS.filter((key) => schema[key]);
  const batchKeys = BATCH_KEYS.filter((key) => schema[key]);
  const generationKeys = GENERATION_KEYS.filter((key) => schema[key]);
  const advancedGenerationKeys = generationKeys.filter((key) => key !== 'temp');
  const modelTuningKeys = MODEL_TUNING_KEYS.filter((key) => schema[key]);
  const knownConfigKeys = new Set([
    ...Object.keys(schema),
    ...(schema['spec-type'] ? MODEL_COMPONENT_KEYS : []),
  ]);
  const unsupportedKeys = Object.keys(value.config).filter(
    (key) => !knownConfigKeys.has(key) && key !== 'extension',
  );
  const groupedKeys = new Set([
    ...MODEL_KEYS,
    ...RESOURCE_KEYS,
    ...GENERATION_KEYS,
  ]);
  const otherKeys = Object.keys(schema).filter((key) => !groupedKeys.has(key));

  const contextMax = contextKey
    ? Math.min(
        schema[contextKey].max ?? Number.MAX_SAFE_INTEGER,
        modelContext ?? Number.MAX_SAFE_INTEGER,
      )
    : undefined;
  const contextStops = contextKey
    ? [8192, 16384, 32768, 65536, 131072, 262144].filter(
        (stop) =>
          stop >= (schema[contextKey].min ?? 0) &&
          (contextMax === undefined || stop <= contextMax),
      )
    : [];
  const automatic = contextKey
    ? schema[contextKey].presentation?.automatic_value
    : undefined;

  const resourcesHidden = !matches(
    'resources context memory placement gpu concurrency',
    ...describe([
      ...RESOURCE_PRIMARY,
      ...RESOURCE_ADVANCED,
      ...ATTENTION_KEYS,
      ...BATCH_KEYS,
    ]),
  );
  const generationHidden = !matches(
    'generation sampling temperature output tokens reasoning',
    ...describe(GENERATION_KEYS),
  );
  const modelHidden = !matches(
    'model runtime engine chat template components projector mtp capabilities',
    ...describe([...MODEL_COMPONENT_KEYS, ...MODEL_TUNING_KEYS]),
    artifact?.name,
    runtime?.name,
  );
  const variantsHidden = !matches(
    'variants reasoning levels default',
    ...Object.keys(catalog.reasoning?.presets || {}),
  );
  const diagnosticsHidden = !matches(
    'diagnostics raw json arguments observed unsupported',
    ...Object.keys(value.config),
    ...Object.keys(observed || {}),
  );

  return (
    <ConfigurationSearchProvider value={search}>
      {confirmation}
      <SettingsSection
        name="model"
        title="Model & runtime"
        description="Weights, engine, chat template and components."
        hidden={modelHidden}
        summary={<OverrideBadge keys={overrides(MODEL_KEYS)} />}
      >
        <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Model">
            <NativeSelect
              required
              value={value.artifact_id || ''}
              onChange={async (e) => {
                const id = e.target.value;
                const next = data.models?.find((m) => m.id === id);
                if (
                  next &&
                  !runtime?.capabilities?.formats?.includes(next.format)
                ) {
                  if (
                    !(await confirm(
                      'This model needs a different engine. Reset engine settings?',
                    ))
                  )
                    return;
                  let hint: EngineRecommendation = {};
                  try {
                    hint = await readApi(
                      `/api/models/${next!.id}/engine-recommendation`,
                      engineRecommendation,
                    );
                  } catch {
                    /* Manual selection remains available. */
                  }
                  const compatible = (data.runtimes || []).filter(
                    (r) =>
                      next.format === 'unknown' ||
                      r.capabilities?.formats?.includes(next.format),
                  );
                  const engine =
                    compatible.find((r) => r.engine === hint.engine) ||
                    compatible[0];
                  set({
                    ...value,
                    artifact_id: id,
                    runtime_id: engine?.id || '',
                    config: {},
                    raw_args: [],
                  });
                } else set({ ...value, artifact_id: id });
              }}
            >
              {(data.models || [])
                .filter(
                  (m) =>
                    !runtimeLocked ||
                    m.id === value.artifact_id ||
                    runtime?.capabilities?.formats?.includes(m.format),
                )
                .map((m) => (
                  <NativeSelectOption key={m.id} value={m.id}>
                    {m.name}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
          <Field label="Engine">
            <NativeSelect
              required
              disabled={runtimeLocked}
              value={value.runtime_id || ''}
              onChange={async (e) => {
                const id = e.target.value;
                if (
                  value.runtime_id &&
                  !(await confirm(
                    'Change engine? Engine-specific settings and arguments will be reset.',
                  ))
                )
                  return;
                const config: Record<string, JsonValue> = {};
                setValidity({});
                onValid(true);
                set({ ...value, runtime_id: id, config, raw_args: [] });
              }}
            >
              <NativeSelectOption value="" disabled>
                Select compatible engine
              </NativeSelectOption>
              {engines.map((r) => (
                <NativeSelectOption key={r.id} value={r.id}>
                  {r.name}
                  {engineHint.engine === r.engine &&
                  (!engineHint.source ||
                    r.managed?.source === engineHint.source)
                    ? ' · Recommended'
                    : ''}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              variant="outline"
              type="button"
              onClick={() => setInstalling(!installing)}
              disabled={runtimeLocked}
            >
              {installing ? 'Hide engine downloads' : 'Install an engine'}
            </Button>
          </Field>
        </FieldGroup>
        {installing && (
          <EngineCatalog
            runtimes={data.runtimes || []}
            recommended={engineHint.source ?? engineHint.engine ?? undefined}
          />
        )}
        {modelFields}
        <ModelCompanions
          model={artifact}
          models={data.models || []}
          value={value}
          schema={schema}
          change={set}
        />
        <CardAdvanced
          title="Capabilities, tuning & model details"
          overrides={[
            ...overrides(modelTuningKeys),
            ...(catalog.model?.capabilities ? ['client declarations'] : []),
          ]}
          defaultOpen={Boolean(
            query &&
            matches(
              'capabilities evidence declarations mtp draft',
              ...describe(modelTuningKeys),
            ),
          )}
        >
          <CapabilityIntelligence preview={capabilityData} />
          {artifact && (
            <dl className="properties">
              <dt>Architecture</dt>
              <dd>{artifact.architecture || 'Unknown'}</dd>
              <dt>File size</dt>
              <dd>
                {artifact.size_bytes
                  ? byteSize(artifact.size_bytes)
                  : 'Unknown'}
              </dd>
              <dt>Quantization</dt>
              <dd>{quantization(artifact.name).quant || 'Unknown'}</dd>
              <dt>Training context</dt>
              <dd>
                {modelContext
                  ? `${modelContext.toLocaleString()} tokens`
                  : 'Unknown'}
              </dd>
            </dl>
          )}
          {modelTuningKeys.length > 0 && (
            <MtpTuning
              schema={schema}
              value={value.config}
              change={(config) => set({ ...value, config })}
              disabled={
                value.config['spec-type'] === 'none' ||
                !(
                  value.config['spec-type'] ||
                  value.config['spec-draft-model'] ||
                  value.config['model-draft']
                )
              }
            />
          )}
          <Capabilities
            key={value.artifact_id + ':' + value.runtime_id}
            catalog={catalog}
            change={(catalog) => set({ ...value, catalog })}
            valid={valid}
            showOutputLimit={false}
          />
        </CardAdvanced>
        <p className="text-muted-foreground text-sm">
          Startup settings apply on the next load.
        </p>
      </SettingsSection>

      <SettingsSection
        name="memory"
        title="Resources & context"
        description="Capacity and placement."
        hidden={resourcesHidden}
        summary={
          <OverrideBadge
            keys={overrides([
              'ctx-size',
              'max-model-len',
              'parallel',
              'fit',
              'gpu-layers',
              'gpu-memory-utilization',
              ...advancedResourceKeys,
              ...attentionKeys,
              ...batchKeys,
            ])}
          />
        }
      >
        {!runtime && (
          <p className="text-muted-foreground text-sm">
            Choose an engine to see supported context and memory options.
          </p>
        )}
        {!contextKey &&
        !schema.parallel &&
        !schema.fit &&
        !deviceKey &&
        !placementFields &&
        !advancedResourceKeys.length &&
        !attentionKeys.length &&
        !batchKeys.length ? (
          <p className="text-muted-foreground text-sm">
            This engine manages context and memory automatically.
          </p>
        ) : (
          <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {contextKey && (
              <div className="configuration-primary">
                <RuntimeControl
                  configKey={contextKey}
                  schema={schema}
                  value={value.config}
                  change={(config) => set({ ...value, config })}
                  recommendation={recommendation}
                  compact
                />
                <div className="preset-row">
                  {contextStops.map((stop) => (
                    <Button
                      key={stop}
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfig(contextKey, stop)}
                    >
                      {stop / 1024}K
                    </Button>
                  ))}
                  {modelContext && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setConfig(contextKey, modelContext);
                      }}
                    >
                      Model max
                    </Button>
                  )}
                  {automatic !== undefined && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfig(contextKey, automatic)}
                    >
                      Automatic ({String(automatic)})
                    </Button>
                  )}
                </div>
                {value.config[contextKey] === automatic &&
                  automatic !== undefined && (
                    <p className="text-muted-foreground text-sm">
                      {contextKey === 'max-model-len'
                        ? '0 uses the model maximum context.'
                        : '0 uses the model context; no explicit limit is applied.'}
                    </p>
                  )}
              </div>
            )}
            {schema.parallel && (
              <RuntimeControl
                configKey="parallel"
                schema={schema}
                value={value.config}
                change={(config) => set({ ...value, config })}
                recommendation={recommendation}
                compact
              />
            )}
            {placementFields}
            {schema.fit && (
              <RuntimeControl
                configKey="fit"
                schema={schema}
                value={value.config}
                change={(config) => set({ ...value, config })}
                recommendation={recommendation}
                compact
              />
            )}
            {deviceKey && (
              <RuntimeControl
                configKey={deviceKey}
                schema={schema}
                value={value.config}
                change={(config) => set({ ...value, config })}
                recommendation={recommendation}
                compact
              />
            )}
          </FieldGroup>
        )}
        {(advancedResourceKeys.length > 0 ||
          attentionKeys.length > 0 ||
          batchKeys.length > 0) && (
          <CardAdvanced
            title="Advanced placement & memory"
            overrides={overrides([
              ...advancedResourceKeys,
              ...attentionKeys,
              ...batchKeys,
            ])}
            defaultOpen={Boolean(
              query &&
              matches(
                'placement memory offload cache attention batching threads',
                ...describe([
                  ...advancedResourceKeys,
                  ...attentionKeys,
                  ...batchKeys,
                ]),
              ),
            )}
          >
            {advancedResourceKeys.length > 0 && (
              <>
                <h4>Placement & memory</h4>
                <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {advancedResourceKeys.map((key) => (
                    <RuntimeControl
                      key={key}
                      configKey={key}
                      schema={schema}
                      value={value.config}
                      change={(config) => set({ ...value, config })}
                      recommendation={recommendation}
                      compact
                    />
                  ))}
                </FieldGroup>
              </>
            )}
            {attentionKeys.length > 0 && (
              <>
                <h4>Attention & cache</h4>
                <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {attentionKeys.map((key) => (
                    <RuntimeControl
                      key={key}
                      configKey={key}
                      schema={schema}
                      value={value.config}
                      change={(config) => set({ ...value, config })}
                      recommendation={recommendation}
                      compact
                    />
                  ))}
                </FieldGroup>
              </>
            )}
            {batchKeys.length > 0 && (
              <>
                <h4>CPU & batching</h4>
                <RuntimeFlagCard
                  bare
                  name="performance"
                  title="CPU and batching"
                  keys={batchKeys}
                  schema={schema}
                  value={value.config}
                  change={(config) => set({ ...value, config })}
                  host={data.host?.[0] || {}}
                  disabled={!runtime}
                  formPath={formPath}
                  engineSelected={Boolean(runtime)}
                  showEmpty={false}
                />
              </>
            )}
          </CardAdvanced>
        )}
        <p className="text-muted-foreground text-sm">
          Startup settings apply on the next load.
        </p>
      </SettingsSection>

      {forecast && <div className="configuration-card-wide">{forecast}</div>}

      <SettingsSection
        name="generation"
        title="Generation"
        description="Response defaults."
        hidden={generationHidden}
        summary={
          <OverrideBadge
            keys={[
              ...overrides(generationKeys),
              ...(catalog.model?.limit?.output !== undefined
                ? ['output tokens']
                : []),
              ...(catalog.reasoning?.default_mode ? ['default reasoning'] : []),
            ]}
          />
        }
      >
        <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <OutputLimit
            compact
            catalog={catalog}
            change={(catalog) => set({ ...value, catalog })}
          />
          {schema.temp && (
            <div className="configuration-primary">
              <RuntimeControl
                configKey="temp"
                schema={schema}
                value={value.config}
                change={(config) => set({ ...value, config })}
                recommendation={recommendation}
                compact
              />
              <div className="preset-row">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfig('temp', 0)}
                >
                  Greedy (0)
                </Button>
              </div>
            </div>
          )}
          <DefaultReasoning
            catalog={catalog}
            change={(catalog) => set({ ...value, catalog })}
          />
        </FieldGroup>
        {generationKeys.length > 0 || capabilityData?.recommendations.length ? (
          <CardAdvanced
            title="Advanced sampling"
            overrides={overrides(advancedGenerationKeys)}
            defaultOpen={Boolean(
              query &&
              matches(
                'sampling top-p top-k min-p penalty reasoning budget',
                ...describe(advancedGenerationKeys),
              ),
            )}
          >
            <RuntimeFlagCard
              bare
              name="generation"
              title="Advanced sampling"
              keys={advancedGenerationKeys}
              schema={schema}
              value={value.config}
              change={(config) => set({ ...value, config })}
              host={data.host?.[0] || {}}
              disabled={!runtime}
              formPath={formPath}
              engineSelected={Boolean(runtime)}
              showEmpty={false}
            />
            <SamplingRecommendations
              preview={capabilityData}
              apply={(values) =>
                set({
                  ...value,
                  config: { ...value.config, ...values },
                })
              }
            />
          </CardAdvanced>
        ) : null}
        <p className="text-muted-foreground text-sm">
          Engine sampling defaults apply on the next load; clients may override
          them per request.
        </p>
      </SettingsSection>

      <Variants
        catalog={catalog}
        change={(catalog) => set({ ...value, catalog })}
        collapsible
        showDefault={false}
        hidden={variantsHidden}
      />

      {availability}

      <SettingsSection
        name="diagnostics"
        title="Diagnostics & raw"
        description="Effective values, observations and engine-specific escape hatches."
        hidden={diagnosticsHidden}
        className="configuration-card-wide"
        collapsible
        defaultOpen={false}
        summary={
          <OverrideBadge
            keys={[
              ...unsupportedKeys,
              ...otherKeys.filter((key) => value.config[key] !== undefined),
              ...(value.raw_args.length ? ['raw arguments'] : []),
            ]}
          />
        }
      >
        <h4>Requested configuration</h4>
        {Object.keys(value.config).length ? (
          <dl className="properties">
            {Object.entries(value.config).map(([key, current]) => (
              <div className="property-pair" key={key}>
                <dt>{key}</dt>
                <dd>{String(current)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground text-sm">
            No explicit engine overrides. Requested values are engine defaults.
          </p>
        )}
        {observed && (
          <>
            <h4>Last observed runtime settings</h4>
            {observedAt !== undefined && (
              <p className="text-muted-foreground text-sm">
                Observed{' '}
                <time dateTime={new Date(observedAt * 1000).toISOString()}>
                  {new Date(observedAt * 1000).toLocaleString()}
                </time>
              </p>
            )}
            <p className="text-muted-foreground text-sm">
              Reported by the last loaded session, not requested values. Draft
              changes do not update these facts.
            </p>
            <dl className="properties">
              {Object.entries(observed).map(([key, current]) => (
                <div className="property-pair" key={key}>
                  <dt>{key} · observed</dt>
                  <dd>{current.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        {unsupportedKeys.length > 0 && (
          <>
            <h4>Unsupported saved overrides</h4>
            <p className="text-muted-foreground text-sm">
              This engine no longer advertises these options. Reset them to stop
              sending them on the next load.
            </p>
            <ul className="unsupported-overrides">
              {unsupportedKeys.map((key) => (
                <li key={key}>
                  <code>{key}</code> = <code>{String(value.config[key])}</code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfig(key, undefined)}
                  >
                    Reset {key}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
        {otherKeys.length > 0 && (
          <>
            <h4>Other engine controls</h4>
            <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {otherKeys.map((key) => (
                <RuntimeControl
                  key={key}
                  configKey={key}
                  schema={schema}
                  value={value.config}
                  change={(config) => set({ ...value, config })}
                  recommendation={recommendation}
                  compact
                />
              ))}
            </FieldGroup>
          </>
        )}
        <JsonEdit
          inline
          label="Runtime options (JSON)"
          decode={jsonObject}
          value={value.config}
          onChange={(config) => set({ ...value, config })}
          onValid={(ok) => valid('config', ok)}
        />
        <JsonEdit
          inline
          label="Engine arguments"
          readOnly={runtimeLocked}
          decode={stringArray}
          value={value.raw_args}
          onChange={(raw_args) => set({ ...value, raw_args })}
          onValid={(ok) => valid('args', ok)}
        />
        <JsonEdit
          inline
          label="Client capabilities (JSON)"
          decode={modelCatalog}
          value={catalog}
          onChange={(catalog) => set({ ...value, catalog })}
          onValid={(ok) => valid('catalog', ok)}
        />
      </SettingsSection>
    </ConfigurationSearchProvider>
  );
}

function OverrideBadge({ keys }: { keys: string[] }) {
  if (!keys.length) return <span className="muted">Engine defaults</span>;
  return (
    <Badge variant="secondary" title={`Explicit: ${keys.join(', ')}`}>
      {keys.length} override{keys.length === 1 ? '' : 's'}
    </Badge>
  );
}

type EditorProps = {
  initial: EditorState;
  save: (value: EditorState) => void;
  data: Registry;
  remove?: () => void;
  busy: boolean;
  memberOnly?: boolean;
  disabled?: boolean;
  embedded?: boolean;
  /** Show the revision-conflict alert with a Review changes action. */
  revisionConflict?: boolean;
  /** Called with the freshly fetched record after the draft is reconciled. */
  onReconciled?: (fresh: EditableSource) => void;
};
type EditorField =
  | keyof EditorDraftMap['profiles']
  | keyof EditorDraftMap['deployments']
  | keyof EditorDraftMap['runtimes'];
export function Editor(props: EditorProps) {
  const { initial, data, remove, busy, onReconciled } = props;
  const kind = initial.kind;
  const owner =
    kind === 'deployments'
      ? data.serving?.find(
          (unit) =>
            unit.multi_model &&
            unit.member_ids.includes(initial.value.id || ''),
        )
      : undefined;
  const memberOnly = props.memberOnly || Boolean(owner);
  const { confirm: confirmRename, confirmation: renameConfirmation } =
    useConfirmation();
  const [namingError, setNamingError] = useState('');
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [wide, setWide] = useState(
    () => window.matchMedia('(min-width: 1200px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1200px)');
    const update = () => setWide(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const formElement = useRef<HTMLFormElement>(null);
  const [hiddenCards, setHiddenCards] = useState(0);
  useEffect(() => {
    setHiddenCards(
      formElement.current?.querySelectorAll('[data-settings-section][hidden]')
        .length ?? 0,
    );
  }, [search]);
  const [issues, setIssues] = useState(0);
  const issueFields = useRef(new Set<string>());
  const {
    form,
    value,
    setValue,
    changed: draftChanged,
    reset,
  } = useDraftForm<EditorDraft>(initial.value, async (value) => {
    if (Object.values(invalid).some(Boolean) || busy || props.disabled) return;
    if (kind === 'profiles') props.save({ kind, value: profileDraft(value) });
    else if (kind === 'deployments') {
      const draft = deploymentDraft(value);
      let alias = draft.alias;
      setNamingError('');
      if (generatedRename) {
        try {
          alias = (await fetchSuggestedAlias(draft.name, draft.id)).alias;
        } catch (error) {
          setNamingError(String(error));
          return;
        }
      }
      const old = deploymentDraft(initial.value).alias;
      if (
        draft.id &&
        alias !== old &&
        !(await confirmRename(
          `Clients using ${old} will need to switch to ${alias}.`,
          'Rename and update API model ID',
        ))
      )
        return;
      props.save({ kind, value: { ...draft, alias } });
    } else props.save({ kind, value: runtimeDraft(value) });
  });
  // The mount-time draft is the reference for "touched vs adopted" fields.
  // It must not follow the live initial (which becomes the fresh value after a
  // conflict review), or untouched fields would keep stale server values.
  const mountRef = useRef<EditorDraft | null>(null);
  if (mountRef.current === null) mountRef.current = initial.value;
  const [epoch, setEpoch] = useState(0);
  const reviewRevision = async () => {
    if (busy || props.disabled) return;
    const list = (await api(`/api/registry/${kind}`)) as {
      id?: string;
      revision?: number;
    }[];
    const fresh = list.find(
      (r) => r.id === (initial.value.id as string | undefined),
    );
    if (!fresh) return;
    const freshValue =
      kind === 'profiles'
        ? editable('profiles', fresh as Profile)
        : kind === 'deployments'
          ? editable('deployments', fresh as Deployment)
          : editable('runtimes', fresh as Runtime);
    setValue(
      reconcileDeep(mountRef.current!, freshValue, value) as EditorDraft,
    );
    onReconciled?.(fresh as EditableSource);
  };
  const changed = draftChanged || Object.values(invalid).some(Boolean);
  const navigationGuard = useUnsavedChanges(
    !!props.embedded && changed,
    !!props.embedded && busy,
  );
  const profile = 'artifact_id' in value ? value : undefined;
  const deployment = 'alias' in value ? value : undefined;
  const originalDeployment =
    'alias' in initial.value ? initial.value : undefined;
  const generatedRename = Boolean(
    deployment &&
    deployment.identifier_mode !== 'custom' &&
    (deployment.name !== originalDeployment?.name ||
      originalDeployment?.identifier_mode === 'custom'),
  );
  const aliasSuggestion = useSuggestedAlias(
    deployment?.name || '',
    generatedRename,
    deployment?.id,
  );
  const runtime = 'engine' in value ? value : undefined;
  const decode = {
    profiles: profileDraft,
    deployments: deploymentDraft,
    runtimes: runtimeDraft,
  }[kind];
  const read = (key: EditorField): unknown => recordValue(value)[key];
  const unitId = memberOnly
    ? data.deployments?.find((m) => m.id === value.id)?.unit_id
    : undefined;
  const peers = unitId
    ? (data.deployments || [])
        .filter((d) => d.unit_id === unitId && d.id !== value.id)
        .map((d) => ({ ...d, configuration: d.profile_snapshot }))
    : [];
  const preview = useResourcePreview(
    deployment?.configuration ? [deployment, ...peers] : [],
    data.host?.[0]?.ts,
  );
  const set = (key: EditorField, v: unknown) =>
    setValue((prev) => decode({ ...prev, [key]: v }));
  const input = (
    key: EditorField,
    label: string,
    type = 'text',
    min?: number,
    max?: number,
  ) => (
    <Field label={label}>
      {type === 'number' ? (
        <NumberControl
          label={label}
          required
          min={min}
          max={max}
          value={
            typeof read(key) === 'number' ? (read(key) as number) : undefined
          }
          change={(v) => set(key, v ?? 0)}
        />
      ) : (
        <Input
          required={!['commit', 'fork_url'].includes(key)}
          type={type}
          min={min}
          max={max}
          value={
            typeof read(key) === 'string' || typeof read(key) === 'number'
              ? String(read(key))
              : ''
          }
          onChange={(e) => set(key, e.target.value)}
        />
      )}
    </Field>
  );
  const check = (key: EditorField, label: string) => (
    <label className="check">
      <Checkbox
        checked={!!read(key)}
        onCheckedChange={(checked) => set(key, checked)}
      />
      {label}
    </label>
  );
  const select = (
    key: EditorField,
    rows: (Artifact | Runtime)[],
    label: string,
  ) => (
    <Field label={label}>
      <NativeSelect
        required
        value={
          typeof read(key) === 'string' || typeof read(key) === 'number'
            ? String(read(key))
            : ''
        }
        onChange={(e) => set(key, e.target.value)}
      >
        <NativeSelectOption value="" disabled>
          Select…
        </NativeSelectOption>
        {rows.map((r) => (
          <NativeSelectOption key={r.id} value={r.id}>
            {r.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
  const json = (
    key: 'config' | 'raw_args' | 'catalog' | 'env' | 'command_template',
    label: string,
  ) => (
    <JsonEdit
      label={label}
      decode={
        key === 'raw_args' || key === 'command_template'
          ? stringArray
          : key === 'catalog'
            ? modelCatalog
            : key === 'env'
              ? environment
              : jsonObject
      }
      value={read(key)}
      onChange={(v) => set(key, v)}
      onValid={(valid) => setInvalid((prev) => ({ ...prev, [key]: !valid }))}
    />
  );
  const q = search.trim().toLowerCase();
  const identityHidden =
    !!q &&
    !`identity display name api model id ${String(read('name') || '')} ${String(read('alias') || '')}`
      .toLowerCase()
      .includes(q);
  const policy = owner ?? deployment;
  const idleMinutes =
    policy?.idle_timeout && policy.idle_timeout % 60 === 0
      ? policy.idle_timeout / 60
      : undefined;
  const policyLine = policy
    ? [
        policy.residency === 'pinned'
          ? 'Pinned'
          : policy.residency === 'evictable'
            ? 'Evictable'
            : 'On demand',
        `priority ${policy.priority ?? '—'}`,
        policy.residency === 'on-demand'
          ? policy.idle_timeout
            ? `unload after ${idleMinutes ? `${idleMinutes} min` : `${policy.idle_timeout}s`} idle`
            : 'never unload'
          : 'always resident',
        policy.allow_eviction ? 'may unload for others' : 'no eviction',
        `queue ${policy.queue_timeout ?? '—'}s`,
        policy.enabled ? 'enabled for clients' : 'disabled for clients',
      ].join(' · ')
    : '';
  const availabilityHidden =
    !!q &&
    !`availability mode priority idle eviction enabled queue timeout private port ${policyLine}`
      .toLowerCase()
      .includes(q);
  const identity = (
    <SettingsSection
      name="identity"
      title="Identity"
      description="Client-facing name and model ID."
      className="configuration-card-wide"
      collapsible
      defaultOpen={false}
      hidden={identityHidden}
      summary={
        <span className="muted">{String(read('name') || 'Deployment')}</span>
      }
    >
      <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {input('name', 'Display name')}
        {deployment && (
          <Field label="API model ID">
            {deployment.identifier_mode === 'custom' ? (
              <Input
                value={deployment.alias}
                onChange={(e) => set('alias', e.target.value)}
              />
            ) : (
              <code>
                {generatedRename ? aliasSuggestion.alias : deployment.alias}
              </code>
            )}
            <p>
              {deployment.identifier_mode === 'custom'
                ? 'This ID stays the same when you rename the model.'
                : 'Generated from the name and updated when you rename it.'}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                set(
                  'identifier_mode',
                  deployment.identifier_mode === 'custom'
                    ? 'generated'
                    : 'custom',
                )
              }
            >
              {deployment.identifier_mode === 'custom'
                ? 'Generate from name'
                : 'Customize API model ID'}
            </Button>
            {generatedRename && (
              <p>
                API model ID: {originalDeployment?.alias} →{' '}
                {aliasSuggestion.alias}
              </p>
            )}
            {aliasSuggestion.error && generatedRename && (
              <p role="alert">{aliasSuggestion.error}</p>
            )}
          </Field>
        )}
      </FieldGroup>
    </SettingsSection>
  );
  const availability =
    deployment && kind === 'deployments' ? (
      <SettingsSection
        name="lifecycle"
        title="Availability"
        description="Loading and client exposure."
        hidden={availabilityHidden}
        summary={
          memberOnly ? (
            <Badge variant="secondary">Pool policy</Badge>
          ) : undefined
        }
      >
        {memberOnly ? (
          <>
            <p className="text-muted-foreground text-sm">{policyLine}</p>
            <p className="text-muted-foreground text-sm">
              Loading policy, priority, idle unload, eviction and the endpoint
              belong to the deployment set, not to this member. Change them once
              at the top of the pool Configuration.
            </p>
          </>
        ) : (
          <>
            <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Mode">
                <NativeSelect
                  value={deployment.residency}
                  onChange={(e) => set('residency', e.target.value)}
                >
                  <NativeSelectOption value="on-demand">
                    On demand
                  </NativeSelectOption>
                  <NativeSelectOption value="pinned">Pinned</NativeSelectOption>
                  <NativeSelectOption value="evictable">
                    Evictable
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              {input('priority', 'Priority', 'number', 0, 100)}
              {deployment.residency === 'on-demand' && (
                <Duration
                  value={deployment.idle_timeout ?? 0}
                  change={(v) => set('idle_timeout', v)}
                />
              )}
            </FieldGroup>
            {deployment.residency !== 'pinned' &&
              check(
                'allow_eviction',
                'Can unload to make room for another deployment',
              )}
            {check('enabled', 'Enabled for clients')}
            <CardAdvanced
              title="Advanced availability"
              overrides={['queue_timeout', 'port']}
              defaultOpen={Boolean(
                q &&
                ['queue', 'timeout', 'port', 'private'].some((word) =>
                  q.includes(word),
                ),
              )}
            >
              {input(
                'queue_timeout',
                'Queue timeout (seconds)',
                'number',
                1,
                1800,
              )}
              <Field
                label="Private port"
                hint="Loopback port for this deployment's endpoint."
              >
                <NumberControl
                  label="Private port"
                  required
                  min={1024}
                  max={65535}
                  value={
                    typeof deployment.port === 'number'
                      ? deployment.port
                      : undefined
                  }
                  change={(v) => set('port', v ?? 0)}
                />
              </Field>
            </CardAdvanced>
          </>
        )}
      </SettingsSection>
    ) : null;
  const forecast = deployment?.configuration && (
    <DraftResources compact preview={preview.data} error={preview.error} />
  );
  return (
    <DraftFormProvider value={form}>
      {renameConfirmation}
      {namingError && <p role="alert">{namingError}</p>}
      <form
        ref={formElement}
        className={
          deployment ? 'configuration-editor resource-editor' : undefined
        }
        onInvalidCapture={(e) => {
          const target = e.target as HTMLElement;
          if (search) flushSync(() => setSearch(''));
          for (
            let parent = target.parentElement;
            parent;
            parent = parent.parentElement
          )
            if (parent.tagName === 'DETAILS') parent.setAttribute('open', '');
          issueFields.current.add(
            target.getAttribute('name') ||
              target.getAttribute('aria-label') ||
              target.id ||
              'field',
          );
          setIssues(issueFields.current.size);
        }}
        onChangeCapture={() => {
          if (issueFields.current.size) {
            issueFields.current.clear();
            setIssues(0);
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        {navigationGuard}
        {deployment ? (
          <>
            <div className="configuration-toolbar">
              <Field label="Filter configuration">
                <Input
                  aria-label="Filter configuration"
                  value={search}
                  placeholder="Flag, label or description"
                  onChange={(e) => setSearch(e.target.value)}
                />
              </Field>
              {search && (
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setSearch('')}
                >
                  Clear filter
                </Button>
              )}
              {search && (
                <span role="status" className="muted">
                  {hiddenCards} hidden
                </span>
              )}
            </div>
            <FieldSet
              key={epoch}
              className="configuration-grid"
              disabled={busy || props.disabled}
            >
              {identity}
              {kind === 'deployments' && deployment.configuration && (
                <ConfigurationFields
                  value={deployment.configuration}
                  deploymentId={deployment.id}
                  templateOverride={deployment.template_override}
                  runtimeLocked={Boolean(owner?.engine_pool)}
                  observed={
                    data.deployments?.find(
                      (entry) => entry.id === deployment.id,
                    )?.runtime_observation?.resolved
                  }
                  observedAt={
                    data.deployments?.find(
                      (entry) => entry.id === deployment.id,
                    )?.runtime_observation?.observed_at
                  }
                  data={data}
                  set={(configuration) => set('configuration', configuration)}
                  onValid={(valid) =>
                    setInvalid((prev) => ({
                      ...prev,
                      configuration: !valid,
                    }))
                  }
                  recommendation={preview.data?.members?.[0]?.recommendation}
                  search={search}
                  availability={availability}
                  forecast={!wide && forecast}
                  modelFields={
                    <ChatTemplateSettings
                      label="Chat template"
                      model={data.models.find(
                        (m) => m.id === deployment.configuration?.artifact_id,
                      )}
                      override={deployment.template_override || null}
                      onChange={(selection) =>
                        set('template_override', selection)
                      }
                    />
                  }
                  placementFields={
                    owner?.engine_pool ? (
                      <p className="text-muted-foreground text-sm">
                        Process engine and device visibility are controlled by
                        the shared native pool. Edit the pool Configuration to
                        change them for every member.
                      </p>
                    ) : (
                      <Placement
                        part="gpu"
                        value={deployment}
                        change={(placement) =>
                          setValue((previous) =>
                            decode({ ...previous, ...placement }),
                          )
                        }
                        host={data.host?.[0]}
                      />
                    )
                  }
                />
              )}
            </FieldSet>
            {wide && forecast && (
              <aside className="configuration-resources">{forecast}</aside>
            )}
          </>
        ) : (
          <FieldSet key={epoch} disabled={busy || props.disabled}>
            {identity}
            {kind === 'profiles' && profile && (
              <>
                {select('artifact_id', data.models || [], 'Model')}
                {select('runtime_id', data.runtimes || [], 'Engine')}
                <RuntimeSettings
                  engineSelected={Boolean(profile.runtime_id)}
                  schema={
                    data.runtimes?.find((r) => r.id === profile.runtime_id)
                      ?.capabilities?.schema || {}
                  }
                  value={profile.config}
                  change={(config) => set('config', config)}
                  host={data.host?.[0]}
                  formPath="config"
                />
                <details>
                  <summary>Advanced</summary>
                  {json('config', 'Runtime options (JSON)')}
                  {json('raw_args', 'Arguments (JSON array)')}
                  {json('catalog', 'Client capabilities (JSON)')}
                </details>
                <p className="muted">
                  Running deployments keep their saved revision.
                </p>
              </>
            )}
            {kind === 'runtimes' && runtime && (
              <>
                <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                  <Field label="Engine">
                    <NativeSelect
                      value={runtime.engine}
                      onChange={(e) => set('engine', e.target.value)}
                    >
                      {['llama.cpp', 'vllm', 'sglang', 'custom'].map((v) => (
                        <NativeSelectOption key={v}>{v}</NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Execution">
                    <NativeSelect
                      value={runtime.execution_kind}
                      onChange={(e) => set('execution_kind', e.target.value)}
                    >
                      {['native', 'docker', 'podman'].map((v) => (
                        <NativeSelectOption key={v}>{v}</NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                </FieldGroup>
                {input(
                  'executable',
                  runtime.execution_kind === 'native'
                    ? 'Executable path'
                    : 'Image (pinned digest)',
                )}
                <details>
                  <summary>Advanced</summary>
                  {input('commit', 'Source commit')}
                  {input('fork_url', 'Source repository')}
                  {json('env', 'Environment (JSON)')}
                  {runtime.engine === 'custom' &&
                    json('command_template', 'Command template (JSON array)')}
                </details>
                <p className="warning">
                  Registration runs the executable to check its version and
                  supported options.
                </p>
                {check('trust', 'I trust this executable or image')}
              </>
            )}
          </FieldSet>
        )}
        {props.revisionConflict && (
          <Alert variant="default" className="mb-5" role="alert">
            <AlertDescription className="whitespace-pre-line">
              This configuration changed elsewhere. Your edits have been kept.
            </AlertDescription>
            <AlertAction>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={busy || props.disabled}
                onClick={() => void reviewRevision()}
              >
                Review changes
              </Button>
            </AlertAction>
          </Alert>
        )}
        <div className="dialog-actions configuration-save-bar">
          {deployment && (
            <>
              <span className="muted" role="status">
                {issues
                  ? `${issues} issue${issues === 1 ? '' : 's'} · check highlighted fields`
                  : changed
                    ? 'Unsaved changes'
                    : 'All changes saved'}
              </span>
              <Button
                variant="outline"
                type="button"
                disabled={busy || props.disabled || !changed}
                onClick={() => {
                  reset();
                  setInvalid({});
                  setEpoch((e) => e + 1);
                  setSearch('');
                  issueFields.current.clear();
                  setIssues(0);
                }}
              >
                Discard
              </Button>
            </>
          )}
          {remove && (
            <Menu label="More deployment actions">
              <DropdownMenuItem
                variant="destructive"
                disabled={busy}
                onClick={remove}
              >
                Remove
              </DropdownMenuItem>
            </Menu>
          )}
          <Button
            variant="default"
            type="submit"
            disabled={
              busy || props.disabled || Object.values(invalid).some(Boolean)
            }
          >
            {busy ? 'Saving…' : kind === 'profiles' ? 'Save revision' : 'Save'}
          </Button>
        </div>
      </form>
    </DraftFormProvider>
  );
}
