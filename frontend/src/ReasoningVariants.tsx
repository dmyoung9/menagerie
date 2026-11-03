import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemActions,
} from '@/components/ui/item';
import { SettingsSection } from '@/components/settings-section';
import { Field, Menu } from './ui';
import {
  configuredMode,
  modeLabel,
  newModeId,
  reasoningLevels,
  reasoningOptions,
  setReasoningOptions,
  standardReasoningIds,
} from './capabilityOptions';
import { VariantDrawer } from './VariantDrawer';
import type { ModelCatalog, ReasoningPreset } from './types';

export function Variants({
  catalog,
  change,
}: {
  catalog: ModelCatalog;
  change: (catalog: ModelCatalog) => void;
}) {
  const levels = reasoningLevels(catalog);
  const saved = reasoningOptions(catalog);
  const [editing, setEditing] = useState<ReasoningPreset | null>(null);
  const [adding, setAdding] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  const names = useRef<Record<string, HTMLButtonElement | null>>({});
  function write(next: ReasoningPreset[]) {
    change(setReasoningOptions(catalog, next));
  }
  function edit(mode: ReasoningPreset) {
    returnFocus.current = names.current[mode.id];
    setAdding(false);
    setEditing(mode);
  }
  function remove(id: string) {
    const next = setReasoningOptions(
      catalog,
      saved.filter((mode) => mode.id !== id),
    );
    if (next.reasoning.default_mode === id) next.reasoning.default_mode = null;
    change(next);
  }
  function move(id: string, to: number) {
    const from = levels.findIndex((mode) => mode.id === id);
    if (from < 0 || to < 0 || to >= levels.length || to === from) return;
    const next = [...levels];
    const [mode] = next.splice(from, 1);
    next.splice(to, 0, mode);
    write(next);
    setAnnouncement(
      `${modeLabel(mode)} moved to position ${to + 1} of ${next.length}.`,
    );
  }
  return (
    <SettingsSection
      name="variants"
      title="Variants"
      description="Named reasoning and prompt configurations exposed to clients. Enable only controls supported by your runtime."
    >
      <div className="variants-toolbar">
        <Field
          label="Default variant"
          hint="Used when a request does not select a variant. It may remain disabled for client selection."
        >
          <NativeSelect
            value={catalog.reasoning?.default_mode || ''}
            onChange={(e) => {
              const next = setReasoningOptions(catalog, levels);
              next.reasoning.default_mode = e.target.value || null;
              change(next);
            }}
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
        <Button
          type="button"
          variant="outline"
          disabled={saved.length >= 64}
          onClick={(e) => {
            returnFocus.current = e.currentTarget;
            setAdding(true);
            setEditing({
              id: '',
              name: '',
              enabled: false,
              body: { reasoning_effort: 'medium' },
            });
          }}
        >
          <Plus data-icon="inline-start" />
          Add variant
        </Button>
      </div>
      <ItemGroup aria-label="Variants">
        {levels.map((mode, index) => (
          <Item
            key={mode.id}
            role="listitem"
            variant="outline"
            size="sm"
            className="flex-nowrap"
            data-variant={mode.id}
          >
            <ItemContent className="min-w-0">
              <ItemTitle className="w-full min-w-0 line-clamp-none">
                <Button
                  type="button"
                  variant="ghost"
                  className="variant-name shrink"
                  ref={(node) => {
                    names.current[mode.id] = node;
                  }}
                  onClick={() => edit(mode)}
                >
                  {modeLabel(mode)}
                </Button>
                {!standardReasoningIds.includes(mode.id) &&
                  mode.id !== 'default' && (
                    <Badge variant="secondary" className="ml-auto">
                      Custom
                    </Badge>
                  )}
              </ItemTitle>
            </ItemContent>
            <ItemActions className="shrink-0">
              <Switch
                aria-label={`Enable ${modeLabel(mode)} variant`}
                checked={mode.enabled}
                disabled={
                  !configuredMode(mode) &&
                  mode.id !== 'default' &&
                  !mode.enabled
                }
                onCheckedChange={(enabled) =>
                  write(
                    levels.map((p) =>
                      p.id === mode.id ? { ...p, enabled } : p,
                    ),
                  )
                }
              />
              <Menu label={`${modeLabel(mode)} variant actions`}>
                <DropdownMenuItem onClick={() => edit(mode)}>
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={index === 0}
                  onClick={() => move(mode.id, index - 1)}
                >
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={index === levels.length - 1}
                  onClick={() => move(mode.id, index + 1)}
                >
                  Move down
                </DropdownMenuItem>
                {!standardReasoningIds.includes(mode.id) &&
                  mode.id !== 'default' && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => remove(mode.id)}
                    >
                      Remove
                    </DropdownMenuItem>
                  )}
              </Menu>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <p className="capability-hint">
        Switches expose variants to clients. Use each variant’s menu to edit or
        change its order.
      </p>
      {editing && (
        <VariantDrawer
          initial={editing}
          adding={adding}
          returnFocus={returnFocus}
          close={() => setEditing(null)}
          apply={(mode) => {
            write(
              adding
                ? [
                    ...saved,
                    { ...mode, id: newModeId(modeLabel(mode), catalog) },
                  ]
                : levels.map((p) => (p.id === mode.id ? mode : p)),
            );
            setEditing(null);
          }}
        />
      )}
    </SettingsSection>
  );
}
