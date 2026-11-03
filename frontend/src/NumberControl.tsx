import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';

/** An exact numeric editor with a bounded slider; display-only defaults stay implicit. */
export function NumberControl({
  label,
  value,
  defaultValue,
  min = 0,
  max,
  sliderMax = max ?? 1024,
  step = 1,
  disabled = false,
  required = false,
  change,
}: {
  label: string;
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  sliderMax?: number;
  step?: number;
  disabled?: boolean;
  required?: boolean;
  change: (value: number | undefined) => void;
}) {
  const effective = value ?? defaultValue;
  const lower = Math.min(min, defaultValue ?? min);
  const upper = Math.max(sliderMax, effective ?? lower, lower + step);
  return (
    <div className="range-control">
      <Slider
        aria-label={`${label} range`}
        min={lower}
        max={upper}
        step={step}
        disabled={disabled || effective === undefined}
        value={[Math.max(lower, Math.min(upper, effective ?? lower))]}
        onValueChange={(v) => change(Number(Array.isArray(v) ? v[0] : v))}
      />
      <Input
        aria-label={label}
        type="number"
        min={lower}
        max={max}
        step={step}
        disabled={disabled}
        required={required}
        value={effective ?? ''}
        placeholder="Not reported"
        onChange={(e) =>
          change(e.target.value === '' ? undefined : Number(e.target.value))
        }
      />
    </div>
  );
}
