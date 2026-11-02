import { Check, HardDrive } from 'lucide-react';
import { Fragment } from 'react';
import { isRecord } from '@/ui';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FieldSet, FieldLegend } from '@/components/ui/field';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { quantization, QUANTS, SUFFIXES, byteSize } from '@/variants';
import type { Artifact } from '@/types';

export function InstalledVariants({
  models,
  selected,
  select,
}: {
  models: Artifact[];
  selected: string;
  select: (id: string) => void;
}) {
  const current = models.find((m) => m.id === selected)!;
  const choice = quantization(current.name);
  const files = (model: Artifact) => {
    const shards = model.metadata?.shards;
    if (Array.isArray(shards))
      return shards.filter(isRecord).map((s) => ({
        name: String(s.name || '—'),
        path: typeof s.path === 'string' ? s.path : '',
        size: typeof s.size === 'number' ? s.size : null,
        checksum: typeof s.sha256 === 'string' ? s.sha256 : '',
      }));
    const manifest = model.metadata?.file_sha256;
    if (isRecord(manifest))
      return Object.entries(manifest).map(([name, checksum]) => ({
        name,
        path: '',
        size: null,
        checksum: typeof checksum === 'string' ? checksum : '',
      }));
    return [];
  };
  return (
    <section className="model-section">
      <h3>Installed variants</h3>
      {(['quant', 'suffix'] as const).map((key) => {
        const common = key === 'quant' ? QUANTS : SUFFIXES;
        const options = [
          ...new Set([
            ...common,
            ...models.map((m) => quantization(m.name)[key]),
          ]),
        ];
        const installed = (v: string) =>
          models.filter(
            (m) =>
              quantization(m.name)[key] === v &&
              (key === 'quant' || quantization(m.name).quant === choice.quant),
          );
        return (
          <FieldSet key={key}>
            <FieldLegend>
              {key === 'quant' ? 'Quantization' : 'Size / quality suffix'}
            </FieldLegend>
            <ToggleGroup
              variant="outline"
              className="flex-wrap"
              aria-label={`Installed ${key}`}
              value={[choice[key]]}
              onValueChange={(next) => {
                const candidates = installed(next[0]);
                if (candidates.length)
                  select(
                    candidates.find(
                      (m) => quantization(m.name).suffix === choice.suffix,
                    )?.id || candidates[0].id,
                  );
              }}
            >
              {options.map((v) => (
                <ToggleGroupItem
                  key={v}
                  value={v}
                  disabled={!installed(v).length}
                  title={
                    installed(v).length
                      ? `${v} installed`
                      : `${v} not installed`
                  }
                >
                  {installed(v).length > 0 && <HardDrive aria-hidden="true" />}
                  {v === 'None' ? 'No suffix' : v}
                  {choice[key] === v && <Check aria-hidden="true" />}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>
        );
      })}
      <Table
        containerProps={{
          tabIndex: 0,
          role: 'region',
          'aria-label': 'Installed model files',
        }}
      >
        <TableHeader>
          <TableRow>
            <TableHead>File / variant</TableHead>
            <TableHead>Quantization</TableHead>
            <TableHead>Format</TableHead>
            <TableHead className="numeric">Size</TableHead>
            <TableHead>Checksum</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {models.map((m) => (
            <Fragment key={m.id}>
              <TableRow
                key={m.id}
                data-state={m.id === selected ? 'selected' : undefined}
              >
                <TableCell>
                  <Button
                    variant="ghost"
                    className="max-w-full whitespace-normal text-left"
                    onClick={() => select(m.id)}
                    aria-pressed={m.id === selected}
                  >
                    {m.id === selected && <Check />}
                    {m.name}
                  </Button>
                  <small className="block break-all text-muted-foreground">
                    {m.local_path}
                  </small>
                </TableCell>
                <TableCell>
                  {m.quantization ||
                    [quantization(m.name).quant, quantization(m.name).suffix]
                      .filter((s) => s !== 'None')
                      .join('_')}
                </TableCell>
                <TableCell>{m.format.toUpperCase()}</TableCell>
                <TableCell className="numeric">
                  {byteSize(m.size_bytes ?? null)}
                </TableCell>
                <TableCell>{m.sha256 ? 'Verified' : '—'}</TableCell>
              </TableRow>
              {files(m).map((f) => (
                <TableRow key={`${m.id}-${f.name}`}>
                  <TableCell>
                    <span className="pl-4 break-all">{f.name}</span>
                    {f.path && (
                      <small className="block break-all text-muted-foreground">
                        {f.path}
                      </small>
                    )}
                  </TableCell>
                  <TableCell>—</TableCell>
                  <TableCell>{m.format.toUpperCase()}</TableCell>
                  <TableCell className="numeric">{byteSize(f.size)}</TableCell>
                  <TableCell>{f.checksum ? 'Verified' : '—'}</TableCell>
                </TableRow>
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
