import { FieldGroup, FieldSet, FieldLegend } from '@/components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Field } from './ui';
import type { ReactNode } from 'react';
import { SettingsSection } from '@/components/settings-section';
import { memory } from '@/lib/formatters';
import { NumberControl } from './NumberControl';
import { DraftTokenRange } from './DraftTokenRange';
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
              value={value.gpu}
              onChange={(e) =>
                change({ ...value, gpu: Number(e.target.value) })
              }
            >
              {!host.gpus.some((g: GpuSnapshot) => g.index === value.gpu) && (
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
              required
              min={0}
              aria-label="GPU index"
              value={value.gpu}
              onChange={(e) =>
                change({ ...value, gpu: Number(e.target.value) })
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
}: {
  schema: Record<string, RuntimeField>;
  value: Record<string, JsonValue>;
  change: (value: Record<string, JsonValue>) => void;
  host?: HostSnapshot;
  recommendation?: RuntimeRecommendation;
  section?:
    | 'multimodal'
    | 'mtp'
    | 'memory'
    | 'performance'
    | 'generation'
    | 'reasoning'
    | 'other';
  before?: ReactNode;
  after?: ReactNode;
  disabled?: boolean;
}) {
  const update = (key: string, v: JsonValue | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    change(next);
  };
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
      'Memory & placement',
      [
        'ctx-size',
        'max-model-len',
        'parallel',
        'gpu-layers',
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
      ['temp', 'top-p', 'top-k', 'min-p', 'presence-penalty', 'repeat-penalty'],
    ],
    ['reasoning', 'Reasoning', ['reasoning-budget']],
  ];
  groups.push([
    'other',
    'Other engine controls',
    Object.keys(schema).filter(
      (k) => !groups.some(([, , keys]) => keys.includes(k)),
    ),
  ]);
  function control(key: string) {
    const f = schema[key],
      current = value[key],
      label = f.label || key;
    const thread = ['threads', 'threads-batch'].includes(key);
    const context = ['ctx-size', 'max-model-len'].includes(key);
    const inherited = f.default_from
      ? (value[f.default_from] ?? schema[f.default_from]?.engine_default)
      : undefined;
    const engineDefault =
      typeof inherited === 'number' ? inherited : f.engine_default;
    const min = Math.min(f.min ?? 0, engineDefault ?? f.min ?? 0);
    const setNumeric = (n: number | undefined) =>
      update(
        key,
        n === engineDefault && n !== undefined && n < (f.min ?? 0)
          ? undefined
          : n,
      );
    const fieldMax = f.max ?? Number.MAX_SAFE_INTEGER;
    const numeric = ['integer', 'number'].includes(f.type || '');
    const recommended =
      context && recommendation.context_key === key
        ? recommendation.context_recommended_max
        : undefined;
    const capacity = context
      ? recommended
      : key === 'parallel'
        ? recommendation.parallel_recommended_max
        : undefined;
    const max =
      key === 'gpu-memory-utilization' &&
      recommendation.gpu_memory_utilization_max !== undefined
        ? Math.min(fieldMax, recommendation.gpu_memory_utilization_max)
        : context
          ? fieldMax
          : typeof capacity === 'number'
            ? Math.min(fieldMax, capacity)
            : thread && host.cpu_count
              ? Math.min(f.max ?? host.cpu_count, host.cpu_count)
              : key === 'ubatch-size'
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
    const exact = (
      <Input
        disabled={disabled}
        aria-label={label}
        type={numeric ? 'number' : 'text'}
        required={current !== undefined}
        min={
          key === 'gpu-memory-utilization'
            ? (recommendation.gpu_memory_utilization_min ?? min)
            : min
        }
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
    if (
      key === 'parallel' &&
      recommendation.parallel_recommended_max !== undefined
    ) {
      const parallelMax = recommendation.parallel_recommended_max;
      return (
        <Field
          key={key}
          label={label}
          hint={
            recommendation.parallel_recommended_max === null
              ? 'Even one request slot exceeds the estimated memory budget at this context.'
              : `Concurrency limit: ${recommendation.parallel_recommended_max} with the other settings preserved.`
          }
        >
          <div className="range-control">
            {typeof parallelMax === 'number' && parallelMax > 1 && (
              <Slider
                disabled={disabled}
                aria-label="Concurrency range"
                min={min}
                max={parallelMax}
                value={[Math.min(effective, parallelMax)]}
                onValueChange={(range) =>
                  setNumeric(Number(Array.isArray(range) ? range[0] : range))
                }
              />
            )}{' '}
            {exact}
          </div>
        </Field>
      );
    }
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
              value={
                current === undefined
                  ? 'default'
                  : current === 'all'
                    ? 'all'
                    : 'custom'
              }
              onChange={(e) =>
                update(
                  key,
                  e.target.value === 'default'
                    ? undefined
                    : e.target.value === 'all'
                      ? 'all'
                      : '0',
                )
              }
            >
              <NativeSelectOption value="default">
                Engine default
              </NativeSelectOption>
              <NativeSelectOption value="all">GPU-resident</NativeSelectOption>
              <NativeSelectOption value="custom">
                CPU/RAM offload (slower)
              </NativeSelectOption>
            </NativeSelect>
            {current !== undefined && current !== 'all' && (
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
          </div>
        </Field>
      );
    if (numeric && !context) {
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
                  : f.units
          }
        >
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
        </Field>
      );
    }
    if (key === 'flash-attn')
      return (
        <Choices
          key={key}
          label={label}
          value={typeof current === 'string' ? current : ''}
          options={[
            { value: '', label: 'Default' },
            ...(f.choices || []).map((v: string) => ({
              value: v,
              label: v === 'auto' ? 'Auto' : v === 'on' ? 'On' : 'Off',
              disabled:
                v === 'off' &&
                (value['cache-type-v'] ??
                  schema['cache-type-v']?.default ??
                  'f16') !== 'f16',
            })),
          ]}
          change={(v) => update(key, v || undefined)}
        />
      );
    if (f.choices)
      return (
        <Field key={key} label={label}>
          <NativeSelect
            value={
              typeof current === 'string' || typeof current === 'number'
                ? String(current)
                : ''
            }
            onChange={(e) => update(key, e.target.value || undefined)}
          >
            <NativeSelectOption value="">
              Engine default ({String(f.default ?? 'engine')})
            </NativeSelectOption>
            {(f.choices || []).map((v: string) => (
              <NativeSelectOption
                key={v}
                disabled={
                  key === 'cache-type-v' &&
                  value['flash-attn'] === 'off' &&
                  v !== 'f16'
                }
              >
                {v}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      );
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
                : f.units
        }
      >
        <div className="range-control">
          {context && sliderStops.length > 1 ? (
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
  return (
    <div className="runtime-settings">
      {groups
        .filter(
          ([name, , keys]) =>
            (!section || section === name) &&
            (keys.some((k) => schema[k]) || before || after),
        )
        .map(([name, title, keys]) => {
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
              {after}
            </>
          );
          return section === 'multimodal' ||
            section === 'mtp' ||
            section === 'reasoning' ? (
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
