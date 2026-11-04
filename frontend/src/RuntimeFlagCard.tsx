import { useId, useRef, useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SettingsSection } from '@/components/settings-section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Field, FieldLabel } from '@/components/ui/field';
import { useIsMobile } from '@/hooks/use-mobile';
import { NumberControl } from './NumberControl';
import { flagDefault, flagDefaultNote, runtimeFlags } from './runtime-flags';
import type { HostSnapshot, JsonValue, RuntimeField } from './types';

export function RuntimeFlagCard({
  name,
  title,
  keys,
  schema,
  value,
  change,
  host,
  disabled,
  before,
  after,
}: {
  name: string;
  title: string;
  keys: string[];
  schema: Record<string, RuntimeField>;
  value: Record<string, JsonValue>;
  change: (value: Record<string, JsonValue>) => void;
  host: HostSnapshot;
  disabled: boolean;
  before?: ReactNode;
  after?: ReactNode;
}) {
  const [selected, setSelected] = useState<string[] | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const mobile = useIsMobile();
  const id = useId();
  const supported = keys.filter((key) => schema[key]);
  const available = supported.filter((key) => value[key] === undefined);
  const update = (key: string, nextValue: JsonValue | undefined) => {
    const next = { ...value };
    if (nextValue === undefined) delete next[key];
    else next[key] = nextValue;
    change(next);
  };
  const content = (key: string) => (
    <ItemContent className="min-w-0">
      <ItemTitle className="line-clamp-none">
        {runtimeFlags[key].title}
      </ItemTitle>
      <ItemDescription className="mb-0 line-clamp-none">
        <code>{runtimeFlags[key].syntax}</code> · Engine default:{' '}
        {flagDefaultNote(key, schema[key])}
      </ItemDescription>
    </ItemContent>
  );
  function control(key: string) {
    const field = schema[key];
    const label = field.label || runtimeFlags[key].title;
    if (key === 'flash-attn')
      return (
        <RadioGroup
          aria-label={label}
          value={String(value[key])}
          disabled={disabled}
          onValueChange={(v) => {
            if (typeof v === 'string') update(key, v);
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
                    schema['cache-type-v']?.default ??
                    'f16') !== 'f16'
                }
              />
              <FieldLabel htmlFor={`${id}-${option}`}>
                {option === 'auto' ? 'Auto' : option === 'on' ? 'On' : 'Off'}
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      );
    const min = runtimeFlags[key].min ?? field.min ?? 0;
    const fieldMax = field.max ?? Number.MAX_SAFE_INTEGER;
    const max =
      key === 'ubatch-size'
        ? Math.min(
            fieldMax,
            Number(
              value['batch-size'] ?? flagDefault('batch-size', schema, value),
            ),
          )
        : fieldMax;
    return (
      <NumberControl
        label={label}
        value={typeof value[key] === 'number' ? value[key] : undefined}
        min={min}
        max={max}
        sliderMax={
          key === 'top-k'
            ? 200
            : key === 'reasoning-budget'
              ? 32768
              : key.startsWith('threads') && host.cpu_count
                ? Math.min(max, host.cpu_count)
                : max === Number.MAX_SAFE_INTEGER
                  ? 1024
                  : max
        }
        step={field.type === 'number' ? 0.01 : 1}
        inputStep={field.type === 'number' ? 'any' : 1}
        required
        disabled={disabled}
        // A blank required value stays in the draft, keeping the item mounted
        // and the form dirty. Native validation prevents saving until replaced.
        change={(v) => update(key, v ?? null)}
      />
    );
  }
  return (
    <SettingsSection
      name={name}
      title={title}
      action={
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Add ${name} flags`}
          disabled={disabled || !available.length}
          onClick={() => setSelected([])}
        >
          <Plus data-icon="inline-start" />
          Add
        </Button>
      }
    >
      {before}
      <ItemGroup aria-label={`${title} flags`}>
        {supported
          .filter((key) => value[key] !== undefined)
          .map((key) => (
            <Item
              key={key}
              size="sm"
              role="listitem"
              className="runtime-flag-item"
            >
              {content(key)}
              <ItemActions>
                {control(key)}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${schema[key].label || runtimeFlags[key].title} override`}
                  disabled={disabled}
                  onClick={() => update(key, undefined)}
                >
                  <Trash2 />
                </Button>
              </ItemActions>
            </Item>
          ))}
      </ItemGroup>
      {after}
      {selected !== null && (
        <Drawer
          open
          swipeDirection={mobile ? 'down' : 'right'}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <DrawerContent finalFocus={trigger}>
            <DrawerHeader>
              <DrawerTitle>Add {name} flags</DrawerTitle>
            </DrawerHeader>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
              <ItemGroup aria-label={`Available ${name} flags`}>
                {available.map((key) => (
                  <Item
                    key={key}
                    size="default"
                    role="listitem"
                    render={<label />}
                  >
                    <ItemMedia>
                      <Checkbox
                        aria-label={
                          schema[key].label || runtimeFlags[key].title
                        }
                        checked={selected.includes(key)}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          setSelected((previous) =>
                            checked
                              ? [...(previous || []), key]
                              : (previous || []).filter((k) => k !== key),
                          )
                        }
                      />
                    </ItemMedia>
                    {content(key)}
                  </Item>
                ))}
              </ItemGroup>
            </div>
            <DrawerFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSelected(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={disabled || !selected.length}
                onClick={() => {
                  const next = { ...value };
                  for (const key of selected)
                    if (available.includes(key))
                      next[key] = flagDefault(key, schema, value);
                  change(next);
                  setSelected(null);
                }}
              >
                Add ({selected.length})
              </Button>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      )}
    </SettingsSection>
  );
}
