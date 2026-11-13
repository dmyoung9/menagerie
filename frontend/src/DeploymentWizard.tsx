import { Alert, AlertDescription } from '@/components/ui/alert';
import { PendingChanges } from '@/components/pending-changes';
import { ModelCompanions } from './ModelCompanions';
import { defineStepper } from '@stepperize/react/headless';
import { FieldSet } from '@/components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/workspace';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from 'react';
import { reconcileRuntimeOptions } from './runtime-options';
import { api, readApi, message } from './ui';
import { deployment, job, launchPlan } from './contracts';
import { array } from './decode';
import { jsonObject, stringArray } from './contracts';
import { Dialog, Field, JsonEdit, type Registry } from './ui';
import { defaults } from './editor-state';
import { Choices, RuntimeSettings } from './FormControls';
import { DraftResources } from './Resources';
import { useResourcePreview } from './hooks/use-resource-preview';
import { streamCompletion } from './completionStream';
import { Capabilities } from './Capabilities';
import { Variants } from './ReasoningVariants';
import { defaultReasoningOptions } from './capabilityOptions';
import { SettingsSection } from '@/components/settings-section';
import type {
  Deployment,
  DeploymentDraft,
  JsonValue,
  LaunchPlan,
  ModelCatalog,
  ProfileDraft,
  TemplateSelection,
} from './types';
import { ChatTemplateSettings } from './ChatTemplateSettings';
import { DraftFormProvider, useDraftForm } from './use-draft-form';
import { useSuggestedAlias } from './hooks/use-suggested-alias';
import { localAliasFallback, type IdentifierMode } from './alias-suggestion';

type ContextMode = 'default' | 'automatic' | 'custom';
const setupSteps = [
  { id: 'choose', title: 'Choose model' },
  { id: 'review', title: 'Review setup' },
  { id: 'available', title: 'Make available' },
] as const;
const setupFlow = defineStepper(setupSteps);

type Outcome =
  'launch' | 'loaded' | 'available' | 'disabled' | 'pending' | 'failed';

type PendingOp = {
  state: string;
  token: string | undefined;
  scope_fingerprint: string | undefined;
  drain_deadline: number | null | undefined;
  created_at: number;
  ended_at: number | null | undefined;
  error: string | null | undefined;
  rolled_back: string | null | undefined;
  needs_revalidation: boolean | undefined;
};

interface PendingStatus {
  unit_id: string;
  unit_name: string | null | undefined;
  multi_model: boolean;
  op: PendingOp | null;
  desired_rev: string;
  applied_rev: string | null;
  pending: boolean;
  scope_fingerprint: string;
  affected_ids: string[];
  affected: string[];
}

export function DeploymentWizard({
  data,
  modelId,
  close,
  created,
  setupEngine,
  acquireModel,
  suspended = false,
  onConnect,
}: {
  data: Registry;
  modelId?: string;
  close: () => void;
  created: (row: Deployment) => void;
  setupEngine: () => void;
  acquireModel: (local: boolean) => void;
  suspended?: boolean;
  onConnect: () => void;
}) {
  const stepper = setupFlow.useStepper();
  const step = setupSteps.findIndex((entry) => entry.id === stepper.current.id);
  const setStep = (update: SetStateAction<number>) => {
    const index = typeof update === 'function' ? update(step) : update;
    if (setupSteps[index]) void stepper.goTo(setupSteps[index].id);
  };
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!suspended) heading.current?.focus();
  }, [step, suspended]);
  const [outcome, setOutcome] = useState<Outcome | null>(null),
    [savedRow, setSavedRow] = useState<Deployment | null>(null),
    [launchPlanState, setLaunchPlan] = useState<LaunchPlan | null>(null),
    [launchError, setLaunchError] = useState(''),
    [accepted, setAccepted] = useState(false),
    [launchBusy, setLaunchBusy] = useState(false),
    [pending, setPending] = useState<PendingStatus | null>(null),
    [pendingError, setPendingError] = useState(''),
    [testOutput, setTestOutput] = useState(''),
    [testError, setTestError] = useState(''),
    [testBusy, setTestBusy] = useState(false),
    [testReceived, setTestReceived] = useState(false);
  const [artifactId, setArtifactId] = useState(
    modelId || data.models?.[0]?.id || '',
  );
  const [runtimeId, setRuntimeId] = useState('');
  const [name, setName] = useState<string | null>(null),
    [alias, setAlias] = useState(''),
    [identifierMode, setIdentifierMode] = useState<IdentifierMode>('generated');
  const [context, setContext] = useState(8192),
    [parallel, setParallel] = useState(1);
  const [contextMode, setContextMode] = useState<ContextMode>('default');
  const [residency, setResidency] = useState('on-demand'),
    [idle, setIdle] = useState(300);
  const [catalog, setCatalog] = useState<ModelCatalog>({
    model: {
      capabilities: {
        tools: false,
        reasoning: false,
        input: ['text'],
        output: ['text'],
      },
      limit: { output: 1024 },
    },
    reasoning: { presets: defaultReasoningOptions() },
  });
  const {
    form,
    value: extraDraft,
    setValue: setExtraDraft,
  } = useDraftForm<ProfileDraft>(
    { ...defaults.profiles, config: {} },
    (draft) => {
      setExtraDraft(draft);
      if (step < 2) advance();
    },
  );
  const extra = extraDraft.config;
  const setExtra = useCallback(
    (update: SetStateAction<Record<string, JsonValue>>) =>
      setExtraDraft((draft) => ({
        ...draft,
        config: typeof update === 'function' ? update(draft.config) : update,
      })),
    [setExtraDraft],
  );
  const [args, setArgs] = useState<string[]>([]),
    [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [templateOverride, setTemplateOverride] =
    useState<TemplateSelection | null>(null);
  const usedPorts = new Set((data.deployments || []).map((d) => d.port));
  const [advanced, setAdvanced] = useState<DeploymentDraft>({
    ...defaults.deployments,
    allow_eviction: true,
    runtime_assignment: 'automatic',
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
    setExtraDraft((draft) => ({
      ...draft,
      runtime_id: runtime?.id || '',
      artifact_id: artifactId,
      config:
        !previous || previous.id !== runtime?.id
          ? nextDefaults
          : reconcileRuntimeOptions(
              draft.config,
              nextDefaults,
              previous.keys,
              keys,
            ),
    }));
  }, [runtime?.id, artifactId, extraDefaults, schemaKeys, setExtraDraft]);
  const contextKey = runtime?.engine === 'vllm' ? 'max-model-len' : 'ctx-size';
  const hasContext = Boolean(schema[contextKey]),
    hasParallel = Boolean(schema.parallel);
  const metadataName = artifact?.metadata?.['general.name'];
  const baseName =
    typeof metadataName === 'string' && metadataName.trim()
      ? metadataName
      : artifact?.name || 'New model';
  let suggestedName = baseName;
  for (
    let suffix = 2;
    data.deployments?.some(
      (row) => row.id !== savedRow?.id && row.name === suggestedName,
    );
    suffix++
  )
    suggestedName = `${baseName} (${suffix})`;
  const displayName = name ?? suggestedName;
  const suggested = useSuggestedAlias(
    displayName,
    identifierMode === 'generated',
    savedRow?.id,
  );
  const apiAlias =
    identifierMode === 'custom'
      ? alias || localAliasFallback(displayName)
      : suggested.alias || localAliasFallback(displayName);
  const generatedHint =
    suggested.base && suggested.alias !== suggested.base
      ? `Using ${suggested.alias} because ${suggested.base} is already in use.`
      : suggested.busy
        ? 'Generating ID from the name…'
        : 'Generated from the name and updated when you rename it.';
  const aliasInUse =
    identifierMode === 'custom' &&
    (data.deployments || []).some(
      (d) => d.alias === alias && d.id !== (savedRow?.id ?? ''),
    );
  const buildConfig = (): Record<string, JsonValue> => {
    const config: Record<string, JsonValue> = { ...extra };
    if (contextMode === 'custom') {
      if (hasContext)
        config[contextKey] = context * (hasParallel ? parallel : 1);
      if (hasParallel) config.parallel = parallel;
    } else if (contextMode === 'automatic' && runtime?.engine === 'llama.cpp') {
      // Explicit engine sentinels: automatic context and parallel selection.
      if (hasContext) config[contextKey] = 0;
      if (hasParallel) config.parallel = -1;
    } else {
      // Engine default: no override saved; the engine chooses per load.
      if (hasContext) delete config[contextKey];
      if (hasParallel) delete config.parallel;
    }
    return config;
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
              config: buildConfig(),
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

  async function save(mode: 'load' | 'none' | 'disabled') {
    if (!displayName.trim()) {
      setError('Enter a name for this model.');
      return;
    }
    setBusy(true);
    setError('');
    setOutcome(null);
    setLaunchPlan(null);
    setLaunchError('');
    setAccepted(false);
    try {
      const configuration = {
        name: displayName,
        artifact_id: artifactId,
        runtime_id: runtime.id,
        config: buildConfig(),
        raw_args: args,
        catalog,
      };
      const saved = await readApi(
        '/api/model-setups' +
          (savedRow ? `?expected=${savedRow.revision}` : ''),
        deployment,
        {
          ...advanced,
          ...(savedRow ? { id: savedRow.id } : {}),
          name: displayName,
          configuration,
          alias: apiAlias,
          identifier_mode: identifierMode,
          runtime_assignment: advanced.runtime_assignment,
          residency,
          idle_timeout: idle,
          template_override: templateOverride,
          enabled: mode !== 'disabled',
        },
      );
      setSavedRow(saved);
      const pendingStatus = await checkPending(saved);
      if (pendingStatus?.pending) {
        setOutcome('pending');
      } else if (mode === 'load') {
        setOutcome('launch');
        setLaunchError('');
        setAccepted(false);
        try {
          setLaunchPlan(await launchPlanFor(saved));
        } catch (e) {
          setOutcome('failed');
          setLaunchError(message(e));
        }
      } else if (mode === 'none') {
        setOutcome('available');
        void checkPending(saved);
      } else {
        setOutcome('disabled');
        void checkPending(saved);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const plan = launchPlanState;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function launchPlanFor(dep: Deployment): Promise<LaunchPlan> {
    return readApi(`/api/deployments/${dep.id}/validate`, launchPlan, {});
  }
  async function loadModel(dep: Deployment, token: string): Promise<void> {
    const queued = await readApi(`/api/deployments/${dep.id}/load-model`, job, {
      plan_token: token,
    });
    const deadline = Date.now() + ((dep.queue_timeout || 300) + 30) * 1000;
    while (mounted.current && Date.now() < deadline) {
      const jobs = await readApi('/api/registry/jobs', array(job));
      const current = jobs.find((j) => j.id === queued.id);
      if (current?.state === 'SUCCEEDED') return;
      if (current?.state === 'FAILED')
        throw new Error(current.error || 'Model could not load');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      'Loading has not completed. Check the operation in Activity before retrying.',
    );
  }
  async function checkPending(dep: Deployment) {
    try {
      const status = (await api(
        `/api/deployments/${dep.id}/pending`,
      )) as PendingStatus;
      setPending(status);
      if (!status.pending)
        setOutcome((current) =>
          current === 'pending'
            ? dep.enabled
              ? 'available'
              : 'disabled'
            : current,
        );
      return status;
    } catch {
      setPending(null);
      return null;
    }
  }
  async function onLoad(dep: Deployment) {
    if (!plan) return;
    setLaunchBusy(true);
    setLaunchError('');
    try {
      await loadModel(dep, plan.plan_token);
      setOutcome('loaded');
    } catch (e) {
      setOutcome('failed');
      setLaunchError(message(e));
    } finally {
      setLaunchBusy(false);
      void checkPending(dep);
    }
  }
  async function retryLaunch(dep: Deployment) {
    setOutcome('launch');
    setLaunchError('');
    setAccepted(false);
    try {
      setLaunchPlan(await launchPlanFor(dep));
    } catch (e) {
      setOutcome('failed');
      setLaunchError(message(e));
    }
  }
  async function onTest(dep: Deployment): Promise<void> {
    setTestOutput('');
    setTestError('');
    setTestReceived(false);
    setTestBusy(true);
    const controller = new AbortController();
    try {
      await streamCompletion(
        dep.alias,
        'Say hello in one sentence.',
        controller.signal,
        (text) => setTestOutput((old) => old + text),
      );
      setTestReceived(true);
    } catch (e) {
      setTestError(
        controller.signal.aborted
          ? 'Request cancelled. Any partial response is kept below.'
          : message(e),
      );
    } finally {
      setTestBusy(false);
    }
  }

  const advance = () => {
    if (!displayName) {
      setError('Enter a name for this model.');
      return;
    }
    if (
      step === 1 &&
      contextMode === 'custom' &&
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

  const showCompletion = outcome !== null && outcome !== 'launch';
  const needsAcceptance = Boolean(plan?.stops?.length);
  const behaviorSummary =
    residency === 'on-demand'
      ? idle
        ? `Available to clients. Loads when requested and unloads after ${idle / 60} minutes without requests.`
        : 'Available to clients. Loads when requested; idle unloading is off.'
      : residency === 'pinned'
        ? 'Pinned: never automatically unloaded to make room.'
        : 'Evictable: loads manually; can make room when idle and authorized.';

  if (suspended) return null;
  return (
    <Dialog
      title={'Set up model'}
      close={close}
      busy={busy || launchBusy || testBusy}
      wide
    >
      <ol className="steps" aria-label="Set up model">
        {['Choose model', 'Review setup', 'Make available'].map((s, i) => (
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
      <h3 ref={heading} tabIndex={-1}>
        {stepper.current.title}
      </h3>
      {error && (
        <Alert variant="destructive" className="mb-5" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
            {error}
          </AlertDescription>
        </Alert>
      )}
      <DraftFormProvider value={form}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (step < 2) void form.handleSubmit();
          }}
        >
          <FieldSet disabled={busy || launchBusy}>
            {step === 0 && (
              <>
                {!data.models?.length && (
                  <section>
                    <h3>Add your first model</h3>
                    <p>
                      Download a model or add files you already have, then
                      continue setup.
                    </p>
                    <Button type="button" onClick={() => acquireModel(false)}>
                      Discover models
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => acquireModel(true)}
                    >
                      Add from file
                    </Button>
                  </section>
                )}
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
                    <h3>An engine is needed for this model</h3>
                    <p className="muted">
                      Choose a compatible engine to continue. Your setup will be
                      kept.
                    </p>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={setupEngine}
                    >
                      Choose engine
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
                <p className="muted">
                  Engine settings will be used unless you customize them.
                </p>
              </>
            )}
            {step === 1 && (
              <>
                <Field
                  label="Name"
                  hint="Used throughout Menagerie and in connected clients."
                >
                  <Input
                    required
                    value={displayName}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                {identifierMode === 'generated' ? (
                  <Field label="API model ID" hint={generatedHint}>
                    <div className="flex items-center gap-2">
                      <Input
                        readOnly
                        aria-label="API model ID"
                        placeholder={suggested.busy ? '…' : ''}
                        value={suggested.alias}
                      />
                      {suggested.alias && (
                        <CopyButton
                          value={suggested.alias}
                          label="Copy API model ID"
                        />
                      )}
                    </div>
                    <div className="pt-2">
                      <button
                        type="button"
                        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--bg-2)]"
                        onClick={() => {
                          setIdentifierMode('custom');
                          setAlias(
                            suggested.alias || localAliasFallback(displayName),
                          );
                        }}
                        aria-label="Customize API model ID"
                      >
                        Customize API model ID
                      </button>
                    </div>
                  </Field>
                ) : (
                  <Field
                    label="API model"
                    hint="This ID stays the same when you rename the model."
                  >
                    <Input
                      required
                      pattern="[a-zA-Z0-9][a-zA-Z0-9_.\/\-]{0,159}"
                      value={alias}
                      onChange={(e) => setAlias(e.target.value)}
                      aria-label="API model ID"
                    />
                    {aliasInUse && (
                      <p className="error-text">
                        This API model ID is already in use. Choose another.
                      </p>
                    )}
                    <div className="pt-2 flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--bg-2)]"
                        onClick={() => {
                          setIdentifierMode('generated');
                        }}
                        aria-label="Generate API model ID from the name"
                      >
                        Generate from name
                      </button>
                      {alias && (
                        <CopyButton value={alias} label="Copy API model ID" />
                      )}
                    </div>
                  </Field>
                )}
                <Field
                  label="Context capacity"
                  hint="More context → more memory"
                >
                  <NativeSelect
                    value={contextMode}
                    onChange={(e) =>
                      setContextMode(e.target.value as ContextMode)
                    }
                  >
                    <NativeSelectOption value="default">
                      Engine default
                    </NativeSelectOption>
                    {runtime?.engine === 'llama.cpp' && (
                      <NativeSelectOption value="automatic">
                        Automatic
                      </NativeSelectOption>
                    )}
                    <NativeSelectOption value="custom">
                      Custom
                    </NativeSelectOption>
                  </NativeSelect>
                  <p className="muted">
                    {contextMode === 'default'
                      ? 'The engine chooses the value. No override is saved; the value may differ between loads.'
                      : contextMode === 'automatic'
                        ? 'Uses this engine’s automatic mode. This is an explicit setting, not the same as leaving the option unset.'
                        : 'Set a context limit.'}
                  </p>
                </Field>
                {contextMode === 'custom' && hasContext && (
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
                      value={String(context)}
                      options={[
                        ...[8192, 16384, 32768].map((n) => ({
                          value: String(n),
                          label: `${n / 1024}K${
                            suggestedContext && n > suggestedContext ? ' ⚠' : ''
                          }`,
                          disabled:
                            n * (hasParallel ? parallel : 1) >
                            (schema[contextKey].max || 1048576),
                        })),
                        { value: 'custom', label: 'Custom' },
                      ]}
                      change={(next) => {
                        setContext(Number(next) || context);
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
                        }}
                      >
                        Use suggested default
                      </Button>
                    )}
                    <Input
                      aria-label="Custom context / request"
                      type="number"
                      min={schema[contextKey].min || 512}
                      max={
                        (schema[contextKey].max || 1048576) /
                        (hasParallel ? parallel : 1)
                      }
                      value={context}
                      onChange={(e) => setContext(Number(e.target.value))}
                    />
                  </Field>
                )}
                {contextMode === 'custom' && hasParallel && (
                  <Field
                    label="Concurrent requests"
                    hint="More simultaneous requests → more resource demand"
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
                <Field label="Mode">
                  <NativeSelect
                    value={residency}
                    onChange={(e) => setResidency(e.target.value)}
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
                  <small>{behaviorSummary}</small>
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
                <SettingsSection
                  name="capabilities"
                  title="Modalities & capabilities"
                >
                  <Capabilities
                    key={artifactId + ':' + runtime?.id}
                    catalog={catalog}
                    change={setCatalog}
                    valid={(key, ok) =>
                      setInvalid((v) => ({ ...v, [key]: !ok }))
                    }
                  />
                </SettingsSection>
                <Variants catalog={catalog} change={setCatalog} />
                <ModelCompanions
                  model={artifact}
                  models={data.models || []}
                  value={{ ...extraDraft, config: extra }}
                  schema={schema}
                  change={(value) => setExtra(value.config)}
                />
                <details>
                  <summary>Advanced</summary>
                  <Field
                    label="Runtime pool"
                    hint="Uses a compatible shared runtime when available."
                  >
                    <NativeSelect
                      value={advanced.runtime_assignment}
                      onChange={(e) =>
                        setAdvanced((value) => ({
                          ...value,
                          runtime_assignment:
                            e.target.value === 'dedicated'
                              ? 'dedicated'
                              : 'automatic',
                        }))
                      }
                    >
                      <NativeSelectOption value="automatic">
                        Automatic assignment
                      </NativeSelectOption>
                      <NativeSelectOption value="dedicated">
                        Dedicated runtime
                      </NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  <RuntimeSettings
                    engineSelected={Boolean(runtime)}
                    formPath="config"
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
                </details>
              </>
            )}
            {step === 2 && showCompletion && (
              <Completion
                outcome={outcome}
                name={savedRow?.name || displayName}
                alias={savedRow?.alias || apiAlias}
                savedRow={savedRow}
                launchError={launchError}
                onTest={onTest}
                testOutput={testOutput}
                testError={testError}
                testBusy={testBusy}
                testReceived={testReceived}
                onConnect={onConnect}
                pending={pending}
                pendingError={pendingError}
                setPendingError={setPendingError}
                refetchPending={() => savedRow && void checkPending(savedRow)}
                onRetry={() => savedRow && void retryLaunch(savedRow)}
                onEditSetup={() => {
                  setOutcome(null);
                  setStep(1);
                }}
              />
            )}
            {step === 2 && outcome === 'launch' && (
              <LaunchReviewInline
                plan={plan}
                name={displayName}
                needsAcceptance={needsAcceptance}
                accepted={accepted}
                setAccepted={setAccepted}
                launchError={launchError}
                launchBusy={launchBusy}
                onBack={() => {
                  setOutcome(null);
                  setStep(1);
                }}
                onLoad={() => (savedRow ? onLoad(savedRow) : void 0)}
              />
            )}
            {step === 2 && outcome === null && (
              <MakeAvailableForm
                onNameChange={setName}
                displayName={displayName}
                apiAlias={apiAlias}
                behaviorSummary={behaviorSummary}
                onMakeAvailableAndLoad={() => save('load')}
                onMakeAvailableWithoutLoad={() => save('none')}
                onSaveDisabled={() => save('disabled')}
              />
            )}
          </FieldSet>
          {step > 0 && (
            <DraftResources preview={preview.data} error={preview.error} />
          )}
          <div className="dialog-actions">
            {step > 0 && !showCompletion && (
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
                Continue
              </Button>
            ) : (
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  close();
                  if (savedRow) created(savedRow);
                }}
              >
                Open deployment
              </Button>
            )}
          </div>
        </form>
      </DraftFormProvider>
    </Dialog>
  );
}

function MakeAvailableForm({
  onNameChange,
  displayName,
  apiAlias,
  behaviorSummary,
  onMakeAvailableAndLoad,
  onMakeAvailableWithoutLoad,
  onSaveDisabled,
}: {
  onNameChange: (name: string) => void;
  displayName: string;
  apiAlias: string;
  behaviorSummary: string;
  onMakeAvailableAndLoad: () => void;
  onMakeAvailableWithoutLoad: () => void;
  onSaveDisabled: () => void;
}) {
  return (
    <>
      <Field
        label="Name"
        hint="Used throughout Menagerie and in connected clients."
      >
        <Input
          required
          value={displayName}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </Field>
      <dl className="properties">
        <dt>API model</dt>
        <dd>
          <code>{apiAlias}</code>
        </dd>
        <dt>Behavior</dt>
        <dd>{behaviorSummary}</dd>
      </dl>
      <p className="muted">
        Make available and load saves, enables, and proceeds through the
        required launch review to load the model. It does not send an inference
        test.
      </p>
      <div className="dialog-actions">
        <Button
          variant="default"
          type="button"
          onClick={onMakeAvailableAndLoad}
        >
          Make available and load
        </Button>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            type="button"
            onClick={onMakeAvailableWithoutLoad}
          >
            Make available without loading
          </Button>
          <Button variant="outline" type="button" onClick={onSaveDisabled}>
            Save disabled
          </Button>
        </div>
      </div>
    </>
  );
}

function LaunchReviewInline({
  plan,
  name,
  needsAcceptance,
  accepted,
  setAccepted,
  launchError,
  launchBusy,
  onBack,
  onLoad,
}: {
  plan: LaunchPlan | null;
  name: string;
  needsAcceptance: boolean;
  accepted: boolean;
  setAccepted: (value: boolean) => void;
  launchError: string;
  launchBusy: boolean;
  onBack: () => void;
  onLoad: () => void;
}) {
  const stops = plan?.stops || [];
  const names = stops;
  const canLoad =
    plan && plan.errors.length === 0 && (!needsAcceptance || accepted);
  return (
    <>
      <h3>{name}</h3>
      <p className="muted">Loading {name}…</p>
      {launchError && (
        <Alert variant="destructive" className="mb-5" role="alert">
          <AlertDescription>{launchError}</AlertDescription>
        </Alert>
      )}
      {!plan && !launchError && <p className="muted">Checking capacity…</p>}
      {plan && (
        <>
          {plan.stops.length > 0 && (
            <div className="warning">
              <h3>Will unload</h3>
              <ul>
                {names.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <p>
                KV caches will be lost. Failed launches attempt to restore these
                deployments.
              </p>
              <label className="check">
                <Checkbox checked={accepted} onCheckedChange={setAccepted} />I
                understand the listed models will be unloaded and their KV
                caches lost.
              </label>
            </div>
          )}
          {plan.errors.length > 0 &&
            plan.errors.map((e, i) => (
              <Alert
                variant="destructive"
                className="mb-5"
                role="alert"
                key={e + i}
              >
                <AlertDescription>{e}</AlertDescription>
              </Alert>
            ))}
          <div className="dialog-actions">
            <Button variant="outline" type="button" onClick={onBack}>
              Back
            </Button>
            <Button
              variant="default"
              type="button"
              disabled={!canLoad || launchBusy}
              onClick={onLoad}
            >
              {launchBusy ? 'Loading…' : 'Load'}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function Completion({
  outcome,
  name,
  alias,
  savedRow,
  launchError,
  onTest,
  testOutput,
  testError,
  testBusy,
  testReceived,
  onConnect,
  pending,
  pendingError,
  setPendingError,
  refetchPending,
  onRetry,
  onEditSetup,
}: {
  outcome: Outcome;
  name: string;
  alias: string;
  savedRow: Deployment | null;
  launchError: string;
  onTest: (dep: Deployment) => Promise<void>;
  testOutput: string;
  testError: string;
  testBusy: boolean;
  testReceived: boolean;
  onConnect: () => void;
  pending: PendingStatus | null;
  pendingError: string;
  setPendingError: (value: string) => void;
  refetchPending: () => void;
  onRetry: () => void;
  onEditSetup: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showError, setShowError] = useState(false);
  const title: Record<Outcome, string> = {
    loaded: `${name} is loaded and available`,
    available: `${name} is available`,
    disabled: `${name} is saved and disabled`,
    pending: 'Setup saved. Changes are waiting to be applied.',
    failed: 'Setup saved, but the model could not load.',
    launch: '',
  };
  const desc: Record<Outcome, string> = {
    loaded:
      'The model is running and routable to clients on the local gateway.',
    available: 'Loads on the first request.',
    disabled: 'Not advertised to clients.',
    pending:
      'Apply the queued change when the runtime is idle to avoid an immediate unload.',
    failed: 'Your configuration is preserved; review it below.',
    launch: '',
  };
  const titleText = title[outcome];
  const descText = desc[outcome];
  const copyAlias = (): void => {
    void navigator.clipboard
      .writeText(alias)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => void 0);
  };
  return (
    <>
      <h3>{titleText}</h3>
      <p className="muted">{descText}</p>
      {outcome === 'available' && (
        <Button type="button" onClick={onRetry}>
          Review and load
        </Button>
      )}
      {savedRow && (
        <PendingChanges
          deploymentId={savedRow.id}
          changed={() => {
            setPendingError('');
            refetchPending();
          }}
        />
      )}
      {pendingError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{pendingError}</AlertDescription>
        </Alert>
      )}
      {outcome === 'failed' && (
        <>
          <div className="dialog-actions">
            <Button
              variant="outline"
              type="button"
              onClick={() => setShowError((v) => !v)}
            >
              View error
            </Button>
            <Button variant="outline" type="button" onClick={onEditSetup}>
              Edit setup
            </Button>
            <Button variant="outline" type="button" onClick={onRetry}>
              Try again
            </Button>
          </div>
          {showError && launchError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{launchError}</AlertDescription>
            </Alert>
          )}
        </>
      )}
      <div className="dialog-actions">
        <Button variant="outline" type="button" onClick={onConnect}>
          Connect a client
        </Button>
      </div>
      <Field label="Test model" hint="Sends a request and may load this model.">
        <Button
          variant="outline"
          type="button"
          disabled={testBusy || pending?.pending || outcome === 'disabled'}
          onClick={() => {
            if (savedRow) void onTest(savedRow);
          }}
        >
          {testBusy ? 'Sending…' : 'Test model'}
        </Button>
      </Field>
      {testOutput && (
        <pre className="whitespace-pre-wrap break-words">{testOutput}</pre>
      )}
      {testReceived && <p className="muted">Test response received</p>}
      {testError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{testError}</AlertDescription>
        </Alert>
      )}
      <div className="dialog-actions">
        <Button variant="outline" type="button" onClick={copyAlias}>
          {copied ? 'Copied' : 'Copy API model ID'}
        </Button>
      </div>
      <p className="muted">
        Uses the local gateway. This test is not saved as a conversation. Normal
        gateway request accounting still applies.
      </p>
    </>
  );
}
