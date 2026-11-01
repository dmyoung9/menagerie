import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { gib, telemetryStale } from './ui';
import { useEffect, useState } from 'react';
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
}: {
  title: string;
  total: number;
  tiles: Tile[];
  summary?: string;
}) {
  const [selected, setSelected] = useState('');
  const valid = tiles.filter((t) => Number.isFinite(t.mib) && t.mib > 0);
  const chosen = valid.find((t) => t.id === selected);
  return (
    <section className="resource-card">
      <div className="section-heading">
        <h3>{title}</h3>
        <span>{gib(total)} GiB capacity</span>
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
            type="button"
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
            aria-label={`${t.label}: ${gib(t.mib)} GiB${t.detail ? '. ' + t.detail : ''}`}
            aria-pressed={selected === t.id}
            title={`${t.label}: ${gib(t.mib)} GiB${t.detail ? '\n' + t.detail : ''}`}
            onClick={() => setSelected(t.id)}
          >
            <span>{t.label}</span>
            <strong>{gib(t.mib)} GiB</strong>
          </Button>
        ))}
      </div>
      <div className="resource-legend">
        {valid.map((t) => (
          <Button
            variant="ghost"
            type="button"
            key={t.id}
            aria-pressed={selected === t.id}
            onClick={() => setSelected(t.id)}
          >
            <i style={{ background: tileColor(t) }} />
            {t.label}
            <b>{gib(t.mib)}</b>
          </Button>
        ))}
      </div>
      {chosen && (
        <p className="resource-inspector" role="status">
          <strong>
            {chosen.label}: {gib(chosen.mib)} GiB.
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
        <Badge variant="secondary">Estimated</Badge>
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
                  mib: g.used_mib,
                  kind: 'external',
                },
                {
                  id: 'reserve',
                  label: 'Desktop reserve',
                  mib: g.reserve_mib,
                  kind: 'reserve',
                },
              ];
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
                    e.components || { 'Measured peak + margin': e.peak_mib },
                  ).forEach(([label, mib]) =>
                    tiles.push({
                      id: m.key + label,
                      group: m.name + m.key,
                      label: `${name} · ${label}`,
                      mib: Number(mib),
                      detail: `${e.confidence} confidence. ${e.provenance}`,
                    }),
                  );
                });
              tiles.push({
                id: 'free',
                label: 'Remaining',
                mib: Math.max(0, g.remaining_mib),
                kind: 'free',
              });
              return (
                <div key={g.index}>
                  {g.reservation_error && (
                    <p className="warning">
                      Explicit reservations exceed physical capacity including
                      desktop reserve. Launch will be blocked.
                    </p>
                  )}
                  <ResourceMap
                    title={`GPU ${g.index} · ${g.name}`}
                    total={g.total_mib}
                    tiles={tiles}
                    summary={`${g.verdict} · ${g.remaining_mib < 0 ? gib(-g.remaining_mib) + ' GiB over capacity (map scaled to demand)' : gib(g.remaining_mib) + ' GiB remaining after reserve'}`}
                  />
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
              RAM available: {gib(preview.ram_available_mib)} GiB · reserve:{' '}
              {gib(preview.ram_reserve_mib)} GiB · estimated CPU/RAM offload:{' '}
              {gib(
                preview.members.reduce(
                  (sum: number, m) => sum + (m.estimate.ram_mib || 0),
                  0,
                ),
              )}{' '}
              GiB. CPU offload is slower than GPU-resident inference.
            </p>
            {preview.ram_available_mib !== null &&
              preview.ram_available_mib < preview.ram_reserve_mib && (
                <p className="warning">
                  Host RAM is below the headroom gate. Loading is blocked until
                  memory is available.
                </p>
              )}
            {(!preview.sample_ts ||
              Date.now() / 1000 - preview.sample_ts > 10) && (
              <p className="warning">
                Capacity telemetry is stale or unavailable. Refresh before
                relying on this budget.
              </p>
            )}
            {preview.members.map((m) => (
              <p className="muted" key={m.key}>
                {m.name}: predicted peak {gib(m.estimate.peak_mib)} GiB ·
                reservation {gib(m.estimate.reservation_mib)} GiB (not
                additional usage).
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
          Select a block to inspect it. Reserve is held out of available space,
          not added to observed usage.
        </p>
        <div className="resource-grid">
          {(host.gpus || []).map((g: GpuSnapshot) => {
            if (typeof g.used_mib !== 'number' || !g.total_mib)
              return (
                <p key={g.index}>
                  GPU {g.index}: memory telemetry unavailable.
                </p>
              );
            // Process GPU samples are aggregate across devices. Never invent per-GPU attribution.
            const tracked: Tile[] =
              host.gpus?.length === 1
                ? deployments.flatMap((d) => {
                    const mib = host.deployments?.[d.id]?.gpu_mib;
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
                  })
                : [];
            const attributed = tracked.reduce((n, t) => n + t.mib, 0);
            const consistent = attributed <= g.used_mib;
            const tiles: Tile[] = consistent ? tracked : [];
            const free = Math.max(0, g.total_mib - g.used_mib),
              reserve = Math.min(free, settings.gpu_headroom_mib || 2048);
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
                id: 'reserve',
                label: 'Desktop reserve',
                mib: reserve,
                kind: 'reserve',
              },
              {
                id: 'free',
                label: 'Available to deploy',
                mib: free - reserve,
                kind: 'free',
              },
            );
            return (
              <ResourceMap
                key={g.index}
                title={`GPU ${g.index} · ${g.name}`}
                total={g.total_mib}
                tiles={tiles}
                summary={`${gib(g.used_mib)} GiB used · ${g.utilization ?? '—'}% GPU utilization`}
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
                    id: 'reserve',
                    label: 'Host reserve',
                    mib: Math.min(
                      host.ram_available_mib,
                      settings.ram_headroom_mib || 4096,
                    ),
                    kind: 'reserve',
                  },
                  {
                    id: 'free',
                    label: 'Available to deploy',
                    mib: Math.max(
                      0,
                      host.ram_available_mib -
                        (settings.ram_headroom_mib || 4096),
                    ),
                    kind: 'free',
                  },
                ]}
                summary={`${host.cpu_percent ?? '—'}% CPU · ${gib(host.swap_used_mib)} GiB swap used`}
              />
            )}
        </div>
      </CardContent>
    </Card>
  );
}
