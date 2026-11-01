import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { telemetryStale } from './ui';
import { useEffect, useState } from 'react';
import { memory, bytes, budgetLabel } from '@/lib/formatters';
import { capacityAccounting } from '@/lib/capacity-accounting';
import { CapacityBar } from '@/components/charts/capacity-bar';
import type {
  Deployment,
  GpuSnapshot,
  HostSettings,
  HostSnapshot,
  ResourcePreview,
} from './types';

type Tile = {
  id: string;
  label: string;
  mib: number;
  group?: string;
  detail?: string;
  href?: string;
  kind?: string;
};
type Rect = Tile & { x: number; y: number; w: number; h: number };
function layout(tiles: Tile[], x = 0, y = 0, w = 100, h = 100): Rect[] {
  if (!tiles.length) return [];
  if (tiles.length === 1) return [{ ...tiles[0], x, y, w, h }];
  const total = tiles.reduce((n, t) => n + t.mib, 0);
  let split = 1,
    sum = tiles[0].mib;
  while (split < tiles.length - 1 && sum + tiles[split].mib / 2 < total / 2)
    sum += tiles[split++].mib;
  const ratio = sum / total;
  return w >= h
    ? [
        ...layout(tiles.slice(0, split), x, y, w * ratio, h),
        ...layout(tiles.slice(split), x + w * ratio, y, w * (1 - ratio), h),
      ]
    : [
        ...layout(tiles.slice(0, split), x, y, w, h * ratio),
        ...layout(tiles.slice(split), x, y + h * ratio, w, h * (1 - ratio)),
      ];
}
function tileColor(tile: Tile) {
  if (tile.kind === 'free') return 'var(--muted)';
  if (tile.kind === 'reserve') return 'var(--chart-3)';
  if (tile.kind === 'external') return 'var(--secondary)';
  if (tile.kind === 'overflow') return 'var(--destructive)';
  const index =
    [...(tile.group || tile.id)].reduce(
      (n, c) => (n * 31 + c.charCodeAt(0)) % 997,
      0,
    ) % 5;
  return `var(--chart-${index + 1})`;
}
export function ResourceMap({
  title,
  total,
  tiles,
  summary,
  budget,
}: {
  title: string;
  total: number;
  tiles: Tile[];
  summary?: string;
  budget?: number;
}) {
  const [selected, setSelected] = useState('');
  const valid = tiles.filter((t) => Number.isFinite(t.mib) && t.mib > 0);
  const chosen = valid.find((t) => t.id === selected);
  return (
    <section className="resource-card">
      <div className="section-heading">
        <h3>{title}</h3>
        <span>
          {memory(total)} physical capacity
          {budget !== undefined && ` · ${memory(budget)} map budget`}
        </span>
      </div>
      {summary && <p className="resource-verdict">{summary}</p>}
      <div
        className="resource-map"
        role="group"
        aria-label={title + ' resource breakdown'}
      >
        {layout(valid).map((t) => (
          <Button
            variant="ghost"
            type={t.href ? undefined : 'button'}
            render={t.href ? <a href={t.href} /> : undefined}
            nativeButton={!t.href}
            role={t.href ? 'link' : undefined}
            key={t.id}
            className={'resource-tile ' + (t.kind || '')}
            style={{
              left: t.x + '%',
              top: t.y + '%',
              width: t.w + '%',
              height: t.h + '%',
              backgroundColor: t.kind
                ? undefined
                : `color-mix(in oklch, ${tileColor(t)} 28%, var(--background))`,
            }}
            aria-label={`${t.label}: ${memory(t.mib)}${t.detail ? '. ' + t.detail : ''}`}
            aria-pressed={t.href ? undefined : selected === t.id}
            title={`${t.label}: ${memory(t.mib)}${t.detail ? '\n' + t.detail : ''}`}
            onClick={() => {
              if (!t.href) setSelected(t.id);
            }}
          >
            <span>{t.label}</span>
            <strong>{memory(t.mib)}</strong>
          </Button>
        ))}
      </div>
      <div className="resource-legend">
        {valid.map((t) => (
          <Button
            variant="ghost"
            type={t.href ? undefined : 'button'}
            render={t.href ? <a href={t.href} /> : undefined}
            nativeButton={!t.href}
            role={t.href ? 'link' : undefined}
            key={t.id}
            aria-pressed={t.href ? undefined : selected === t.id}
            onClick={() => {
              if (!t.href) setSelected(t.id);
            }}
          >
            <i style={{ background: tileColor(t) }} />
            {t.label}
            <b>{memory(t.mib)}</b>
          </Button>
        ))}
      </div>
      {chosen && (
        <p className="resource-inspector" role="status">
          <strong>
            {chosen.label}: {memory(chosen.mib)}.
          </strong>{' '}
          {chosen.detail}{' '}
          {chosen.href && <a href={chosen.href}>Open deployment →</a>}
        </p>
      )}
    </section>
  );
}

export function DraftResources({
  preview,
  error,
}: {
  preview?: ResourcePreview;
  error?: string;
}) {
  return (
    <Card
      role="complementary"
      className="draft-resources"
      aria-label="Deployment resource preview"
    >
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle role="heading" aria-level={2}>
          Resource preview
        </CardTitle>
        <Badge variant="secondary">Advisory · no reservation</Badge>
      </CardHeader>
      <CardContent>
        {!preview ? (
          <p className="muted" role="status">
            {error
              ? 'Preview unavailable: ' + error
              : 'Calculating draft budget…'}
          </p>
        ) : (
          <>
            {!preview.gpus.length && (
              <p className="warning">
                GPU capacity unavailable. Select a GPU with telemetry before
                relying on this preview.
              </p>
            )}
            {preview.gpus.map((g) => {
              const tiles: Tile[] = [
                {
                  id: 'used',
                  label: 'Already in use',
                  mib: g.used_mib ?? 0,
                  kind: 'external',
                },
                {
                  id: 'reserve',
                  label: 'Safety headroom',
                  mib: g.headroom_mib,
                  kind: 'reserve',
                },
              ];
              if (
                g.total_mib !== null &&
                g.free_mib !== null &&
                g.used_mib !== null &&
                g.total_mib > g.used_mib + g.free_mib
              )
                tiles.push({
                  id: 'unavailable',
                  label: 'Unattributed capacity',
                  mib: g.total_mib - g.used_mib - g.free_mib,
                  kind: 'external',
                  detail:
                    'Physical capacity minus reported used and free; not assigned to a model.',
                });
              preview.members
                .filter((m) => m.gpu === g.index)
                .forEach((m) => {
                  const e = m.estimate;
                  const name =
                    preview.members.filter((peer) => peer.name === m.name)
                      .length > 1
                      ? `${m.name} (${Number(m.key) + 1})`
                      : m.name;
                  Object.entries(
                    e.components || { 'Observed peak': e.peak_mib ?? 0 },
                  ).forEach(([label, mib]) =>
                    tiles.push({
                      id: m.key + label,
                      group: m.name + m.key,
                      label: `${name} · ${label}`,
                      mib: Number(mib),
                      detail: `${e.basis} · ${e.sample_count} runs. ${e.provenance}`,
                    }),
                  );
                });
              tiles.push({
                id: 'free',
                label: 'Remaining',
                mib: Math.max(0, g.remaining_mib ?? 0),
                kind: 'free',
              });
              return (
                <div key={g.index}>
                  {g.total_mib !== null &&
                  g.used_mib !== null &&
                  g.free_mib !== null &&
                  g.draft_mib !== null ? (
                    <>
                      <CapacityBar
                        budget={Math.max(0, g.total_mib - g.headroom_mib)}
                        components={tiles.filter(
                          (t) => t.id !== 'reserve' && t.id !== 'free',
                        )}
                      />
                      <ResourceMap
                        title={`GPU ${g.index} · ${g.name}`}
                        total={g.total_mib}
                        budget={Math.max(0, g.total_mib - g.headroom_mib)}
                        tiles={
                          capacityAccounting(
                            Math.max(0, g.total_mib - g.headroom_mib),
                            tiles.filter(
                              (t) => t.id !== 'reserve' && t.id !== 'free',
                            ),
                          ).tiles
                        }
                        summary={`${budgetLabel(g.remaining_mib)} · ${memory(g.free_mib)} free · ${memory(g.headroom_mib)} safety headroom (not reserved)`}
                      />
                    </>
                  ) : (
                    <p>
                      GPU {g.index}: accounting unavailable ·{' '}
                      {memory(g.free_mib)} free
                    </p>
                  )}
                </div>
              );
            })}
            {preview.members
              .filter((m) => !preview.gpus.some((g) => g.index === m.gpu))
              .map((m) => (
                <p className="warning" key={m.key}>
                  {m.name}: selected GPU {m.gpu} has no capacity telemetry.
                </p>
              ))}
            <p className="muted">
              System RAM: {memory(preview.ram_available_mib)} available ·{' '}
              {memory(preview.ram_headroom_mib)} safety headroom ·{' '}
              {memory(preview.ram_draft_mib)} proposed RSS/offload ·{' '}
              {budgetLabel(preview.ram_remaining_mib)}. CPU offload is slower
              than GPU-resident inference.
            </p>
            {preview.ram_available_mib !== null &&
              preview.ram_draft_mib !== null && (
                <CapacityBar
                  budget={Math.max(
                    0,
                    preview.ram_available_mib - preview.ram_headroom_mib,
                  )}
                  components={[
                    {
                      id: 'ram',
                      label: 'Proposed RAM',
                      mib: preview.ram_draft_mib,
                    },
                  ]}
                />
              )}
            {preview.ram_available_mib !== null &&
              preview.ram_available_mib < preview.ram_headroom_mib && (
                <p className="warning">
                  Host RAM is below the headroom gate. Loading is blocked until
                  memory is available.
                </p>
              )}
            {telemetryStale(
              { ts: preview.sample_ts ?? undefined },
              preview.sample_seconds,
            ) && (
              <p className="warning">
                Capacity telemetry is stale or unavailable. Refresh before
                relying on this budget.
              </p>
            )}
            {preview.members.map((m) => (
              <p className="muted" key={m.key}>
                {m.name}: {m.estimate.basis} peak {memory(m.estimate.peak_mib)}{' '}
                · file {bytes(m.estimate.file_size_bytes)} ·{' '}
                {m.estimate.sample_count} runs. {m.estimate.provenance}
              </p>
            ))}
            <small className="muted">{preview.note}</small>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function LiveResources({
  host,
  deployments,
  settings,
}: {
  host: HostSnapshot;
  deployments: Deployment[];
  settings: Partial<HostSettings>;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const stale = telemetryStale(host, settings?.sample_seconds, now);
  return (
    <Card className="mb-5 min-w-0 live-resources">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle role="heading" aria-level={2}>
          Where your resources go
        </CardTitle>
        <Badge variant="secondary">
          {stale ? 'Telemetry stale / unavailable' : 'Live · observed'}
        </Badge>
      </CardHeader>
      <CardContent>
        <p className="muted">
          Open a deployment from its block or label. Process totals are
          observed; internal weights, KV cache and projector components are
          unavailable without runtime instrumentation. Safety headroom is a
          policy limit, not reserved memory.
        </p>
        <div className="resource-grid">
          {(host.gpus || []).map((g: GpuSnapshot) => {
            if (typeof g.used_mib !== 'number' || !g.total_mib)
              return (
                <p key={g.index}>
                  GPU {g.index}: memory telemetry unavailable.
                </p>
              );
            // Prefer device-attributed process samples; aggregate-only samples are safe on one GPU only.
            const tracked: Tile[] = deployments.flatMap((d) => {
              const metrics = host.deployments?.[d.id];
              const mib =
                metrics?.gpu_by_device_mib?.[String(g.index)] ??
                (host.gpus?.length === 1 ? metrics?.gpu_mib : null);
              return typeof mib === 'number' && mib > 0
                ? [
                    {
                      id: d.id,
                      group: d.unit_id || d.id,
                      label: d.name,
                      mib,
                      href: '#/deployments/' + (d.unit_id || d.id),
                      detail:
                        'Observed process VRAM; internal weights/cache split is not measured.',
                    },
                  ]
                : [];
            });
            const attributed = tracked.reduce((n, t) => n + t.mib, 0);
            const consistent = attributed <= g.used_mib;
            const tiles: Tile[] = consistent ? tracked : [];
            const free = g.free_mib;
            tiles.push(
              {
                id: 'external',
                label: 'Other / unattributed',
                mib: g.used_mib - (consistent ? attributed : 0),
                kind: 'external',
                detail:
                  'Desktop, external processes, or memory that cannot be reliably attributed.',
              },
              {
                id: 'free',
                label: free == null ? 'Unattributed capacity' : 'Free',
                mib: free ?? Math.max(0, g.total_mib - g.used_mib),
                kind: free == null ? 'external' : 'free',
                detail:
                  free == null
                    ? 'Capacity minus reported used. Free telemetry is unavailable; this is not measured free memory.'
                    : 'Device-reported unallocated memory.',
              },
            );
            if (free != null && g.total_mib > g.used_mib + free)
              tiles.push({
                id: 'unavailable',
                label: 'Unattributed capacity',
                mib: g.total_mib - g.used_mib - free,
                kind: 'external',
                detail:
                  'Physical capacity minus reported used and free; not assigned to a model.',
              });
            return (
              <ResourceMap
                key={g.index}
                title={`GPU ${g.index} · ${g.name}`}
                total={g.total_mib}
                tiles={tiles}
                summary={`${memory(g.used_mib)} used · ${memory(g.free_mib)} free · ${memory(settings.gpu_headroom_mib)} headroom limit · ${g.utilization ?? '—'}% GPU utilization`}
              />
            );
          })}
          {!host.gpus?.length && (
            <p className="muted">GPU telemetry unavailable.</p>
          )}
          {typeof host.ram_available_mib === 'number' &&
            typeof host.ram_total_mib === 'number' &&
            host.ram_total_mib > 0 && (
              <ResourceMap
                title="System RAM"
                total={host.ram_total_mib}
                tiles={[
                  {
                    id: 'used',
                    label: 'System & applications',
                    mib: host.ram_total_mib - host.ram_available_mib,
                    kind: 'external',
                    detail:
                      'Total minus OS-reported available RAM; process RSS can share pages and is not added here.',
                  },
                  {
                    id: 'free',
                    label: 'Available RAM (OS)',
                    mib: host.ram_available_mib,
                    kind: 'free',
                  },
                ]}
                summary={`${memory(host.ram_available_mib)} available · ${memory(settings.ram_headroom_mib)} headroom limit · ${host.cpu_percent ?? '—'}% CPU · ${memory(host.swap_used_mib)} swap used`}
              />
            )}
        </div>
      </CardContent>
    </Card>
  );
}
