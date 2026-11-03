import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { FieldSet, FieldLegend, FieldGroup } from '@/components/ui/field';
import { Toggle } from '@/components/ui/toggle';
import { Textarea } from '@/components/ui/textarea';
import { NumberControl } from './NumberControl';
import { JsonEdit } from './Json';
import { discoveredCapabilities, jsonObject } from './contracts';
import { Field, isRecord, readApi } from './ui';
import {
  modeLabel,
  modeSlug,
  reasoningOptions,
  reasoningSuggestions,
  setReasoningOptions,
  validModeId,
} from './capabilityOptions';
import type {
  DiscoveredCapabilities,
  JsonObject,
  JsonValue,
  ModelCatalog,
  ReasoningPreset,
  Runtime,
  TemplateSelection,
} from './types';

function ModeControls({
  mode,
  change,
  valid,
}: {
  mode: ReasoningPreset;
  change: (mode: ReasoningPreset) => void;
  valid: (ok: boolean) => void;
}) {
  const label = modeLabel(mode);
  const body = mode.body;
  const kwargs = isRecord(body.chat_template_kwargs)
    ? (body.chat_template_kwargs as JsonObject)
    : {};
  function set(key: string, value: JsonValue | undefined, template = false) {
    const next = { ...(template ? kwargs : body) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    const nextBody = template ? { ...body, chat_template_kwargs: next } : next;
    if (template && !Object.keys(next).length)
      delete nextBody.chat_template_kwargs;
    change({ ...mode, body: nextBody });
  }
  return (
    <FieldGroup>
      <div className="reasoning-control-grid">
        <Field label={`${label} thinking`}>
          <NativeSelect
            value={
              typeof kwargs.enable_thinking === 'boolean'
                ? String(kwargs.enable_thinking)
                : ''
            }
            onChange={(e) =>
              set(
                'enable_thinking',
                e.target.value === '' ? undefined : e.target.value === 'true',
                true,
              )
            }
          >
            <NativeSelectOption value="">Inherit</NativeSelectOption>
            <NativeSelectOption value="true">On</NativeSelectOption>
            <NativeSelectOption value="false">Off</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field label={`${label} native effort`}>
          <Input
            value={
              typeof body.reasoning_effort === 'string'
                ? body.reasoning_effort
                : ''
            }
            maxLength={128}
            placeholder="Inherit"
            onChange={(e) =>
              set('reasoning_effort', e.target.value || undefined)
            }
          />
        </Field>
        <Field label={`${label} template effort`}>
          <Input
            value={
              typeof kwargs.reasoning_effort === 'string'
                ? kwargs.reasoning_effort
                : ''
            }
            maxLength={128}
            placeholder="Inherit"
            onChange={(e) =>
              set('reasoning_effort', e.target.value || undefined, true)
            }
          />
        </Field>
      </div>
      <div className="reasoning-control-grid">
        {(['reasoning_budget', 'thinking_budget'] as const).map((key) => {
          const value = body[key];
          const kind = key === 'reasoning_budget' ? 'reasoning' : 'thinking';
          const budgetMode =
            value === undefined ? '' : value === -1 ? 'unlimited' : 'custom';
          return (
            <Field key={key} label={`${label} ${kind} budget`}>
              <NativeSelect
                aria-label={`${label} ${kind} budget mode`}
                value={budgetMode}
                onChange={(e) =>
                  set(
                    key,
                    e.target.value === ''
                      ? undefined
                      : e.target.value === 'unlimited'
                        ? -1
                        : 4096,
                  )
                }
              >
                <NativeSelectOption value="">Inherit</NativeSelectOption>
                <NativeSelectOption value="custom">
                  Custom tokens
                </NativeSelectOption>
                <NativeSelectOption value="unlimited">
                  Unlimited (-1; engine-dependent)
                </NativeSelectOption>
              </NativeSelect>
              {budgetMode === 'custom' && (
                <NumberControl
                  label={`${label} ${kind} tokens`}
                  min={0}
                  max={1048576}
                  sliderMax={32768}
                  required
                  value={typeof value === 'number' ? value : undefined}
                  change={(v) => set(key, v ?? 0)}
                />
              )}
            </Field>
          );
        })}
      </div>
      <Field
        label={`${label} prompt prefix`}
        hint="Optional fallback. Prepended to the latest user message only. Tags in chat history may persist; switching may require a new chat."
      >
        <Textarea
          rows={2}
          maxLength={4096}
          value={mode.prompt_prefix || ''}
          placeholder="No prompt changes"
          onChange={(e) => change({ ...mode, prompt_prefix: e.target.value })}
        />
      </Field>
      <JsonEdit
        label={`${label} template arguments (JSON)`}
        value={kwargs}
        decode={jsonObject}
        onChange={(value) =>
          change({ ...mode, body: { ...body, chat_template_kwargs: value } })
        }
        onValid={valid}
      />
      <details>
        <summary>Resolved request changes</summary>
        <pre>
          {JSON.stringify(
            {
              body,
              ...(mode.prompt_prefix
                ? { latest_user_prefix: mode.prompt_prefix }
                : {}),
            },
            null,
            2,
          )}
        </pre>
      </details>
    </FieldGroup>
  );
}

export function ReasoningModes({
  catalog,
  change,
  hints,
  runtime,
  valid,
  reasoningControls,
  artifactId,
  templateOverride,
}: {
  catalog: ModelCatalog;
  change: (catalog: ModelCatalog) => void;
  hints?: DiscoveredCapabilities;
  runtime?: Partial<Runtime>;
  valid: (key: string, ok: boolean) => void;
  reasoningControls?: ReactNode;
  artifactId?: string;
  templateOverride?: TemplateSelection | null;
}) {
  const modes = reasoningOptions(catalog);
  const hintKey = artifactId
    ? `/api/models/${encodeURIComponent(artifactId)}/reasoning-hints${templateOverride ? `?template_source=${encodeURIComponent(templateOverride.source)}&template_id=${encodeURIComponent(templateOverride.asset_id || '')}` : ''}`
    : '';
  const [detected, setDetected] = useState<{
    key: string;
    hints: DiscoveredCapabilities;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (hintKey)
      readApi(hintKey, discoveredCapabilities)
        .then((hints) => {
          if (active) setDetected({ key: hintKey, hints });
        })
        .catch(() => {
          if (active) setDetected({ key: hintKey, hints: {} });
        });
    return () => {
      active = false;
    };
  }, [hintKey]);
  const effectiveHints = hintKey
    ? detected?.key === hintKey
      ? detected.hints
      : {}
    : hints;
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
    write(modes.map((row) => (row.id === mode.id ? mode : row)));
  }
  function remove(mode: ReasoningPreset) {
    delete validity.current[mode.id];
    report(mode.id, true);
    const next = setReasoningOptions(
      catalog,
      modes.filter((row) => row.id !== mode.id),
    );
    if (next.reasoning.default_mode === mode.id)
      next.reasoning.default_mode = null;
    change(next);
  }
  function unique(base: string) {
    let result = base.slice(0, 55),
      n = 2;
    while (modes.some((m) => m.id === result))
      result = `${base.slice(0, 55)}-${n++}`;
    return result;
  }
  const newId = id || modeSlug(name);
  const suggestions = reasoningSuggestions(effectiveHints, runtime).filter(
    (mode) => !modes.some((saved) => saved.id === mode.id),
  );
  return (
    <section aria-label="Reasoning modes">
      <div className="capability-heading reasoning-heading">
        <h3>Reasoning modes</h3>
      </div>
      <p className="capability-hint">
        Model default adds no controls; it does not mean thinking is off. Modes
        combine only the controls your model template and engine support. No
        levels or Instant mode are required.
      </p>
      <Field
        label="Default reasoning mode"
        hint="Applied to requests without a selected mode; caller-supplied controls take precedence. Client Default uses this deployment default."
      >
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
          {modes.map((mode) => (
            <NativeSelectOption key={mode.id} value={mode.id}>
              {modeLabel(mode)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {reasoningControls}
      <div className="reasoning-mode-list">
        {modes.map((mode, index) => (
          <FieldSet
            key={mode.id}
            className="reasoning-mode"
            data-reasoning-mode={mode.id}
          >
            <FieldLegend>{modeLabel(mode)}</FieldLegend>
            <div className="reasoning-mode-actions">
              <Toggle
                variant="primary"
                pressed={mode.enabled}
                onPressedChange={(enabled) => update({ ...mode, enabled })}
                aria-label={`Expose ${modeLabel(mode)} to clients`}
              >
                Expose to clients
              </Toggle>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  write([
                    ...modes,
                    {
                      ...mode,
                      id: unique(`${mode.id}-copy`),
                      name: `${modeLabel(mode)} copy`.slice(0, 80),
                      enabled: false,
                    },
                  ])
                }
                disabled={modes.length >= 64}
              >
                Duplicate
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Move ${modeLabel(mode)} up`}
                disabled={index === 0}
                onClick={() => {
                  const next = [...modes];
                  [next[index - 1], next[index]] = [
                    next[index],
                    next[index - 1],
                  ];
                  write(next);
                }}
              >
                Move up
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Move ${modeLabel(mode)} down`}
                disabled={index === modes.length - 1}
                onClick={() => {
                  const next = [...modes];
                  [next[index + 1], next[index]] = [
                    next[index],
                    next[index + 1],
                  ];
                  write(next);
                }}
              >
                Move down
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => remove(mode)}
              >
                Remove
              </Button>
            </div>
            <FieldGroup>
              <Field
                label={`${modeLabel(mode)} mode name`}
                hint={`Stable client ID: ${mode.id}. Clients may display this ID instead of the name.`}
              >
                <Input
                  value={mode.name ?? modeLabel(mode)}
                  maxLength={80}
                  required
                  onChange={(e) => update({ ...mode, name: e.target.value })}
                />
              </Field>
              <ModeControls
                mode={mode}
                change={update}
                valid={(ok) => report(mode.id, ok)}
              />
            </FieldGroup>
          </FieldSet>
        ))}
      </div>
      {!modes.length && (
        <p className="capability-hint">
          No custom modes. The model keeps its own behavior.
        </p>
      )}
      <FieldSet>
        <FieldLegend>Add a reasoning mode</FieldLegend>
        <FieldGroup>
          <div className="reasoning-control-grid">
            <Field label="New mode name">
              <Input
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field
              label="New mode ID"
              hint="Stable ID used by clients. Letters, numbers, dots, hyphens and underscores; maximum 64 characters."
            >
              <Input
                value={newId}
                maxLength={64}
                onChange={(e) => setId(e.target.value)}
              />
            </Field>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={
              !name.trim() ||
              !validModeId(newId) ||
              modes.some((mode) => mode.id === newId) ||
              modes.length >= 64
            }
            onClick={() => {
              write([
                ...modes,
                { id: newId, name: name.trim(), enabled: false, body: {} },
              ]);
              setName('');
              setId('');
            }}
          >
            Add mode
          </Button>
        </FieldGroup>
      </FieldSet>
      {suggestions.length > 0 && (
        <section aria-label="Reasoning suggestions">
          <h4>Model template suggestions</h4>
          <p className="capability-hint">
            Hints from this model's recorded metadata, not proof of engine
            support. Check the selected template before adding; nothing is
            exposed automatically.
          </p>
          <div className="reasoning-mode-actions">
            {suggestions.map((mode) => (
              <Button
                type="button"
                key={mode.id}
                variant="outline"
                disabled={modes.length >= 64}
                onClick={() => write([...modes, mode])}
              >
                Add {modeLabel(mode)}
              </Button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
