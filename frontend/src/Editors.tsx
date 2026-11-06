import { FieldSet, FieldLegend, FieldGroup } from '@/components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useEffect, useState, type ReactNode } from 'react';
import { SettingsSection } from '@/components/settings-section';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { Field, JsonEdit, Menu, type Registry } from './ui';
import { EngineCatalog } from './EngineCatalog';
import { Duration, Placement, RuntimeSettings } from './FormControls';
import { DraftResources } from './Resources';
import { useResourcePreview } from './hooks/use-resource-preview';
import { Capabilities, OutputLimit } from './Capabilities';
import { Variants } from './ReasoningVariants';
import { useConfirmation } from '@/hooks/use-confirmation';
import { readApi } from './ui';
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
import { artifactLimits } from './artifact-metadata';
import type {
  Artifact,
  EditorDraft,
  EditorDraftMap,
  EditorState,
  EngineRecommendation,
  JsonValue,
  ProfileDraft,
  Runtime,
  RuntimeRecommendation,
} from './types';
import { ChatTemplateSettings } from './ChatTemplateSettings';
import { ModelCompanions } from './ModelCompanions';
import { NumberControl } from './NumberControl';
import type { RuntimeCapabilities } from './types';
import { DraftFormProvider, useDraftForm } from './use-draft-form';
import type { ConfigPath } from './draft-form';
import {
  CapabilityIntelligence,
  SamplingRecommendations,
} from './CapabilityIntelligence';
import { capabilityPreview } from './contracts';
import type { CapabilityPreview, TemplateSelection } from './types';

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
  advancedOnly = false,
  observed,
  deploymentId,
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
  advancedOnly?: boolean;
  observed?: Record<string, number>;
  deploymentId?: string;
}) {
  const { confirm, confirmation } = useConfirmation();
  const runtime = data.runtimes?.find((r) => r.id === value.runtime_id);
  const artifact = data.models?.find((m) => m.id === value.artifact_id);
  const [probed, setProbed] = useState<{
    key: string;
    capabilities: RuntimeCapabilities;
  }>();
  const [search, setSearch] = useState('');
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
  return (
    <FieldSet className="configuration-fields">
      <FieldLegend className="sr-only">Model configuration</FieldLegend>
      {confirmation}
      {!advancedOnly && (
        <SettingsSection name="model" title="Model & runtime">
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
                    {engineHint.engine === r.engine ? ' · Recommended' : ''}
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
              recommended={engineHint.engine ?? undefined}
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
          <CapabilityIntelligence preview={capabilityData} />
        </SettingsSection>
      )}
      {!advancedOnly &&
        (['memory', 'generation'] as const).map((section) => (
          <RuntimeSettings
            key={section}
            schema={schema}
            value={value.config}
            change={(config) => set({ ...value, config })}
            host={data.host?.[0]}
            recommendation={{ gpu_layers_max: layers, ...recommendation }}
            {...(section === 'memory'
              ? {
                  before: (
                    <>
                      {placementFields}
                      {observed && (
                        <details>
                          <summary>Last observed runtime settings</summary>
                          <p className="text-muted-foreground text-sm">
                            Reported by the last loaded session, not requested
                            values. Draft changes do not update these facts.
                          </p>
                          <dl>
                            {Object.entries(observed).map(([key, value]) => (
                              <div key={key}>
                                <dt>{key} · observed</dt>
                                <dd>{value.toLocaleString()}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      )}
                    </>
                  ),
                }
              : {})}
            {...(section === 'generation'
              ? {
                  before: (
                    <>
                      <OutputLimit
                        catalog={catalog}
                        change={(catalog) => set({ ...value, catalog })}
                      />
                      <Field
                        label="Sampling preset"
                        hint="An explicit choice changes deployment defaults. Clients may override request sampling."
                      >
                        <NativeSelect
                          value={
                            [
                              'temp',
                              'top-p',
                              'top-k',
                              'min-p',
                              'repeat-penalty',
                              'presence-penalty',
                            ].some((key) => value.config[key] !== undefined)
                              ? 'custom'
                              : 'engine'
                          }
                          onChange={(e) => {
                            const config = { ...value.config };
                            if (e.target.value === 'engine') {
                              for (const key of [
                                'temp',
                                'top-p',
                                'top-k',
                                'min-p',
                                'repeat-penalty',
                                'presence-penalty',
                              ])
                                delete config[key];
                            } else if (
                              e.target.value === 'greedy' &&
                              schema.temp
                            )
                              config.temp = 0;
                            set({ ...value, config });
                          }}
                        >
                          <NativeSelectOption value="engine">
                            Unspecified · engine defaults
                          </NativeSelectOption>
                          <NativeSelectOption value="custom" disabled>
                            Custom overrides
                          </NativeSelectOption>
                          {schema.temp && (
                            <NativeSelectOption value="greedy">
                              Greedy · temperature 0
                            </NativeSelectOption>
                          )}
                        </NativeSelect>
                      </Field>
                    </>
                  ),
                  after: (
                    <>
                      <SamplingRecommendations
                        preview={capabilityData}
                        apply={(values) =>
                          set({
                            ...value,
                            config: { ...value.config, ...values },
                          })
                        }
                      />
                      <Variants
                        catalog={catalog}
                        change={(catalog) => set({ ...value, catalog })}
                      />
                    </>
                  ),
                }
              : {})}
            section={section}
            engineSelected={Boolean(runtime)}
            formPath={formPath}
            curated
            runtimeMode={runtimeLocked ? 'native-pool' : 'standalone'}
          />
        ))}
      <details
        key={value.runtime_id}
        open={
          advancedOnly ||
          [
            'flash-attn',
            'threads',
            'threads-batch',
            'batch-size',
            'ubatch-size',
          ].some((key) => value.config[key] !== undefined) ||
          undefined
        }
      >
        <summary>Advanced model settings</summary>
        <p className="text-muted-foreground text-sm">
          Explicit engine overrides require reload. Omitted values remain
          engine-controlled. JSON and raw arguments preserve engine-specific
          options.
        </p>
        <Field label="Search advanced settings">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Flag, description or category"
          />
        </Field>
        {(advancedOnly
          ? ([
              'memory',
              'performance',
              'generation',
              'mtp',
              'multimodal',
              'other',
            ] as const)
          : (['performance', 'other'] as const)
        ).map((section) => (
          <RuntimeSettings
            key={section}
            section={section}
            runtimeMode={runtimeLocked ? 'native-pool' : 'standalone'}
            schema={Object.fromEntries(
              Object.entries(schema).filter(([key, field]) =>
                `${key} ${field.label || ''} ${field.description || ''} ${field.presentation?.category || ''}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              ),
            )}
            value={value.config}
            change={(config) => set({ ...value, config })}
            host={data.host?.[0]}
            formPath={formPath}
            engineSelected={Boolean(runtime)}
          />
        ))}
        <SettingsSection
          name="capabilities"
          title="Client capability declarations"
        >
          <p className="text-muted-foreground text-sm">
            Manual declarations change what clients see, not what the model or
            runtime can do. They remain available when detection is unknown.
          </p>
          <Capabilities
            key={value.artifact_id + ':' + value.runtime_id}
            catalog={catalog}
            change={(catalog) => set({ ...value, catalog })}
            valid={valid}
            showOutputLimit={false}
          />
        </SettingsSection>
        <JsonEdit
          label="Runtime options (JSON)"
          decode={jsonObject}
          value={value.config}
          onChange={(config) => set({ ...value, config })}
          onValid={(ok) => valid('config', ok)}
        />
        <JsonEdit
          label="Engine arguments"
          decode={stringArray}
          value={value.raw_args}
          onChange={(raw_args) => set({ ...value, raw_args })}
          onValid={(ok) => valid('args', ok)}
        />
        <JsonEdit
          label="Client capabilities (JSON)"
          decode={modelCatalog}
          value={catalog}
          onChange={(catalog) => set({ ...value, catalog })}
          onValid={(ok) => valid('catalog', ok)}
        />
      </details>
    </FieldSet>
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
  advancedOnly?: boolean;
};
type EditorField =
  | keyof EditorDraftMap['profiles']
  | keyof EditorDraftMap['deployments']
  | keyof EditorDraftMap['runtimes'];
export function Editor(props: EditorProps) {
  const { initial, data, remove, busy } = props;
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
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const {
    form,
    value,
    setValue,
    changed: draftChanged,
    reset,
  } = useDraftForm<EditorDraft>(initial.value, (value) => {
    if (Object.values(invalid).some(Boolean) || busy || props.disabled) return;
    if (kind === 'profiles') props.save({ kind, value: profileDraft(value) });
    else if (kind === 'deployments')
      props.save({ kind, value: deploymentDraft(value) });
    else props.save({ kind, value: runtimeDraft(value) });
  });
  const [epoch, setEpoch] = useState(0);
  const changed = draftChanged || Object.values(invalid).some(Boolean);
  const navigationGuard = useUnsavedChanges(
    !!props.embedded && changed,
    !!props.embedded && busy,
  );
  const profile = 'artifact_id' in value ? value : undefined;
  const deployment = 'alias' in value ? value : undefined;
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
  return (
    <DraftFormProvider value={form}>
      <form
        className={
          deployment ? 'configuration-editor resource-editor' : undefined
        }
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        {navigationGuard}
        {deployment && (
          <nav
            aria-label="Configuration sections"
            className="configuration-jumps"
          >
            {(['model', 'memory', 'generation', 'lifecycle'] as const).map(
              (name) => (
                <Button
                  key={name}
                  variant="ghost"
                  type="button"
                  onClick={(e) => {
                    const target = e.currentTarget
                      .closest('form')
                      ?.querySelector<HTMLElement>(
                        `[data-settings-section="${name}"]`,
                      );
                    target?.scrollIntoView({ block: 'start' });
                    target?.focus({ preventScroll: true });
                  }}
                >
                  {
                    {
                      identity: 'Identity',
                      model: 'Model & runtime',
                      memory: 'Resources & context',
                      performance: 'Performance',
                      generation: 'Generation',
                      capabilities: 'Modalities & capabilities',
                      variants: 'Variants',
                      lifecycle: 'Availability',
                      network: 'Networking',
                    }[name]
                  }
                </Button>
              ),
            )}
          </nav>
        )}
        <FieldSet key={epoch} disabled={busy || props.disabled}>
          <details open={props.advancedOnly || undefined}>
            <summary>Identity · {String(read('name') || 'Deployment')}</summary>
            <SettingsSection name="identity" title="Identity">
              <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {input('name', 'Display name')}
                {deployment && input('alias', 'API model ID')}
              </FieldGroup>
            </SettingsSection>
          </details>
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
          {kind === 'deployments' && deployment && (
            <>
              {deployment.configuration && (
                <ConfigurationFields
                  value={deployment.configuration}
                  deploymentId={deployment.id}
                  templateOverride={deployment.template_override}
                  advancedOnly={props.advancedOnly}
                  runtimeLocked={Boolean(owner?.engine_pool)}
                  observed={
                    data.deployments?.find(
                      (entry) => entry.id === deployment.id,
                    )?.runtime_observation?.resolved
                  }
                  data={data}
                  set={(configuration) => set('configuration', configuration)}
                  onValid={(valid) =>
                    setInvalid((prev) => ({ ...prev, configuration: !valid }))
                  }
                  recommendation={preview.data?.members?.[0]?.recommendation}
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
              <SettingsSection name="lifecycle" title="Availability">
                {!memberOnly && (
                  <>
                    <Field label="Mode">
                      <NativeSelect
                        value={deployment.residency}
                        onChange={(e) => set('residency', e.target.value)}
                      >
                        <NativeSelectOption value="on-demand">
                          On demand
                        </NativeSelectOption>
                        <NativeSelectOption value="pinned">
                          Pinned
                        </NativeSelectOption>
                        <NativeSelectOption value="evictable">
                          Evictable
                        </NativeSelectOption>
                      </NativeSelect>
                    </Field>
                    {deployment.residency === 'on-demand' && (
                      <Duration
                        value={deployment.idle_timeout}
                        change={(v) => set('idle_timeout', v)}
                      />
                    )}
                  </>
                )}
                <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {!memberOnly && (
                    <>
                      {input('priority', 'Priority', 'number', 0, 100)}
                      <details>
                        <summary>Advanced availability</summary>
                        {input(
                          'queue_timeout',
                          'Queue timeout (seconds)',
                          'number',
                          1,
                          1800,
                        )}
                      </details>
                    </>
                  )}
                </FieldGroup>
                {!memberOnly &&
                  deployment.residency !== 'pinned' &&
                  check(
                    'allow_eviction',
                    'Can unload to make room for another deployment',
                  )}
                {!memberOnly && check('enabled', 'Enabled for clients')}
              </SettingsSection>
              <details>
                <summary>Private networking</summary>
                <SettingsSection name="network" title="Networking">
                  <Placement
                    part="network"
                    value={{
                      gpu: deployment.gpu,
                      port: deployment.port,
                    }}
                    change={(placement) =>
                      setValue((previous) =>
                        decode({ ...previous, ...placement }),
                      )
                    }
                    host={data.host?.[0]}
                  />
                </SettingsSection>
              </details>
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
        {deployment?.configuration && (
          <aside className="configuration-resources">
            <DraftResources
              compact
              preview={preview.data}
              error={preview.error}
            />
          </aside>
        )}
        <div className="dialog-actions configuration-save-bar">
          {deployment && (
            <>
              <span className="muted" role="status">
                {changed ? 'Unsaved changes' : 'All changes saved'}
              </span>
              <Button
                variant="outline"
                type="button"
                disabled={busy || props.disabled || !changed}
                onClick={() => {
                  reset();
                  setInvalid({});
                  setEpoch((e) => e + 1);
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
