import { useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { FieldGroup } from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Textarea } from '@/components/ui/textarea';
import { NumberControl } from './NumberControl';
import { jsonObject } from './contracts';
import { Field, isRecord } from './ui';
import {
  mappingKind,
  modeLabel,
  modeSlug,
  reasoningLevels,
  reasoningOptions,
  setReasoningOptions,
  standardReasoningIds,
  validModeId,
} from './capabilityOptions';
import type { JsonObject, ModelCatalog, ReasoningPreset } from './types';

const configured = (mode: ReasoningPreset) =>
  Object.keys(mode.body).length > 0 || !!mode.prompt_prefix;

/** Keep everyday mappings compact; composite effects use the existing JSON escape hatch. */
function RequestMapping({
  mode,
  change,
  valid,
}: {
  mode: ReasoningPreset;
  change: (mode: ReasoningPreset) => void;
  valid: (ok: boolean) => void;
}) {
  const label = modeLabel(mode);
  const errorId = useId();
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState(JSON.stringify(mode.body, null, 2));
  const [error, setError] = useState('');
  const kind = custom ? 'custom' : mappingKind(mode.body);
  const kwargs = isRecord(mode.body.chat_template_kwargs)
    ? mode.body.chat_template_kwargs
    : {};
  function write(body: JsonObject) {
    setError('');
    valid(true);
    change({ ...mode, body });
  }
  function select(value: string) {
    setCustom(value === 'custom');
    setError('');
    valid(true);
    if (value === 'custom') {
      setText(JSON.stringify(mode.body, null, 2));
      return;
    }
    const effort = mode.id === 'instant' ? 'none' : mode.id;
    write(
      value === 'effort'
        ? { reasoning_effort: effort }
        : value === 'template-effort'
          ? { chat_template_kwargs: { reasoning_effort: effort } }
          : value === 'template'
            ? {
                chat_template_kwargs: {
                  enable_thinking: mode.id !== 'instant',
                },
              }
            : value
              ? { [value]: 4096 }
              : {},
    );
  }
  return (
    <FieldGroup className="mapping-controls">
      <Field label={`${label} control`}>
        <NativeSelect value={kind} onChange={(e) => select(e.target.value)}>
          <NativeSelectOption value="">Not configured</NativeSelectOption>
          <NativeSelectOption value="effort">Native effort</NativeSelectOption>
          <NativeSelectOption value="template-effort">
            Template effort
          </NativeSelectOption>
          <NativeSelectOption value="template">
            Thinking (template)
          </NativeSelectOption>
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
      </Field>
      {(kind === 'effort' || kind === 'template-effort') && (
        <Field label={`${label} effort`}>
          <Input
            required
            maxLength={128}
            value={String(
              kind === 'effort'
                ? mode.body.reasoning_effort
                : kwargs.reasoning_effort,
            )}
            onChange={(e) =>
              write(
                kind === 'effort'
                  ? { reasoning_effort: e.target.value }
                  : {
                      chat_template_kwargs: {
                        reasoning_effort: e.target.value,
                      },
                    },
              )
            }
          />
        </Field>
      )}
      {kind === 'template' && (
        <Field label={`${label} thinking`}>
          <NativeSelect
            value={String(kwargs.enable_thinking)}
            onChange={(e) =>
              write({
                chat_template_kwargs: {
                  enable_thinking: e.target.value === 'true',
                },
              })
            }
          >
            <NativeSelectOption value="true">On</NativeSelectOption>
            <NativeSelectOption value="false">Off</NativeSelectOption>
          </NativeSelect>
        </Field>
      )}
      {(kind === 'reasoning_budget' || kind === 'thinking_budget') && (
        <Field
          label={`${label} token budget`}
          hint="-1 means unlimited only when supported by the engine."
        >
          <NumberControl
            label={`${label} token budget`}
            min={-1}
            max={1048576}
            sliderMax={32768}
            required
            value={mode.body[kind] as number}
            change={(value) => write({ [kind]: value ?? 0 })}
          />
        </Field>
      )}
      {kind === 'custom' && (
        <>
          <Field label={`${label} custom settings`}>
            <Textarea
              rows={3}
              spellCheck={false}
              value={custom ? text : JSON.stringify(mode.body, null, 2)}
              aria-invalid={!!error}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => {
                setCustom(true);
                setText(e.target.value);
                try {
                  write(jsonObject(JSON.parse(e.target.value)));
                } catch {
                  setError('Enter a JSON object.');
                  valid(false);
                }
              }}
            />
          </Field>
          {error && (
            <small id={errorId} role="alert" className="error-text">
              {error}
            </small>
          )}
        </>
      )}
      {(kind === 'custom' || !!mode.prompt_prefix) && (
        <Field label={`${label} prompt prefix`}>
          <Textarea
            rows={2}
            maxLength={4096}
            placeholder="No prompt changes"
            value={mode.prompt_prefix || ''}
            onChange={(e) => change({ ...mode, prompt_prefix: e.target.value })}
          />
        </Field>
      )}
    </FieldGroup>
  );
}

export function ReasoningModes({
  catalog,
  change,
  valid,
  reasoningControls,
}: {
  catalog: ModelCatalog;
  change: (catalog: ModelCatalog) => void;
  valid: (key: string, ok: boolean) => void;
  reasoningControls?: ReactNode;
}) {
  const saved = reasoningOptions(catalog);
  const levels = reasoningLevels(catalog);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const validity = useRef<Record<string, boolean>>({});
  function report(key: string, ok: boolean) {
    validity.current[key] = ok;
    valid('reasoning-options', Object.values(validity.current).every(Boolean));
  }
  function write(next: ReasoningPreset[]) {
    change(setReasoningOptions(catalog, next));
  }
  function update(mode: ReasoningPreset) {
    const next = {
      ...mode,
      enabled: configured(mode) || mode.id === 'default' ? mode.enabled : false,
    };
    write(
      saved.some((row) => row.id === mode.id)
        ? saved.map((row) => (row.id === mode.id ? next : row))
        : [...saved, next],
    );
  }
  function remove(mode: ReasoningPreset) {
    delete validity.current[mode.id];
    report(mode.id, true);
    const next = setReasoningOptions(
      catalog,
      saved.filter((row) => row.id !== mode.id),
    );
    if (next.reasoning.default_mode === mode.id)
      next.reasoning.default_mode = null;
    change(next);
  }
  const newId = id || modeSlug(name);
  return (
    <section aria-label="Reasoning options">
      <div className="capability-heading reasoning-heading">
        <h3>Reasoning options</h3>
        <span>Select to expose</span>
      </div>
      <ToggleGroup
        multiple
        variant="primary"
        className="flex-wrap"
        aria-label="Reasoning options"
        value={saved.filter((row) => row.enabled).map((row) => row.id)}
        onValueChange={(next) =>
          write(
            saved.map((row) => ({ ...row, enabled: next.includes(row.id) })),
          )
        }
      >
        {levels.map((mode) => (
          <ToggleGroupItem
            key={mode.id}
            value={mode.id}
            disabled={
              (!configured(mode) && mode.id !== 'default' && !mode.enabled) ||
              (!saved.some((row) => row.id === mode.id) && saved.length >= 64)
            }
          >
            {modeLabel(mode)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="capability-hint">
        Configure each level's supported control below. Unconfigured levels stay
        unavailable.
      </p>
      <Field label="Default reasoning mode">
        <NativeSelect
          value={catalog.reasoning?.default_mode || ''}
          onChange={(e) =>
            change({
              ...catalog,
              reasoning: {
                ...catalog.reasoning,
                default_mode: e.target.value || null,
              },
            })
          }
        >
          <NativeSelectOption value="">
            Model default (no overrides)
          </NativeSelectOption>
          {saved.map((mode) => (
            <NativeSelectOption key={mode.id} value={mode.id}>
              {modeLabel(mode)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {reasoningControls}
      <div className="reasoning-mappings">
        {levels
          .filter((mode) => mode.id !== 'default' || configured(mode))
          .map((mode) => (
            <div
              key={mode.id}
              className="mapping-row"
              data-reasoning-mode={mode.id}
            >
              <div className="mapping-label">
                <span>{modeLabel(mode)}</span>
                {!standardReasoningIds.includes(mode.id) &&
                  mode.id !== 'default' && (
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`Remove ${modeLabel(mode)} level`}
                      onClick={() => remove(mode)}
                    >
                      Remove
                    </Button>
                  )}
              </div>
              <fieldset
                disabled={
                  !saved.some((row) => row.id === mode.id) && saved.length >= 64
                }
              >
                <legend className="sr-only">{modeLabel(mode)} mapping</legend>
                <RequestMapping
                  mode={mode}
                  change={update}
                  valid={(ok) => report(mode.id, ok)}
                />
              </fieldset>
            </div>
          ))}
      </div>
      <details>
        <summary>Add custom level</summary>
        <FieldGroup>
          <Field label="New level name">
            <Input
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="New level ID">
            <Input
              value={newId}
              maxLength={64}
              onChange={(e) => setId(e.target.value)}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={
              !name.trim() ||
              !validModeId(newId) ||
              levels.some((mode) => mode.id === newId) ||
              saved.length >= 64
            }
            onClick={() => {
              write([
                ...saved,
                { id: newId, name: name.trim(), enabled: false, body: {} },
              ]);
              setName('');
              setId('');
            }}
          >
            Add level
          </Button>
        </FieldGroup>
      </details>
    </section>
  );
}
