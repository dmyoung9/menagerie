import { useRef, useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { SettingsSection } from '@/components/settings-section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Item,
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
import { FieldGroup, FieldLegend, FieldSet } from '@/components/ui/field';
import { useIsMobile } from '@/hooks/use-mobile';
import { RuntimeFlagField } from './RuntimeFlagField';
import type { ConfigPath } from './draft-form';
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
  formPath,
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
  formPath: ConfigPath;
}) {
  const [selected, setSelected] = useState<string[] | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const mobile = useIsMobile();
  const supported = keys.filter((key) => schema[key]);
  const available = supported.filter((key) => value[key] === undefined);
  const content = (key: string) => (
    <ItemContent className="min-w-0">
      <ItemTitle className="line-clamp-none">
        <span>
          <span>{runtimeFlags[key].title}</span>{' '}
          <code>({runtimeFlags[key].syntax})</code>
        </span>
      </ItemTitle>
      <ItemDescription className="mb-0 line-clamp-none">
        default: {flagDefaultNote(key, schema[key])}
      </ItemDescription>
    </ItemContent>
  );
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
      <FieldSet disabled={disabled}>
        <FieldLegend className="sr-only">{title} flags</FieldLegend>
        <FieldGroup>
          {before}
          <ItemGroup aria-label={`${title} flag items`}>
            {supported
              .filter((key) => value[key] !== undefined)
              .map((key) => (
                <RuntimeFlagField
                  key={key}
                  flag={key}
                  schema={schema}
                  value={value}
                  change={change}
                  host={host}
                  disabled={disabled}
                  formPath={formPath}
                />
              ))}
          </ItemGroup>
          {after}
        </FieldGroup>
      </FieldSet>
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
