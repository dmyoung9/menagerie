import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Field, FieldGroup } from '@/components/ui/field';
import { useEffect, useId, useState } from 'react';
import { flushSync } from 'react-dom';

/** An exact numeric editor with a bounded slider; display-only defaults stay implicit. */
export function NumberControl({
  label,
  value,
  defaultValue,
  min = 0,
  max,
  sliderMax = max ?? 1024,
  step = 1,
  inputStep = step,
  disabled = false,
  required = false,
  change,
  text,
  onTextChange,
  onBlur,
  id: suppliedId,
  describedBy,
  invalid = false,
}: {
  label: string;
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  sliderMax?: number;
  step?: number;
  inputStep?: number | 'any';
  disabled?: boolean;
  required?: boolean;
  change: (value: number | undefined) => void;
  text?: string;
  onTextChange?: (text: string) => void;
  onBlur?: () => void;
  id?: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const effective = value ?? defaultValue;
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const [buffer, setBuffer] = useState({
    value: effective,
    text: String(effective ?? ''),
  });
  if (buffer.value !== effective)
    setBuffer({ value: effective, text: String(effective ?? '') });
  const displayed = text ?? buffer.text;
  const edit = (next: string) => {
    setBuffer({ value: effective, text: next });
    onTextChange?.(next);
  };
  const lower = Math.min(min, defaultValue ?? min);
  const upper = Math.max(sliderMax, effective ?? lower, lower + step);
  return (
    <FieldGroup className="range-control">
      <Field
        orientation="horizontal"
        data-invalid={invalid}
        data-disabled={disabled}
      >
        <Slider
          aria-label={`${label} range`}
          min={lower}
          max={upper}
          step={step}
          disabled={disabled || effective === undefined}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          value={[Math.max(lower, Math.min(upper, effective ?? lower))]}
          onValueChange={(v) => {
            const next = Number(Array.isArray(v) ? v[0] : v);
            edit(String(next));
            change(next);
          }}
        />
        <Input
          aria-label={label}
          id={id}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          type="number"
          min={lower}
          max={max}
          step={inputStep}
          disabled={disabled}
          required={required}
          value={displayed}
          placeholder="Not reported"
          onChange={(e) => edit(e.target.value)}
          onInvalid={onBlur}
          onKeyDown={(event) => {
            // Native Enter submission must see the latest standalone buffer too.
            if (event.key === 'Enter' && !onTextChange) {
              event.preventDefault();
              const input = event.currentTarget;
              if (!input.reportValidity()) return;
              flushSync(() =>
                change(displayed.trim() ? Number(displayed) : undefined),
              );
              input.form?.requestSubmit();
            }
          }}
          onBlur={(event) => {
            if (!onTextChange && event.currentTarget.validity.valid)
              change(displayed.trim() ? Number(displayed) : undefined);
            onBlur?.();
          }}
        />
      </Field>
    </FieldGroup>
  );
}

/**
 * A compact exact value editor. An unset value stays visibly empty; the engine
 * default is only a placeholder, so viewing a card never creates an override.
 */
export function ExactNumber({
  label,
  value,
  placeholder = 'Engine default',
  min,
  max,
  step = 1,
  required = false,
  disabled = false,
  change,
  describedBy,
  invalid = false,
}: {
  label: string;
  value?: number;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number | 'any';
  required?: boolean;
  disabled?: boolean;
  change: (value: number | undefined) => void;
  describedBy?: string;
  invalid?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    if (!editing) setText(value === undefined ? '' : String(value));
  }, [value, editing]);
  return (
    <Input
      aria-label={label}
      type="number"
      min={min}
      max={max}
      step={step}
      required={required}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      value={text}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next.trim() === '') change(undefined);
        else if (Number.isFinite(Number(next))) change(Number(next));
      }}
      onBlur={() => {
        setEditing(false);
        const next = text.trim();
        if (next === '') change(undefined);
        else if (!Number.isFinite(Number(next)) || next.endsWith('.')) {
          setText(value === undefined ? '' : String(value));
          if (value === undefined) change(undefined);
        } else change(Number(next));
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          const input = event.currentTarget;
          if (!input.reportValidity()) return;
          flushSync(() => input.blur());
          input.form?.requestSubmit();
        }
      }}
    />
  );
}
