import { FieldGroup, FieldSet, FieldLegend } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Field } from './ui';
import type { JsonValue, RuntimeField } from './types';

export function DraftTokenRange({
  schema,
  value,
  keys,
  disabled,
  change,
}: {
  schema: Record<string, RuntimeField>;
  value: Record<string, JsonValue>;
  keys: [string, string];
  disabled: boolean;
  change: (value: Record<string, JsonValue>) => void;
}) {
  const fields = keys.map((key) => schema[key]);
  const values = keys.map((key, i) =>
    typeof value[key] === 'number' ? value[key] : fields[i].engine_default,
  );
  const [minimum, maximum] = values;
  const known = minimum !== undefined && maximum !== undefined;
  const invalid = known && minimum > maximum;
  const lower = fields[0].min ?? 0;
  const upper = Math.min(
    fields[1].max ?? 1048576,
    Math.max(32, minimum ?? lower, maximum ?? lower, lower + 1),
  );
  const update = (index: number, next: number | undefined) => {
    const config = { ...value };
    if (next === undefined) delete config[keys[index]];
    else config[keys[index]] = next;
    change(config);
  };
  const labels = ['Minimum draft tokens', 'Maximum draft tokens'];
  return (
    <FieldSet>
      <FieldLegend>Draft tokens</FieldLegend>
      <FieldGroup>
        <Slider
          value={[minimum ?? lower, maximum ?? lower]}
          min={lower}
          max={upper}
          step={1}
          thumbLabels={labels.map((label) => `${label} range`)}
          thumbCollisionBehavior="none"
          disabled={disabled || !known || invalid}
          onValueChange={(range, details) => {
            if (!Array.isArray(range)) return;
            const index = details.activeThumbIndex;
            const next = Math.min(
              fields[index].max ?? upper,
              Math.max(fields[index].min ?? lower, range[index]),
            );
            update(index, next);
          }}
        />
        <FieldGroup className="grid grid-cols-2 gap-4">
          {keys.map((key, index) => (
            <Field key={key} label={labels[index]}>
              <Input
                aria-label={labels[index]}
                type="number"
                step={1}
                disabled={disabled}
                min={
                  index === 1
                    ? Math.max(fields[1].min ?? lower, minimum ?? lower)
                    : lower
                }
                max={
                  index === 0
                    ? Math.min(
                        fields[0].max ?? upper,
                        maximum ?? fields[0].max ?? upper,
                      )
                    : fields[1].max
                }
                value={values[index] ?? ''}
                placeholder="Not reported"
                aria-invalid={invalid || undefined}
                onChange={(e) =>
                  update(
                    index,
                    e.target.value === '' ? undefined : Number(e.target.value),
                  )
                }
              />
            </Field>
          ))}
        </FieldGroup>
        {invalid && (
          <p role="alert" className="error-text">
            Minimum draft tokens must not exceed maximum draft tokens.
          </p>
        )}
      </FieldGroup>
    </FieldSet>
  );
}
