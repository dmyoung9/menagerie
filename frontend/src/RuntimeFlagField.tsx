import { useEffect, useId } from 'react';
import { useField, useStore, setBy } from '@tanstack/react-form';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Item, ItemActions, ItemContent } from '@/components/ui/item';
import { NumberControl } from './NumberControl';
import { useSharedDraftForm } from './use-draft-form';
import {
  commitFlagInputs,
  configAt,
  inputKey,
  type ConfigPath,
  type FormDraft,
} from './draft-form';
import { flagError, numericFlagError } from './flag-validation';
import { flagDefaultNote, runtimeFlags } from './runtime-flags';
import type { HostSnapshot, JsonValue, RuntimeField } from './types';

export function RuntimeFlagField({
  flag,
  schema,
  value,
  change,
  host,
  disabled,
  formPath,
}: {
  flag: string;
  schema: Record<string, RuntimeField>;
  value: Record<string, JsonValue>;
  change: (config: Record<string, JsonValue>) => void;
  host: HostSnapshot;
  disabled: boolean;
  formPath: ConfigPath;
}) {
  const form = useSharedDraftForm();
  const radio = flag === 'flash-attn';
  // Radios commit immediately; numeric fields retain editing text until blur.
  const name = `inputs.${inputKey(formPath, flag)}` as const;
  const validate = ({ value: input }: { value: unknown }) => {
    const state = form.state.values;
    const config = configAt(
      commitFlagInputs(state.draft as FormDraft, state.inputs),
      formPath,
    );
    return radio
      ? flagError(flag, input as JsonValue, schema, config)
      : numericFlagError(flag, String(input ?? ''), schema, config);
  };
  const field = useField({
    form,
    name,
    validators: { onBlur: validate, onSubmit: validate },
  });
  const attempts = useStore(form.store, (state) => state.submissionAttempts);
  const constraints = JSON.stringify([schema, value]);
  useEffect(() => {
    // Refresh dependent constraints, but never validate an untouched typing buffer.
    if (field.state.meta.isBlurred || attempts) void field.validate('blur');
  }, [constraints, attempts, field]);
  const id = useId();
  const label = schema[flag].label || runtimeFlags[flag].title;
  const error = field.state.meta.errors.find(
    (error) => typeof error === 'string',
  );
  const invalid = !!error;
  const describedBy = `${id}-syntax ${id}-description${invalid ? ` ${id}-error` : ''}`;
  const commit = (number: number | undefined) => {
    if (number === undefined) return;
    form.setFieldValue('draft', (draft: unknown) =>
      setBy(draft, `${formPath}.${flag}`, number),
    );
    form.setFieldValue(`inputs.${inputKey(formPath, flag)}`, String(number));
  };
  const maximum = schema[flag].max ?? Number.MAX_SAFE_INTEGER;
  return (
    <Item size="sm" role="listitem" className="flex-nowrap">
      <ItemContent className="min-w-0">
        <Field
          data-runtime-flag={flag}
          data-invalid={invalid}
          data-disabled={disabled}
        >
          <FieldTitle id={`${id}-label`}>{runtimeFlags[flag].title}</FieldTitle>
          <FieldLabel id={`${id}-syntax`} htmlFor={radio ? undefined : id}>
            <code>({runtimeFlags[flag].syntax})</code>
          </FieldLabel>
          {radio ? (
            <RadioGroup
              aria-label={label}
              aria-labelledby={`${id}-label`}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={String(field.state.value)}
              disabled={disabled}
              onBlur={field.handleBlur}
              onValueChange={(next) => {
                if (typeof next === 'string') {
                  field.handleChange(next);
                  change({ ...value, [flag]: next });
                }
              }}
              className="flex flex-wrap gap-4"
            >
              {['auto', 'on', 'off'].map((option) => (
                <Field key={option} orientation="horizontal" className="w-auto">
                  <RadioGroupItem
                    id={`${id}-${option}`}
                    value={option}
                    nativeButton
                    render={<button type="button" />}
                    disabled={
                      option === 'off' &&
                      (value['cache-type-v'] ??
                        schema['cache-type-v']?.engine_default ??
                        schema['cache-type-v']?.default ??
                        'f16') !== 'f16'
                    }
                  />
                  <FieldLabel htmlFor={`${id}-${option}`}>
                    {option === 'auto'
                      ? 'Auto'
                      : option === 'on'
                        ? 'On'
                        : 'Off'}
                  </FieldLabel>
                </Field>
              ))}
            </RadioGroup>
          ) : (
            <NumberControl
              id={id}
              label={label}
              describedBy={describedBy}
              invalid={invalid}
              value={typeof value[flag] === 'number' ? value[flag] : undefined}
              text={String(field.state.value ?? '')}
              onTextChange={(text) => field.handleChange(text)}
              onBlur={() => {
                field.handleBlur();
                if (!validate({ value: field.state.value }))
                  commit(Number(field.state.value));
              }}
              min={schema[flag].min ?? runtimeFlags[flag].min ?? 0}
              max={schema[flag].max}
              sliderMax={
                flag === 'top-k'
                  ? 200
                  : flag === 'reasoning-budget'
                    ? 32768
                    : flag.startsWith('threads') && host.cpu_count
                      ? Math.min(maximum, host.cpu_count)
                      : maximum === Number.MAX_SAFE_INTEGER
                        ? 1024
                        : maximum
              }
              step={schema[flag].type === 'number' ? 0.01 : 1}
              inputStep={schema[flag].type === 'number' ? 'any' : 1}
              required
              disabled={disabled}
              change={commit}
            />
          )}
          <FieldDescription id={`${id}-description`}>
            default: {flagDefaultNote(flag, schema[flag])}
          </FieldDescription>
          {invalid && <FieldError id={`${id}-error`}>{error}</FieldError>}
        </Field>
      </ItemContent>
      <ItemActions>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove ${label} override`}
          disabled={disabled}
          onClick={() => {
            // Delete metadata as well as the value so removed errors cannot block Save.
            form.deleteField(name);
            const next = { ...value };
            delete next[flag];
            change(next);
          }}
        >
          <Trash2 />
        </Button>
      </ItemActions>
    </Item>
  );
}
