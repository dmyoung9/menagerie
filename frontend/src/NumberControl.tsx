import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Field, FieldGroup } from '@/components/ui/field';
import { useId, useState } from 'react';
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
