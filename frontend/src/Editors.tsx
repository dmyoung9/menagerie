import { FieldSet, FieldLegend, FieldGroup } from '@/components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useEffect, useState } from 'react';
import { Field, JsonEdit, Menu, type Registry } from './ui';
import { EngineCatalog } from './EngineCatalog';
import { Duration, Placement, RuntimeSettings } from './FormControls';
import { DraftResources } from './Resources';
import { useResourcePreview } from './hooks/use-resource-preview';
import { Capabilities } from './Capabilities';
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

export function ConfigurationFields({
  value,
  data,
  set,
  onValid,
  recommendation,
}: {
  value: ProfileDraft;
  data: Registry;
  set: (value: ProfileDraft) => void;
  onValid: (valid: boolean) => void;
  recommendation?: RuntimeRecommendation;
}) {
  const { confirm, confirmation } = useConfirmation();
  const runtime = data.runtimes?.find((r) => r.id === value.runtime_id);
  const artifact = data.models?.find((m) => m.id === value.artifact_id);
  const schema = { ...runtime?.capabilities?.schema };
  const { context: modelContext, layers } = artifactLimits(artifact);
  for (const key of ['ctx-size', 'max-model-len'])
    if (schema[key] && modelContext)
      schema[key] = {
        ...schema[key],
        max: Math.min(
          schema[key].max ?? modelContext,
          modelContext *
            (key === 'ctx-size' && typeof value.config.parallel === 'number'
              ? value.config.parallel
              : 1),
        ),
      };
  if (schema.parallel)
    schema.parallel = {
      ...schema.parallel,
      max: Math.min(
        schema.parallel.max ?? Number.MAX_SAFE_INTEGER,
        Math.floor(
          (typeof value.config['ctx-size'] === 'number'
            ? value.config['ctx-size']
            : typeof schema['ctx-size']?.default === 'number'
              ? schema['ctx-size'].default
              : 8192) / 32,
        ),
      ),
    };
  if (schema['gpu-layers'] && runtime?.managed?.backend === 'cpu')
    schema['gpu-layers'] = { ...schema['gpu-layers'], cpu_only: true };
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
      <FieldLegend>Model configuration</FieldLegend>
      {confirmation}
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
          {(data.models || []).map((m) => (
            <NativeSelectOption key={m.id} value={m.id}>
              {m.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Engine">
        <NativeSelect
          required
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
            const selected = engines.find((r) => r.id === id);
            const schema: Record<string, import('./types').RuntimeField> =
              selected?.capabilities?.schema || {};
            const config: Record<string, JsonValue> = {};
            for (const [key, field] of Object.entries(schema)) {
              if (field.default !== undefined) config[key] = field.default;
            }
            if (selected?.managed?.backend === 'cpu')
              config['gpu-layers'] = '0';
            const { context } = artifactLimits(artifact);
            if (context)
              for (const key of ['ctx-size', 'max-model-len'])
                if (typeof config[key] === 'number')
                  config[key] = Math.min(config[key], context);
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
      </Field>
      {engineHint.reason && <p className="muted">{engineHint.reason}</p>}
      <Button
        variant="outline"
        type="button"
        onClick={() => setInstalling(!installing)}
      >
        {installing ? 'Hide engine downloads' : 'Install an engine'}
      </Button>
      {installing && (
        <EngineCatalog
          runtimes={data.runtimes || []}
          recommended={engineHint.engine ?? undefined}
        />
      )}
      <RuntimeSettings
        schema={schema}
        value={value.config}
        change={(config) => set({ ...value, config })}
        host={data.host?.[0]}
        recommendation={{ gpu_layers_max: layers, ...recommendation }}
      />
      {artifact?.metadata?.projector &&
        runtime?.capabilities?.schema?.mmproj && (
          <Button
            variant="outline"
            type="button"
            onClick={() =>
              set({
                ...value,
                config: {
                  ...value.config,
                  mmproj: artifact.metadata?.projector?.path || '',
                },
              })
            }
          >
            Use downloaded projector: {artifact.metadata.projector.name}
          </Button>
        )}
      <Capabilities
        key={value.artifact_id + ':' + value.runtime_id}
        catalog={catalog}
        change={(catalog) => set({ ...value, catalog })}
        hints={artifact?.discovered_capabilities}
        runtime={runtime}
        valid={valid}
      />
      <details key={value.runtime_id}>
        <summary>Advanced model settings</summary>
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
};
type EditorField =
  | keyof EditorDraftMap['profiles']
  | keyof EditorDraftMap['deployments']
  | keyof EditorDraftMap['runtimes'];
export function Editor(props: EditorProps) {
  const { initial, data, remove, busy, memberOnly = false } = props;
  const kind = initial.kind;
  const [value, setValue] = useState<EditorDraft>(initial.value),
    [invalid, setInvalid] = useState<Record<string, boolean>>({});
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
        onChange={(e) =>
          set(key, type === 'number' ? Number(e.target.value) : e.target.value)
        }
      />
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
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!Object.values(invalid).some(Boolean)) {
          if (kind === 'profiles')
            props.save({ kind, value: profileDraft(value) });
          else if (kind === 'deployments')
            props.save({ kind, value: deploymentDraft(value) });
          else props.save({ kind, value: runtimeDraft(value) });
        }
      }}
    >
      {input('name', 'Display name')}
      {kind === 'profiles' && profile && (
        <>
          {select('artifact_id', data.models || [], 'Model')}
          {select('runtime_id', data.runtimes || [], 'Engine')}
          <RuntimeSettings
            schema={
              data.runtimes?.find((r) => r.id === profile.runtime_id)
                ?.capabilities?.schema || {}
            }
            value={profile.config}
            change={(config) => set('config', config)}
            host={data.host?.[0]}
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
          {input('alias', 'API model ID')}
          {deployment.configuration && (
            <ChatTemplateSettings
              label="Chat template"
              model={data.models.find(
                (m) => m.id === deployment.configuration?.artifact_id,
              )}
              override={deployment.template_override || null}
              onChange={(selection) => set('template_override', selection)}
            />
          )}
          {deployment.configuration && (
            <ConfigurationFields
              value={deployment.configuration}
              data={data}
              set={(configuration) => set('configuration', configuration)}
              onValid={(valid) =>
                setInvalid((prev) => ({ ...prev, configuration: !valid }))
              }
              recommendation={preview.data?.members?.[0]?.recommendation}
            />
          )}
          {deployment.configuration && (
            <DraftResources preview={preview.data} error={preview.error} />
          )}
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
                  <NativeSelectOption value="pinned">Pinned</NativeSelectOption>
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
          <details>
            <summary>Placement</summary>
            <Placement
              value={{
                gpu: deployment.gpu,
                reservation_mib: deployment.reservation_mib,
                port: deployment.port,
              }}
              change={(placement) =>
                setValue((previous) => decode({ ...previous, ...placement }))
              }
              host={data.host?.[0]}
            />
          </details>
          <details>
            <summary>Scheduling</summary>
            {!memberOnly && (
              <>
                <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                  {input('priority', 'Priority', 'number', 0, 100)}
                  {input(
                    'queue_timeout',
                    'Queue timeout (seconds)',
                    'number',
                    1,
                    1800,
                  )}
                </FieldGroup>
                {deployment.residency !== 'pinned' &&
                  check(
                    'allow_eviction',
                    'Can unload to make room for another deployment',
                  )}
                {check(
                  'allow_uncertain',
                  'Allow on-demand loading with uncertain memory estimates',
                )}
              </>
            )}
          </details>
          {!memberOnly && check('enabled', 'Enabled for clients')}
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
                {['llama.cpp', 'prism', 'vllm', 'sglang', 'custom'].map((v) => (
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
            Registration runs the executable to check its version and supported
            options.
          </p>
          {check('trust', 'I trust this executable or image')}
        </>
      )}
      <div className="dialog-actions">
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
          disabled={busy || Object.values(invalid).some(Boolean)}
        >
          {busy ? 'Saving…' : kind === 'profiles' ? 'Save revision' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
