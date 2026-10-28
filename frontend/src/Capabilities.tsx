import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldSet, FieldLegend } from '@/components/ui/field';
import { useId, useState } from 'react';
import { AudioLines, Check, Image, Video, Wrench } from 'lucide-react';
import { Field } from './ui';
import { jsonObject } from './contracts';
import type {
  DiscoveredCapabilities,
  JsonObject,
  ModelCapabilities,
  ModelCatalog,
  ReasoningPreset,
  Runtime,
} from './types';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  mappingKind,
  reasoningLabel,
  reasoningOptions,
  setReasoningOptions,
} from './capabilityOptions';
import './capabilities.css';

function RequestMapping({
  preset,
  change,
  valid,
}: {
  preset: ReasoningPreset;
  change: (body: JsonObject) => void;
  valid: (ok: boolean) => void;
}) {
  const errorId = useId();
  const [custom, setCustom] = useState(false),
    [text, setText] = useState(''),
    [error, setError] = useState('');
  const mode = custom ? 'custom' : mappingKind(preset.body || {});
  function select(value: string) {
    setError('');
    valid(true);
    setCustom(value === 'custom');
    if (value === 'custom') {
      setText(JSON.stringify(preset.body || {}, null, 2));
      return;
    }
    change(
      value === 'effort'
        ? { reasoning_effort: preset.id === 'instant' ? 'none' : preset.id }
        : value === 'template'
          ? { chat_template_kwargs: { enable_thinking: false } }
          : value
            ? { [value]: 4096 }
            : {},
    );
  }
  return (
    <div className="mapping-row">
      <span>{reasoningLabel(preset.id)}</span>
      <div>
        <NativeSelect
          aria-label={`${reasoningLabel(preset.id)} control`}
          value={mode}
          onChange={(e) => select(e.target.value)}
        >
          <NativeSelectOption value="">Not configured</NativeSelectOption>
          <NativeSelectOption value="effort">Native effort</NativeSelectOption>
          {preset.id === 'instant' && (
            <NativeSelectOption value="template">
              Thinking off (template)
            </NativeSelectOption>
          )}
          <NativeSelectOption value="reasoning_budget">
            Reasoning token budget
          </NativeSelectOption>
          <NativeSelectOption value="thinking_budget">
            Thinking token budget
          </NativeSelectOption>
          <NativeSelectOption value="custom">
            Custom request settings
          </NativeSelectOption>
        </NativeSelect>
        {['reasoning_budget', 'thinking_budget'].includes(mode) && (
          <Input
            aria-label={`${reasoningLabel(preset.id)} token budget`}
            type="number"
            min={0}
            max={1048576}
            required
            value={
              typeof preset.body[mode] === 'number' ? preset.body[mode] : ''
            }
            onChange={(e) => change({ [mode]: Number(e.target.value) })}
          />
        )}
        {mode === 'custom' && (
          <Textarea
            aria-label={`${reasoningLabel(preset.id)} custom settings`}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
            rows={3}
            spellCheck={false}
            value={custom ? text : JSON.stringify(preset.body, null, 2)}
            onChange={(e) => {
              setCustom(true);
              setText(e.target.value);
              try {
                const body: unknown = JSON.parse(e.target.value);
                change(jsonObject(body));
                setError('');
                valid(true);
              } catch {
                setError('Enter a JSON object.');
                valid(false);
              }
            }}
          />
        )}
        {error && (
          <small id={errorId} className="error-text" role="alert">
            {error}
          </small>
        )}
      </div>
    </div>
  );
}

export function Capabilities({
  catalog,
  change,
  hints,
  runtime,
  valid,
}: {
  catalog: ModelCatalog;
  change: (v: ModelCatalog) => void;
  hints?: DiscoveredCapabilities;
  runtime?: Partial<Runtime>;
  valid: (key: string, ok: boolean) => void;
}) {
  const model = catalog.model || {};
  const caps = {
    tools: false,
    input: ['text'],
    output: ['text'],
    ...model.capabilities,
  };
  const options = reasoningOptions(catalog, hints, runtime);
  const update = (value: Partial<ModelCapabilities>) =>
    change({
      ...catalog,
      model: { ...model, capabilities: { ...caps, ...value } },
    });
  const writeOptions = (next: ReasoningPreset[]) =>
    change(setReasoningOptions(catalog, next));
  const unavailable = options.filter(
    (p) => p.id !== 'default' && !Object.keys(p.body || {}).length,
  );
  const [advanced, setAdvanced] = useState(false);
  const features = [
    { id: 'tools', label: 'Tools', icon: Wrench },
    { id: 'image', label: 'Images', icon: Image },
    { id: 'audio', label: 'Audio', icon: AudioLines },
    { id: 'video', label: 'Video', icon: Video },
  ];
  return (
    <section
      className="capabilities-panel"
      aria-label="Capabilities and reasoning"
    >
      <div className="capability-heading">
        <h3>Capabilities</h3>
        <span>Available to clients</span>
      </div>
      <ToggleGroup
        multiple
        variant="outline"
        className="flex-wrap"
        aria-label="Input capabilities"
        value={features
          .filter((f) =>
            f.id === 'tools' ? caps.tools : caps.input.includes(f.id),
          )
          .map((f) => f.id)}
        onValueChange={(next) =>
          update({
            tools: next.includes('tools'),
            input: [
              ...caps.input.filter(
                (id: string) => !features.some((f) => f.id === id),
              ),
              ...next.filter((id) => id !== 'tools'),
            ],
          })
        }
      >
        {features.map(({ id, label, icon: Icon }) => {
          const selected =
            id === 'tools' ? caps.tools : caps.input.includes(id);
          return (
            <ToggleGroupItem key={id} value={id}>
              <Icon />
              {label}
              {selected && <Check />}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      <div className="capability-heading reasoning-heading">
        <h3>Reasoning options</h3>
        <span>Select to expose</span>
      </div>
      <ToggleGroup
        multiple
        variant="outline"
        className="flex-wrap"
        aria-label="Reasoning options"
        value={options.filter((p) => p.enabled).map((p) => p.id)}
        onValueChange={(next) =>
          writeOptions(
            options.map((row) => ({ ...row, enabled: next.includes(row.id) })),
          )
        }
      >
        {options.map((p) => {
          const available =
            p.id === 'default' || Object.keys(p.body || {}).length > 0;
          return (
            <ToggleGroupItem
              key={p.id}
              value={p.id}
              disabled={!available}
              title={p.source}
            >
              {reasoningLabel(p.id)}
              {p.enabled && <Check />}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      {unavailable.length > 0 && (
        <p className="capability-hint">
          {unavailable.length === 4
            ? 'Reasoning controls not detected.'
            : `${unavailable.map((p) => reasoningLabel(p.id)).join(', ')} not configured.`}{' '}
          <Button
            variant="ghost"
            type="button"
            onClick={() => setAdvanced(true)}
          >
            Set up
          </Button>
        </p>
      )}
      <div className="capability-limit">
        <Field label="Max output tokens">
          <Input
            type="number"
            min={1}
            value={model.limit?.output ?? ''}
            placeholder="Default"
            onChange={(e) => {
              const limit = { ...model.limit };
              if (e.target.value) limit.output = Number(e.target.value);
              else delete limit.output;
              change({ ...catalog, model: { ...model, limit } });
            }}
          />
        </Field>
      </div>
      <details
        className="capability-advanced"
        open={advanced}
        onToggle={(e) => setAdvanced(e.currentTarget.open)}
      >
        <summary>Advanced capabilities</summary>
        <p className="capability-hint">
          Only configure controls your engine supports. Default leaves its
          behavior unchanged; Instant must turn thinking off.
        </p>
        <label className="check">
          <Checkbox
            checked={
              typeof caps.reasoning === 'object' && !!caps.reasoning.supported
            }
            onCheckedChange={(checked) =>
              update({ reasoning: { supported: checked } })
            }
          />
          Model returns reasoning
        </label>
        <div className="reasoning-mappings">
          {options
            .filter((p) => p.id !== 'default')
            .map((p) => (
              <RequestMapping
                key={p.id}
                preset={p}
                change={(body) => {
                  valid('reasoning-' + p.id, true);
                  writeOptions(
                    options.map((row) =>
                      row.id === p.id
                        ? {
                            ...row,
                            body,
                            enabled: Object.keys(body).length
                              ? row.enabled
                              : false,
                          }
                        : row,
                    ),
                  );
                }}
                valid={(ok) => valid('reasoning-' + p.id, ok)}
              />
            ))}
        </div>
        <FieldSet className="output-capabilities">
          <FieldLegend>Output formats</FieldLegend>
          <ToggleGroup
            multiple
            variant="outline"
            className="flex-wrap"
            aria-label="Output formats"
            value={caps.output}
            onValueChange={(next) => {
              if (next.length) update({ output: next });
            }}
          >
            {['text', 'image', 'audio', 'video'].map((m) => (
              <ToggleGroupItem
                key={m}
                value={m}
                disabled={caps.output.length === 1 && caps.output.includes(m)}
              >
                {reasoningLabel(m)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </FieldSet>
        {hints && (
          <div className="capability-evidence">
            <span>Model metadata</span>
            <p>
              {hints.evidence?.join('; ') ||
                'No conclusive capability metadata.'}
            </p>
            {!!hints.dependencies?.length && (
              <p>
                Companion candidates:{' '}
                {hints.dependencies?.map((d) => d.name).join(', ')}
              </p>
            )}
          </div>
        )}
      </details>
    </section>
  );
}
