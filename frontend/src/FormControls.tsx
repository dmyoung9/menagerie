import { FieldGroup, FieldSet, FieldLegend } from '@/components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { RotateCcw } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Field } from './ui';
import { type ReactNode } from 'react';
import { SettingsSection } from '@/components/settings-section';
import { memory } from '@/lib/formatters';
import { NumberControl, ExactNumber } from './NumberControl';
import { DraftTokenRange } from './DraftTokenRange';
import { RuntimeFlagCard } from './RuntimeFlagCard';
import type { ConfigPath } from './draft-form';
import type {
  DeploymentDraft,
  GpuSnapshot,
  HostSnapshot,
  JsonValue,
  RuntimeField,
  RuntimeRecommendation,
} from './types';

type PlacementValue = Pick<DeploymentDraft, 'gpu' | 'port'>;

export function Placement({
  value,
  change,
  host = {},
  part = 'all',
}: {
  value: PlacementValue;
  change: (v: PlacementValue) => void;
  host?: HostSnapshot;
  part?: 'all' | 'gpu' | 'network';
}) {
  return (
    <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
      {part !== 'network' && (
        <Field label="GPU">
          {host.gpus?.length ? (
            <NativeSelect
              value={value.gpu ?? ''}
              onChange={(e) =>
                change({
                  ...value,
                  gpu: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            >
              <NativeSelectOption value="">
                Engine-selected devices
              </NativeSelectOption>
              {value.gpu !== null &&
                !host.gpus.some((g: GpuSnapshot) => g.index === value.gpu) && (
                  <NativeSelectOption value={value.gpu}>
                    GPU {value.gpu} (unavailable)
                  </NativeSelectOption>
                )}
              {host.gpus.map((g: GpuSnapshot) => (
                <NativeSelectOption key={g.index} value={g.index}>
                  {g.name} · GPU {g.index} ·{' '}
                  {typeof g.free_mib === 'number'
                    ? memory(g.free_mib) + ' free'
                    : 'capacity unknown'}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : (
            <Input
              type="number"
              min={0}
              aria-label="GPU index"
              placeholder="Engine-selected devices"
              value={value.gpu ?? ''}
              onChange={(e) =>
                change({
                  ...value,
                  gpu: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          )}
        </Field>
      )}
      {part !== 'gpu' && (
        <Field label="Private port">
          <NumberControl
            label="Private port"
            required
            min={1024}
            max={65535}
            value={value.port}
            change={(port) => change({ ...value, port: port ?? 0 })}
          />
        </Field>
      )}
    </FieldGroup>
  );
}

export function Choices({
  label,
  value,
  options,
  change,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  change: (value: string) => void;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">{label}</FieldLegend>
      <ToggleGroup
        variant="outline"
        className="flex-wrap"
        aria-label={label}
        value={[value || 'engine-default']}
        onValueChange={(values) => {
          if (values.length)
            change(values[0] === 'engine-default' ? '' : values[0]);
        }}
      >
        {options.map((o) => (
          <ToggleGroupItem
            key={o.value}
            value={o.value || 'engine-default'}
            disabled={o.disabled}
          >
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </FieldSet>
  );
}

export function Duration({
  value,
  change,
}: {
  value: number;
  change: (value: number) => void;
}) {
  const presets = [0, 60, 300, 900, 1800];
  return (
    <Field label="Unload after idle">
      <div className="control-pair">
        <NativeSelect
          aria-label="Idle duration"
          value={presets.includes(value) ? value : 'custom'}
          onChange={(e) =>
            change(e.target.value === 'custom' ? 600 : Number(e.target.value))
          }
        >
          {presets.map((n) => (
            <NativeSelectOption key={n} value={n}>
              {n ? `${n / 60} minutes` : 'Never'}
            </NativeSelectOption>
          ))}
          <NativeSelectOption value="custom">Custom seconds</NativeSelectOption>
        </NativeSelect>
        {!presets.includes(value) && (
          <NumberControl
            label="Custom idle duration in seconds"
            min={1}
            max={86400}
            required
            value={value}
            change={(next) => change(next ?? 0)}
          />
        )}
      </div>
    </Field>
  );
}

export function RuntimeControl({
  configKey,
  schema,
  value,
  change,
  disabled = false,
  host = {},
  recommendation = {},
  compact = false,
  showReset = true,
}: {
  configKey: string;
  schema: Record<string, RuntimeField>;
  value: Record<string, JsonValue>;
  change: (value: Record<string, JsonValue>) => void;
  disabled?: boolean;
  host?: HostSnapshot;
  recommendation?: RuntimeRecommendation;
  compact?: boolean;
  showReset?: boolean;
}) {
  const key = configKey;
  const f = schema[key];
  if (!f) return null;
  const label = f.label || key;
  const current = value[key];
  const thread = ['threads', 'threads-batch'].includes(key);
  const context = ['ctx-size', 'max-model-len'].includes(key);
  const inherited = f.default_from
    ? (value[f.default_from] ?? schema[f.default_from]?.engine_default)
    : undefined;
  const engineDefault =
    typeof inherited === 'number' ? inherited : f.engine_default;
  const min = Math.min(f.min ?? 0, engineDefault ?? f.min ?? 0);
  const update = (key: string, next: JsonValue | undefined) => {
    const config = { ...value };
    if (next === undefined) delete config[key];
    else config[key] = next;
    change(config);
  };
  const setNumeric = (next: number | undefined) => update(key, next);
  const fieldMax = f.max ?? Number.MAX_SAFE_INTEGER;
  const numeric = ['integer', 'number'].includes(f.type || '');
  const recommended =
    context && recommendation.context_key === key
      ? recommendation.context_recommended_max
      : undefined;
  const max =
    key === 'ubatch-size'
      ? Math.min(
          fieldMax,
          typeof value['batch-size'] === 'number'
            ? value['batch-size']
            : typeof schema['batch-size']?.engine_default === 'number'
              ? schema['batch-size'].engine_default
              : fieldMax,
        )
      : fieldMax;
  const inputMax = Number.isFinite(max) ? max : undefined;
  const stops = [
    ...(numeric
      ? new Set(
          [
            min,
            2048,
            4096,
            8192,
            16384,
            32768,
            65536,
            131072,
            262144,
            524288,
            max,
          ].filter((n): n is number => n >= min && n <= max),
        )
      : []),
  ].sort((a, b) => a - b);
  const effective = Number(current ?? engineDefault ?? min);
  const placeholder =
    engineDefault !== undefined
      ? `${engineDefault.toLocaleString()}${f.units ? ' ' + f.units : ''}`
      : 'Engine default';
  const reset =
    showReset && current !== undefined ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-label={`Use engine default for ${label}`}
        onClick={() => update(key, undefined)}
      >
        <RotateCcw data-icon="inline-start" />
        Reset
      </Button>
    ) : null;
  const exact =
    compact && numeric ? (
      <ExactNumber
        label={label}
        value={typeof current === 'number' ? current : undefined}
        placeholder={placeholder}
        min={min}
        max={inputMax}
        step={f.type === 'number' ? 'any' : 1}
        disabled={disabled}
        change={setNumeric}
      />
    ) : (
      <Input
        disabled={disabled}
        aria-label={label}
        type={numeric ? 'number' : 'text'}
        required={current !== undefined}
        min={min}
        max={inputMax}
        step={f.type === 'number' ? 'any' : 1}
        value={
          typeof current === 'string' || typeof current === 'number'
            ? current
            : numeric
              ? (engineDefault ?? '')
              : ''
        }
        placeholder={numeric ? 'Not reported' : undefined}
        onChange={(e) =>
          numeric
            ? setNumeric(
                e.target.value === '' ? undefined : Number(e.target.value),
              )
            : update(key, e.target.value || undefined)
        }
      />
    );
  if (key === 'gpu-layers' && f.cpu_only)
    return (
      <Field
        key={key}
        label={label}
        hint="This engine runs entirely on CPU and system RAM."
      >
        <span>0 · CPU engine</span>
      </Field>
    );
  if (key === 'gpu-layers')
    return (
      <Field
        key={key}
        label={label}
        hint={
          recommendation.gpu_layers_max
            ? `${recommendation.gpu_layers_max} model layers. Fewer GPU layers use system RAM and are slower.`
            : 'Fewer GPU layers use system RAM and are slower; model layer count unavailable.'
        }
      >
        <div className="control-pair">
          <NativeSelect
            aria-label="GPU layer mode"
            disabled={disabled}
            value={
              current === undefined
                ? 'default'
                : current === 'all' || current === 'auto'
                  ? current
                  : 'custom'
            }
            onChange={(e) =>
              update(
                key,
                e.target.value === 'default'
                  ? undefined
                  : e.target.value === 'all' || e.target.value === 'auto'
                    ? e.target.value
                    : '0',
              )
            }
          >
            <NativeSelectOption value="default">
              Engine default
            </NativeSelectOption>
            <NativeSelectOption value="all">GPU-resident</NativeSelectOption>
            <NativeSelectOption value="auto">Automatic fit</NativeSelectOption>
            <NativeSelectOption value="custom">
              CPU/RAM offload (slower)
            </NativeSelectOption>
          </NativeSelect>
          {current !== undefined && current !== 'all' && current !== 'auto' && (
            <NumberControl
              label="GPU layer count"
              required
              min={0}
              max={recommendation.gpu_layers_max ?? undefined}
              step={1}
              value={Number(current)}
              change={(v) => update(key, String(v ?? 0))}
            />
          )}
          {reset}
        </div>
      </Field>
    );
  if (f.type === 'boolean')
    return (
      <Field key={key} label={label} hint={f.description}>
        <div className="exact-control">
          <NativeSelect
            aria-label={label}
            disabled={disabled}
            value={current === undefined ? '' : String(current)}
            onChange={(e) =>
              update(
                key,
                e.target.value === '' ? undefined : e.target.value === 'true',
              )
            }
          >
            <NativeSelectOption value="">Engine default</NativeSelectOption>
            <NativeSelectOption value="true">Enabled</NativeSelectOption>
            <NativeSelectOption value="false">Disabled</NativeSelectOption>
          </NativeSelect>
          {reset}
        </div>
      </Field>
    );
  if (f.choices)
    return (
      <Field key={key} label={label} hint={f.description}>
        <div className="exact-control">
          <NativeSelect
            aria-label={label}
            disabled={disabled}
            value={
              typeof current === 'string' || typeof current === 'number'
                ? String(current)
                : ''
            }
            onChange={(e) => update(key, e.target.value || undefined)}
          >
            <NativeSelectOption value="">
              Unspecified · engine default
            </NativeSelectOption>
            {current !== undefined && !f.choices.includes(String(current)) && (
              <NativeSelectOption value={String(current)}>
                {String(current)} · saved value not advertised
              </NativeSelectOption>
            )}
            {(f.choices || []).map((v: string) => (
              <NativeSelectOption
                key={v}
                disabled={
                  (key === 'cache-type-v' &&
                    value['flash-attn'] === 'off' &&
                    v !== 'f16') ||
                  (key === 'flash-attn' &&
                    v === 'off' &&
                    !['f16', undefined].includes(
                      (value['cache-type-v'] ??
                        schema['cache-type-v']?.engine_default ??
                        schema['cache-type-v']?.default) as string | undefined,
                    ))
                }
              >
                {v}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {reset}
        </div>
      </Field>
    );
  if (context || (numeric && !compact)) {
    const recommendedStops =
      typeof recommended === 'number'
        ? stops.filter((n) => n <= recommended)
        : stops;
    const sliderStops = recommendedStops.length > 1 ? recommendedStops : stops;
    const sliderIndex = sliderStops.reduce(
      (best, n, i) =>
        Math.abs(n - effective) < Math.abs(sliderStops[best] - effective)
          ? i
          : best,
      0,
    );
    return (
      <Field
        key={key}
        label={label}
        hint={
          context && effective === 0
            ? 'Use model context'
            : context && schema.parallel
              ? `${effective.toLocaleString()} tokens shared across ${value.parallel ?? schema.parallel.engine_default ?? schema.parallel.default ?? 1} concurrent requests`
              : thread && host.cpu_count
                ? `${host.cpu_count} host threads available`
                : f.description || f.units
        }
      >
        <div className="range-control">
          {!compact && context && sliderStops.length > 1 ? (
            <Slider
              disabled={disabled}
              aria-label={`${label} range`}
              aria-valuetext={
                effective === 0
                  ? '0 · model context'
                  : `${effective.toLocaleString()} tokens`
              }
              min={0}
              max={sliderStops.length - 1}
              step={1}
              value={[sliderIndex]}
              onValueChange={(range) =>
                setNumeric(
                  sliderStops[Number(Array.isArray(range) ? range[0] : range)],
                )
              }
            />
          ) : null}
          {exact}
          {reset}
        </div>
        {context && recommendation.context_key === key && (
          <div
            className={
              recommended === null ||
              (typeof recommended === 'number' && effective > recommended)
                ? 'warning'
                : 'muted'
            }
          >
            {recommended === null ? (
              'Even minimum context exceeds the estimated budget. Reduce peers, choose smaller weights, or use CPU/RAM offload.'
            ) : (
              <>
                Context pool limit: {recommended?.toLocaleString()} tokens.{' '}
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => update(key, recommendation.context_default)}
                >
                  Use suggested default
                </Button>
              </>
            )}
            <small>{recommendation.reason}.</small>
          </div>
        )}
      </Field>
    );
  }
  const sliderMax = key.includes('draft')
    ? 32
    : key === 'top-k'
      ? 200
      : key === 'reasoning-budget'
        ? 32768
        : max === Number.MAX_SAFE_INTEGER
          ? 1024
          : max;
  return (
    <Field
      key={key}
      label={label}
      hint={
        effective === -1 && thread
          ? 'Automatic thread selection'
          : effective === -1 && key === 'parallel'
            ? 'Automatic slots'
            : effective === -1 && key === 'reasoning-budget'
              ? 'Unlimited'
              : f.description || f.units
      }
    >
      <div className="range-control">
        {compact ? (
          exact
        ) : (
          <NumberControl
            label={label}
            value={typeof current === 'number' ? current : undefined}
            defaultValue={engineDefault}
            min={min}
            max={inputMax}
            sliderMax={sliderMax}
            step={f.type === 'number' ? 0.01 : 1}
            disabled={disabled}
            change={setNumeric}
          />
        )}
        {reset}
      </div>
    </Field>
  );
}

export function RuntimeSettings({
  schema,
  value,
  change,
  host = {},
  recommendation = {},
  section,
  before,
  after,
  disabled = false,
  engineSelected = Object.keys(schema).length > 0,
  formPath = 'configuration.config',
  curated = false,
}: {
  schema: Record<string, RuntimeField>;
  value: Record<string, JsonValue>;
  change: (value: Record<string, JsonValue>) => void;
  host?: HostSnapshot;
  recommendation?: RuntimeRecommendation;
  section?:
    'multimodal' | 'mtp' | 'memory' | 'performance' | 'generation' | 'other';
  before?: ReactNode;
  after?: ReactNode;
  disabled?: boolean;
  engineSelected?: boolean;
  formPath?: ConfigPath;
  curated?: boolean;
}) {
  const draftKeys: [string, string] | undefined =
    schema['spec-draft-n-min'] && schema['spec-draft-n-max']
      ? ['spec-draft-n-min', 'spec-draft-n-max']
      : schema['draft-min'] && schema['draft-max']
        ? ['draft-min', 'draft-max']
        : undefined;
  const groups: [string, string, string[]][] = [
    ['multimodal', 'Multimodal', ['mmproj']],
    [
      'mtp',
      'MTP',
      [
        'spec-type',
        'spec-draft-model',
        'model-draft',
        'spec-draft-n-max',
        'spec-draft-n-min',
        'draft-max',
        'draft-min',
      ],
    ],
    [
      'memory',
      curated ? 'Resources & context' : 'Memory & placement',
      [
        'ctx-size',
        'max-model-len',
        'parallel',
        'gpu-layers',
        'fit',
        'fit-target',
        'fit-ctx',
        'device',
        'split-mode',
        'tensor-split',
        'override-tensor',
        'cpu-moe',
        'n-cpu-ffn',
        'n-cpu-moe',
        'cache-type-k',
        'cache-type-v',
        'gpu-memory-utilization',
      ],
    ],
    [
      'performance',
      'Performance',
      ['flash-attn', 'threads', 'threads-batch', 'batch-size', 'ubatch-size'],
    ],
    [
      'generation',
      'Generation',
      [
        'temp',
        'top-p',
        'top-k',
        'min-p',
        'presence-penalty',
        'repeat-penalty',
        'reasoning-budget',
      ],
    ],
  ];
  groups.push([
    'other',
    'Other engine controls',
    Object.keys(schema).filter(
      (k) => !groups.some(([, , keys]) => keys.includes(k)),
    ),
  ]);
  const control = (key: string) => (
    <RuntimeControl
      key={key}
      configKey={key}
      schema={schema}
      value={value}
      change={change}
      disabled={disabled}
      host={host}
      recommendation={recommendation}
    />
  );
  return (
    <div className="runtime-settings">
      {groups
        .filter(
          ([name, , keys]) =>
            (!section || section === name) &&
            (keys.some((k) => schema[k]) ||
              before ||
              after ||
              name === 'performance' ||
              name === 'memory'),
        )
        .map(([name, title, keys]) => {
          if (name === 'performance' || name === 'generation')
            return (
              <RuntimeFlagCard
                key={name}
                name={name}
                title={title}
                keys={keys}
                schema={schema}
                value={value}
                change={change}
                host={host}
                disabled={disabled}
                before={before}
                after={after}
                formPath={formPath}
                engineSelected={engineSelected}
                curated={curated && name === 'generation'}
              />
            );
          const fields = (
            <>
              {before}
              {name === 'mtp' && draftKeys && (
                <DraftTokenRange
                  schema={schema}
                  value={value}
                  keys={draftKeys}
                  disabled={disabled}
                  change={change}
                />
              )}
              <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                {keys
                  .filter(
                    (k) =>
                      schema[k] &&
                      (name !== 'memory' ||
                        (curated
                          ? [
                              'ctx-size',
                              'max-model-len',
                              'parallel',
                              'fit',
                              'device',
                              'gpu-memory-utilization',
                            ]
                          : ['ctx-size', 'max-model-len', 'parallel']
                        ).includes(k)) &&
                      !(name === 'mtp' && draftKeys?.includes(k)) &&
                      !(
                        name === 'mtp' &&
                        [
                          'spec-type',
                          'spec-draft-model',
                          'model-draft',
                        ].includes(k)
                      ),
                  )
                  .map(control)}
              </FieldGroup>
              {name === 'memory' && (
                <>
                  <p className="text-muted-foreground text-sm">
                    The engine manages memory and placement by default. Set
                    context or concurrency only when your workload needs an
                    explicit limit.
                  </p>
                  {keys.some(
                    (key) =>
                      schema[key] &&
                      !(
                        curated
                          ? [
                              'ctx-size',
                              'max-model-len',
                              'parallel',
                              'fit',
                              'device',
                              'gpu-memory-utilization',
                            ]
                          : ['ctx-size', 'max-model-len', 'parallel']
                      ).includes(key),
                  ) && (
                    <details>
                      <summary>Advanced memory and placement</summary>
                      <p className="text-muted-foreground text-sm">
                        Overrides for offloading, cache precision and
                        multi-device layouts. Most deployments do not need
                        these; omitted settings remain engine-managed.
                      </p>
                      <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                        {keys
                          .filter(
                            (key) =>
                              schema[key] &&
                              !(
                                curated
                                  ? [
                                      'ctx-size',
                                      'max-model-len',
                                      'parallel',
                                      'fit',
                                      'device',
                                      'gpu-memory-utilization',
                                    ]
                                  : ['ctx-size', 'max-model-len', 'parallel']
                              ).includes(key),
                          )
                          .map(control)}
                      </FieldGroup>
                    </details>
                  )}
                </>
              )}
              {after}
            </>
          );
          return section === 'multimodal' || section === 'mtp' ? (
            <div key={name}>{fields}</div>
          ) : (
            <SettingsSection key={name} name={name} title={title}>
              {fields}
            </SettingsSection>
          );
        })}
    </div>
  );
}
