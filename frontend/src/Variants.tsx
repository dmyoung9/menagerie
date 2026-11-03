import { useRef, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Table as TableModel,
} from '@tanstack/react-table';
import { GripVertical, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
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
  supportsReasoning,
} from './capabilityOptions';
import { mappingSummary } from './variant-mapping';
import { VariantDrawer } from './VariantDrawer';
import type { ModelCatalog, ReasoningPreset } from './types';

type VariantActions = {
  enable: (mode: ReasoningPreset, enabled: boolean) => void;
  edit: (mode: ReasoningPreset) => void;
  move: (id: string, to: number) => void;
  remove: (id: string) => void;
  drag: (id: string | null) => void;
  nameRef: (id: string, node: HTMLButtonElement | null) => void;
};
const actions = (table: TableModel<ReasoningPreset>) =>
  table.options.meta as VariantActions;

function MappingSummary({ mode }: { mode: ReasoningPreset }) {
  return (
    <div className="reasoning-variant-summary">
      <span>
        {Object.keys(mode.body).length
          ? mappingSummary(mode.body)
          : mode.prompt_prefix
            ? 'Prompt prefix only'
            : 'Not configured'}
      </span>
      {mode.prompt_prefix && Object.keys(mode.body).length > 0 && (
        <small>Prompt prefix</small>
      )}
      {!configuredMode(mode) && mode.id !== 'default' && (
        <small>Configure to enable</small>
      )}
    </div>
  );
}

// Stable cell components preserve switch/handle focus across edits and reordering.
const columns: ColumnDef<ReasoningPreset>[] = [
  {
    id: 'enabled',
    header: 'Enabled',
    cell: ({ row, table }) => {
      const mode = row.original;
      return (
        <Switch
          aria-label={`Enable ${modeLabel(mode)} variant`}
          checked={mode.enabled}
          disabled={
            !configuredMode(mode) && mode.id !== 'default' && !mode.enabled
          }
          onCheckedChange={(enabled) => actions(table).enable(mode, enabled)}
        />
      );
    },
  },
  {
    id: 'name',
    header: 'Name',
    cell: ({ row, table }) => {
      const mode = row.original;
      return (
        <div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              draggable
              aria-label={`Reorder ${modeLabel(mode)}`}
              title="Drag to reorder, or use the variant actions menu"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', mode.id);
                actions(table).drag(mode.id);
              }}
              onDragEnd={() => actions(table).drag(null)}
              onKeyDown={(e) => {
                if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
                  e.preventDefault();
                  actions(table).move(
                    mode.id,
                    row.index + (e.key === 'ArrowUp' ? -1 : 1),
                  );
                }
              }}
            >
              <GripVertical />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="variant-name"
              ref={(node) => actions(table).nameRef(mode.id, node)}
              onClick={() => actions(table).edit(mode)}
            >
              {modeLabel(mode)}
            </Button>
          </div>
          <div className="variant-mobile-summary">
            <MappingSummary mode={mode} />
          </div>
        </div>
      );
    },
  },
  {
    id: 'configuration',
    header: 'Configuration',
    cell: ({ row }) => <MappingSummary mode={row.original} />,
  },
  {
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row, table }) => (
      <Menu label={`${modeLabel(row.original)} variant actions`}>
        <DropdownMenuItem onClick={() => actions(table).edit(row.original)}>
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={row.index === 0}
          onClick={() => actions(table).move(row.original.id, row.index - 1)}
        >
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={row.index === table.getRowModel().rows.length - 1}
          onClick={() => actions(table).move(row.original.id, row.index + 1)}
        >
          Move down
        </DropdownMenuItem>
        {!standardReasoningIds.includes(row.original.id) &&
          row.original.id !== 'default' && (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => actions(table).remove(row.original.id)}
            >
              Remove
            </DropdownMenuItem>
          )}
      </Menu>
    ),
  },
];

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
  const [dragging, setDragging] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const names = useRef<Record<string, HTMLButtonElement | null>>({});
  function write(next: ReasoningPreset[]) {
    change(setReasoningOptions(catalog, next));
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
  const meta: VariantActions = {
    enable: (mode, enabled) =>
      write(levels.map((p) => (p.id === mode.id ? { ...p, enabled } : p))),
    edit: (mode) => {
      returnFocus.current = names.current[mode.id];
      setAdding(false);
      setEditing(mode);
    },
    move,
    remove: (id) => {
      const next = setReasoningOptions(
        catalog,
        saved.filter((mode) => mode.id !== id),
      );
      if (next.reasoning.default_mode === id)
        next.reasoning.default_mode = null;
      change(next);
    },
    drag: setDragging,
    nameRef: (id, node) => {
      names.current[id] = node;
    },
  };
  // Deliberately no sorting/pagination: row order is the client-visible variant order.
  const table = useReactTable({
    data: levels,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (mode) => mode.id,
    autoResetAll: false,
    meta,
  });
  if (!supportsReasoning(catalog)) return null;
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
        <Button
          type="button"
          variant="outline"
          disabled={saved.length >= 64}
          onClick={(e) => {
            returnFocus.current = e.currentTarget;
            setAdding(true);
            setEditing({ id: '', name: '', enabled: false, body: {} });
          }}
        >
          <Plus data-icon="inline-start" />
          Add variant
        </Button>
      </div>
      <div className="variants-table rounded-md border">
        <Table aria-label="Variants">
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id}>
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-variant={row.id}
                data-dragging={dragging === row.id || undefined}
                onDragOver={(e) => {
                  if (dragging) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging) move(dragging, row.index);
                  setDragging(null);
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <p className="capability-hint">
        Switches expose variants to clients. Drag a handle to reorder, or use
        Move up / Move down in its menu.
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
