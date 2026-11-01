import { Alert, AlertDescription } from '@/components/ui/alert';
import { FieldSet, FieldGroup } from '@/components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useEffect, useRef, useState } from 'react';
import { reconcileRuntimeOptions } from './runtime-options';
import { readApi } from './ui';
import { deployment } from './contracts';
import { jsonObject, stringArray } from './contracts';
import { Dialog, Field, JsonEdit, message, type Registry } from './ui';
import { defaults } from './editor-state';
import { Choices, RuntimeSettings } from './FormControls';
import { DraftResources } from './Resources';
import { useResourcePreview } from './hooks/use-resource-preview';
import { Capabilities } from './Capabilities';
import type {
  Deployment,
  DeploymentDraft,
  JsonValue,
  ModelCatalog,
  TemplateSelection,
} from './types';
import { ChatTemplateSettings } from './ChatTemplateSettings';

export function DeploymentWizard({
  data,
  modelId,
  close,
  created,
  setupEngine,
}: {
  data: Registry;
  modelId?: string;
  close: () => void;
  created: (row: Deployment, load: boolean) => void;
  setupEngine: () => void;
}) {
  const [step, setStep] = useState(0),
    [artifactId, setArtifactId] = useState(
      modelId || data.models?.[0]?.id || '',
    );
  const [runtimeId, setRuntimeId] = useState('');
  const [name, setName] = useState(''),
    [alias, setAlias] = useState('');
  const [context, setContext] = useState(8192),
    [parallel, setParallel] = useState(1),
    [custom, setCustom] = useState(false);
  const [residency, setResidency] = useState('on-demand'),
    [idle, setIdle] = useState(300);
  const [catalog, setCatalog] = useState<ModelCatalog>({
    model: {
      capabilities: { tools: false, input: ['text'], output: ['text'] },
      limit: { output: 1024 },
    },
  });
  const [extra, setExtra] = useState<Record<string, JsonValue>>({}),
    [args, setArgs] = useState<string[]>([]),
    [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [templateOverride, setTemplateOverride] =
    useState<TemplateSelection | null>(null);
  const usedPorts = new Set((data.deployments || []).map((d) => d.port));
  const [advanced, setAdvanced] = useState<DeploymentDraft>({
    ...defaults.deployments,
    port:
      Array.from({ length: 50000 }, (_, i) => 8120 + i).find(
        (p) => !usedPorts.has(p),
      ) ?? 0,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const artifact = data.models?.find((m) => m.id === artifactId);
  const engines = (data.runtimes || []).filter(
    (r) =>
      artifact !== undefined &&
      r.capabilities?.formats?.includes(artifact.format),
  );
  const runtime = engines.find((r) => r.id === runtimeId) || engines[0];
  const schema = runtime?.capabilities?.schema || {};
  const schemaKeys = JSON.stringify(Object.keys(schema).sort());
  const previousRuntime = useRef<{ id?: string; keys: string[] } | undefined>(
    undefined,
  );
  // Depend on supported defaults, not polling-created schema object identities.
  const extraDefaults = JSON.stringify(
    Object.fromEntries(
      Object.entries(defaults.profiles.config || {}).filter(
        ([key]) => schema[key] && !['ctx-size', 'parallel'].includes(key),
      ),
    ),
  );
  useEffect(() => {
    const previous = previousRuntime.current;
    const keys = stringArray(JSON.parse(schemaKeys) as unknown);
    const nextDefaults = jsonObject(JSON.parse(extraDefaults) as unknown);
    previousRuntime.current = { id: runtime?.id, keys };
    setExtra((current) =>
      !previous || previous.id !== runtime?.id
        ? nextDefaults
        : reconcileRuntimeOptions(current, nextDefaults, previous.keys, keys),
    );
  }, [runtime?.id, extraDefaults, schemaKeys]);
  const contextKey = runtime?.engine === 'vllm' ? 'max-model-len' : 'ctx-size';
  const hasContext = Boolean(schema[contextKey]),
    hasParallel = Boolean(schema.parallel);
  const displayName = name || artifact?.name || 'New deployment';
  const apiAlias =
    alias ||
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 140) ||
    'model';
  const draftConfig = {
    ...extra,
    ...(hasContext
      ? { [contextKey]: context * (hasParallel ? parallel : 1) }
      : {}),
    ...(hasParallel ? { parallel } : {}),
  };
  const preview = useResourcePreview(
    runtime
      ? [
          {
            ...advanced,
            name: displayName,
            configuration: {
              name: displayName,
              artifact_id: artifactId,
              runtime_id: runtime.id,
              config: draftConfig,
              raw_args: args,
              catalog: {},
            },
          },
        ]
      : [],
    data.host?.[0]?.ts,
  );
  const recommendation = preview.data?.members?.[0]?.recommendation;
  const recommendedContext = recommendation?.context_default;
  const suggestedContext =
    recommendation?.context_recommended_max == null
      ? undefined
      : Math.floor(
          recommendation.context_recommended_max / (hasParallel ? parallel : 1),
        );
  async function submit(load: boolean) {
    setBusy(true);
    setError('');
    try {
      const config: Record<string, JsonValue> = { ...extra };
      if (hasContext)
        config[contextKey] = context * (hasParallel ? parallel : 1);
      if (hasParallel) config.parallel = parallel;
      const configuration = {
        name: displayName,
        artifact_id: artifactId,
        runtime_id: runtime.id,
        config,
        raw_args: args,
        catalog,
      };
      const saved = await readApi('/api/deployments', deployment, {
        ...advanced,
        name: displayName,
        configuration,
        alias: apiAlias,
        residency,
        idle_timeout: idle,
        template_override: templateOverride,
        enabled: true,
      });
      created(saved, load);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const advance = () => {
    if (
      step === 1 &&
      hasContext &&
      (context * (hasParallel ? parallel : 1) >
        (schema[contextKey].max || 1048576) ||
        context < (schema[contextKey].min || 512))
    ) {
      setError(
        'Context and concurrency exceed this engine’s supported context pool.',
      );
      return;
    }
    setError('');
    setStep((s) => s + 1);
  };
  return (
    <Dialog
      title={['New deployment', 'Configuration', 'Review deployment'][step]}
      close={close}
      busy={busy}
      wide
    >
      <ol className="steps" aria-label="Deployment setup">
        {['Model & engine', 'Configuration', 'Review'].map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? 'step' : undefined}
            className={i <= step ? 'current' : ''}
          >
            <span>{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      {error && (
        <Alert variant="destructive" className="mb-5" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
            {error}
          </AlertDescription>
        </Alert>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (step < 2) advance();
        }}
      >
        <FieldSet disabled={busy}>
          {step === 0 && (
            <>
              <>
                <Field label="Model">
                  <NativeSelect
                    required
                    value={artifactId}
                    onChange={(e) => {
                      setArtifactId(e.target.value);
                      setRuntimeId('');
                      setExtra({});
                      setTemplateOverride(null);
                    }}
                  >
                    <NativeSelectOption value="" disabled>
                      Select model…
                    </NativeSelectOption>
                    {(data.models || []).map((m) => (
                      <NativeSelectOption key={m.id} value={m.id}>
                        {m.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                {engines.length ? (
                  <Field label="Engine">
                    <NativeSelect
                      value={runtime?.id}
                      onChange={(e) => {
                        setRuntimeId(e.target.value);
                        setExtra({});
                      }}
                    >
                      {engines.map((r) => (
                        <NativeSelectOption key={r.id} value={r.id}>
                          {r.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                ) : (
                  <div className="empty">
                    <h3>No compatible engine</h3>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={setupEngine}
                    >
                      Set up engine
                    </Button>
                  </div>
                )}
                {artifact && (
                  <ChatTemplateSettings
                    label="Chat template"
                    model={artifact}
                    override={templateOverride}
                    onChange={setTemplateOverride}
                  />
                )}
              </>
            </>
          )}
          {step === 1 && (
            <>
              <Field label="Name">
                <Input
                  required
                  value={displayName}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="API model">
                <Input
                  required
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_.\/\-]{0,159}"
                  value={apiAlias}
                  onChange={(e) => setAlias(e.target.value)}
                />
              </Field>
              <>
                {hasContext && (
                  <Field
                    label="Context / request"
                    hint={
                      suggestedContext
                        ? `Suggested ceiling: ${suggestedContext.toLocaleString()} tokens per request (estimated)`
                        : 'Capacity recommendation unavailable or minimum context does not fit'
                    }
                  >
                    <Choices
                      label="Context size"
                      value={custom ? 'custom' : String(context)}
                      options={[
                        ...[8192, 16384, 32768].map((n) => ({
                          value: String(n),
                          label: `${n / 1024}K${suggestedContext && n > suggestedContext ? ' ⚠' : ''}`,
                          disabled:
                            n * (hasParallel ? parallel : 1) >
                            (schema[contextKey].max || 1048576),
                        })),
                        { value: 'custom', label: 'Custom' },
                      ]}
                      change={(next) => {
                        setCustom(next === 'custom');
                        if (next !== 'custom') setContext(Number(next));
                      }}
                    />
                    {typeof recommendedContext === 'number' && (
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => {
                          setContext(
                            Math.max(
                              schema[contextKey].min || 512,
                              Math.floor(
                                recommendedContext /
                                  (hasParallel ? parallel : 1),
                              ),
                            ),
                          );
                          setCustom(true);
                        }}
                      >
                        Use suggested default
                      </Button>
                    )}
                    {custom && (
                      <Input
                        aria-label="Custom context / request"
                        type="number"
                        required
                        min={schema[contextKey].min || 512}
                        max={
                          (schema[contextKey].max || 1048576) /
                          (hasParallel ? parallel : 1)
                        }
                        value={context}
                        onChange={(e) => setContext(Number(e.target.value))}
                      />
                    )}
                  </Field>
                )}
                {hasParallel && (
                  <Field
                    label="Concurrent requests"
                    hint={`Shared context pool: ${(context * parallel).toLocaleString()} tokens`}
                  >
                    <Input
                      type="number"
                      min={1}
                      max={schema.parallel.max || 64}
                      required
                      value={parallel}
                      onChange={(e) => setParallel(Number(e.target.value))}
                    />
                  </Field>
                )}
                {!hasContext && (
                  <p className="muted">
                    This engine requires manual context configuration in
                    Advanced.
                  </p>
                )}
              </>
              <Field label="Mode">
                <NativeSelect
                  value={residency}
                  onChange={(e) => setResidency(e.target.value)}
                >
                  <NativeSelectOption value="on-demand">
                    On demand
                  </NativeSelectOption>
                  <NativeSelectOption value="pinned">Pinned</NativeSelectOption>
                  <NativeSelectOption value="evictable">
                    Evictable
                  </NativeSelectOption>
                </NativeSelect>
                <small>
                  {residency === 'on-demand'
                    ? 'Loads when a client sends a request.'
                    : residency === 'pinned'
                      ? 'Never automatically unloaded to make room.'
                      : 'Loads manually; can make room when idle and authorized.'}
                </small>
              </Field>
              {residency === 'on-demand' && (
                <Field label="Unload after idle">
                  <NativeSelect
                    value={idle}
                    onChange={(e) => setIdle(Number(e.target.value))}
                  >
                    {[60, 300, 900, 1800, 0].map((s) => (
                      <NativeSelectOption key={s} value={s}>
                        {s ? s / 60 + ' minutes' : 'Never'}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              )}
              <Capabilities
                key={artifactId + ':' + runtime?.id}
                catalog={catalog}
                change={setCatalog}
                hints={artifact?.discovered_capabilities}
                runtime={runtime}
                valid={(key, ok) => setInvalid((v) => ({ ...v, [key]: !ok }))}
              />
              {artifact?.metadata?.projector && schema.mmproj && (
                <Button
                  variant="outline"
                  type="button"
                  onClick={() =>
                    setExtra({
                      ...extra,
                      mmproj: artifact.metadata?.projector?.path || '',
                    })
                  }
                >
                  Use downloaded projector: {artifact.metadata?.projector?.name}
                </Button>
              )}
              <details>
                <summary>Advanced</summary>
                <>
                  <RuntimeSettings
                    schema={Object.fromEntries(
                      Object.entries(schema).filter(
                        ([key]) =>
                          !['ctx-size', 'max-model-len', 'parallel'].includes(
                            key,
                          ),
                      ),
                    )}
                    value={extra}
                    change={setExtra}
                    host={data.host?.[0]}
                    recommendation={recommendation}
                  />
                  {!hasContext && (
                    <JsonEdit
                      label="Runtime options (JSON)"
                      decode={jsonObject}
                      value={extra}
                      onChange={setExtra}
                      onValid={(valid) =>
                        setInvalid((v) => ({ ...v, config: !valid }))
                      }
                    />
                  )}
                  <JsonEdit
                    label="Additional engine arguments"
                    decode={stringArray}
                    value={args}
                    onChange={setArgs}
                    onValid={(valid) =>
                      setInvalid((v) => ({ ...v, args: !valid }))
                    }
                  />
                </>
                <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                  {(
                    [
                      ['port', 'Private port', 1024, 65535],
                      ['gpu', 'GPU index', 0, 31],
                      [
                        'reservation_mib',
                        'VRAM reservation (MiB; 0 = estimate)',
                        0,
                        undefined,
                      ],
                      ['priority', 'Priority', 0, 100],
                      ['queue_timeout', 'Queue timeout (seconds)', 1, 1800],
                    ] as const
                  ).map(([key, label, min, max]) => (
                    <Field key={String(key)} label={String(label)}>
                      <Input
                        required
                        type="number"
                        min={min}
                        max={max}
                        value={advanced[key]}
                        onChange={(e) =>
                          setAdvanced({
                            ...advanced,
                            [key]: Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                  ))}
                </FieldGroup>
                {residency !== 'pinned' && (
                  <label className="check">
                    <Checkbox
                      checked={advanced.allow_eviction}
                      onCheckedChange={(checked) =>
                        setAdvanced({ ...advanced, allow_eviction: checked })
                      }
                    />
                    Allow automatic unloading when idle
                  </label>
                )}
              </details>
            </>
          )}
          {step === 2 && (
            <>
              <h3>{displayName}</h3>
              <dl className="properties">
                <dt>API model</dt>
                <dd>
                  <code>{apiAlias}</code>
                </dd>
                <dt>Engine</dt>
                <dd>{runtime?.name}</dd>
                {hasContext && (
                  <>
                    <dt>Context / request</dt>
                    <dd>{context.toLocaleString()}</dd>
                  </>
                )}
                <dt>Mode</dt>
                <dd>
                  {residency === 'on-demand'
                    ? 'On demand'
                    : residency === 'pinned'
                      ? 'Pinned'
                      : 'Evictable'}
                </dd>
                {residency === 'on-demand' && (
                  <>
                    <dt>Unload after idle</dt>
                    <dd>{idle ? idle / 60 + ' minutes' : 'Never'}</dd>
                  </>
                )}
              </dl>
              <p className="muted">
                Loading requires a capacity review. Creating without loading
                leaves this enabled for clients
                {residency === 'on-demand'
                  ? '; the first request can trigger loading'
                  : ''}
                .
              </p>
              {residency === 'on-demand' && (
                <>
                  <label className="check">
                    <Checkbox
                      checked={advanced.allow_uncertain}
                      onCheckedChange={(checked) =>
                        setAdvanced({ ...advanced, allow_uncertain: checked })
                      }
                    />
                    Allow on-demand loading with uncertain memory estimates
                  </label>
                  {!advanced.allow_uncertain && (
                    <p className="warning">
                      Client-triggered loading may be blocked until this
                      permission is granted.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </FieldSet>
        {step > 0 && (
          <DraftResources preview={preview.data} error={preview.error} />
        )}
        <div className="dialog-actions">
          {step > 0 && (
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => setStep((s) => s - 1)}
            >
              Back
            </Button>
          )}
          {step < 2 ? (
            <Button
              variant="default"
              type="submit"
              disabled={Object.values(invalid).some(Boolean) || !runtime}
            >
              Next
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => void submit(false)}
              >
                Create without loading
              </Button>
              <Button
                variant="default"
                type="button"
                disabled={busy}
                onClick={() => void submit(true)}
              >
                {busy ? 'Creating…' : 'Create & review launch'}
              </Button>
            </>
          )}
        </div>
      </form>
    </Dialog>
  );
}
