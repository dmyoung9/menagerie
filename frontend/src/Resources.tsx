import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CapacityBar } from '@/components/charts/capacity-bar';
import { CapacitySummary } from '@/components/charts/capacity-summary';
import { AllocationTreemap } from '@/components/charts/allocation-treemap';
import { memory, bytes } from '@/lib/formatters';
import { capacityAccounting, type Allocation } from '@/lib/capacity-accounting';
import { telemetryStale } from './ui';
import type {
  Deployment,
  HostSettings,
  HostSnapshot,
  ResourcePreview,
} from './types';

export function ResourceMap({
  title,
  total,
  tiles,
  summary,
  budget = total,
}: {
  title: string;
  total: number;
  tiles: Allocation[];
  summary?: string;
  budget?: number;
}) {
  const [selection, setSelection] = useState('');
  return (
    <section className="resource-card">
      <h3>{title}</h3>
      {summary && <p className="muted">{summary}</p>}
      <CapacityBar
        boundaryLabel={budget === total ? 'Capacity' : 'Budget'}
        budget={budget}
        physical={total}
        components={tiles}
        selection={selection}
        onSelect={setSelection}
      />
      <AllocationTreemap
        title={title}
        budget={budget}
        components={tiles}
        selection={selection}
        onSelect={setSelection}
      />
    </section>
  );
}

function PreviewPool({
  title,
  total,
  headroom,
  remaining,
  components,
}: {
  title: string;
  total: number;
  headroom: number;
  remaining: number | null;
  components: Allocation[];
}) {
  const [selection, setSelection] = useState('');
  const budget = Math.max(0, total - headroom);
  const a = capacityAccounting(budget, components);
  return (
    <section className="resource-card">
      <h3>{title}</h3>
      <CapacitySummary
        demand={a.demand}
        budget={budget}
        remaining={remaining}
        physical={total}
      />
      <CapacityBar
        budget={budget}
        physical={total}
        components={components}
        selection={selection}
        onSelect={setSelection}
      />
      <AllocationTreemap
        title={title}
        budget={budget}
        components={components}
        selection={selection}
        onSelect={setSelection}
      />
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
      className="draft-resources"
      role="complementary"
      aria-label="Deployment resource preview"
    >
      <CardHeader>
        <CardTitle>Resource preview</CardTitle>
      </CardHeader>
      <CardContent>
        {!preview ? (
          error ? (
            <p role="status">Resources unavailable: {error}</p>
          ) : (
            <Skeleton className="h-48 w-full" />
          )
        ) : (
          <>
            {preview.gpus.map((g) => {
              if (
                g.total_mib === null ||
                g.free_mib === null ||
                g.draft_mib === null
              )
                return <p key={g.index}>GPU {g.index} · Memory unavailable</p>;
              const components: Allocation[] = [
                {
                  id: 'used',
                  label:
                    g.used_mib === null
                      ? 'Unavailable capacity'
                      : 'Current use',
                  mib: g.used_mib ?? g.total_mib - g.free_mib,
                  kind: 'external',
                  detail:
                    g.used_mib === null
                      ? 'Capacity minus reported free memory'
                      : 'Device-reported used memory',
                },
              ];
              if (g.used_mib !== null && g.total_mib > g.used_mib + g.free_mib)
                components.push({
                  id: 'unattributed',
                  label: 'Unattributed capacity',
                  mib: g.total_mib - g.used_mib - g.free_mib,
                  kind: 'external',
                  detail: 'Capacity minus reported used and free memory',
                });
              preview.members
                .filter((m) => m.gpu === g.index)
                .forEach((m) => {
                  Object.entries(
                    m.estimate.components || {
                      'Process peak': m.estimate.peak_mib ?? 0,
                    },
                  ).forEach(([label, mib]) =>
                    components.push({
                      id: m.key + label,
                      group: m.key,
                      label: `${m.name} · ${label}`,
                      mib,
                      detail: `${m.estimate.basis} · ${m.estimate.sample_count} measured runs`,
                    }),
                  );
                });
              return (
                <PreviewPool
                  key={g.index}
                  title={`GPU ${g.index} · ${g.name}`}
                  total={g.total_mib}
                  headroom={g.headroom_mib}
                  remaining={g.remaining_mib}
                  components={components}
                />
              );
            })}
            {!preview.gpus.length && (
              <p className="muted">GPU memory unavailable</p>
            )}
            {preview.ram_total_mib != null &&
            preview.ram_available_mib !== null &&
            preview.ram_draft_mib !== null ? (
              <PreviewPool
                title="System RAM"
                total={preview.ram_total_mib}
                headroom={preview.ram_headroom_mib}
                remaining={preview.ram_remaining_mib}
                components={[
                  {
                    id: 'used',
                    label: 'Current use',
                    mib: preview.ram_total_mib - preview.ram_available_mib,
                    kind: 'external',
                  },
                  {
                    id: 'ram',
                    label: 'Proposed RAM',
                    mib: preview.ram_draft_mib,
                  },
                ]}
              />
            ) : (
              <p className="muted">
                System RAM · {memory(preview.ram_available_mib)} available
              </p>
            )}
            <dl className="properties">
              {preview.members.map((m) => (
                <div className="property-pair" key={m.key}>
                  <dt className="min-w-0">
                    <span className="block truncate" title={m.name}>
                      {m.name}
                    </span>
                  </dt>
                  <dd
                    title={`${m.estimate.provenance} · configuration ${m.estimate.profile_hash}`}
                  >
                    <span className="tabular-nums">
                      {memory(m.estimate.peak_mib)}
                    </span>{' '}
                    · {m.estimate.basis}
                    {m.estimate.sample_count > 0 &&
                      ` · ${m.estimate.sample_count} runs`}
                    <br />
                    <span className="muted">
                      File {bytes(m.estimate.file_size_bytes)}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            {telemetryStale(
              { ts: preview.sample_ts ?? undefined },
              preview.sample_seconds,
            ) && (
              <p className="muted">
                {preview.sample_ts
                  ? `Sample updated ${Math.max(0, Math.floor(Date.now() / 1000 - preview.sample_ts))}s ago`
                  : 'Sample unavailable'}
              </p>
            )}
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
  const stale = telemetryStale(host, settings.sample_seconds, now);
  return (
    <Card className="mb-5 min-w-0 live-resources">
      <CardHeader>
        <CardTitle>Where your resources go</CardTitle>
        {stale && (
          <p className="muted">
            {host.ts
              ? `Updated ${Math.max(0, Math.floor(now / 1000 - host.ts))}s ago`
              : 'Telemetry unavailable'}
          </p>
        )}
      </CardHeader>
      <CardContent>
        <div className="resource-grid">
          {(host.gpus || []).map((g) => {
            if (g.total_mib == null || g.used_mib == null)
              return <p key={g.index}>GPU {g.index} · Memory unavailable</p>;
            const tracked: Allocation[] = deployments.flatMap((d) => {
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
                      detail: 'Observed process VRAM',
                    },
                  ]
                : [];
            });
            const attributed = tracked.reduce((n, t) => n + t.mib, 0);
            const tiles = attributed <= g.used_mib ? tracked : [];
            tiles.push({
              id: 'other',
              label: 'Other / unattributed',
              mib: g.used_mib - (attributed <= g.used_mib ? attributed : 0),
              kind: 'external',
            });
            if (g.free_mib != null)
              tiles.push({
                id: 'free',
                label: 'Free',
                mib: g.free_mib,
                kind: 'free',
              });
            const remainder = g.total_mib - g.used_mib - (g.free_mib ?? 0);
            if (remainder > 0)
              tiles.push({
                id: 'unknown',
                label: 'Unattributed capacity',
                mib: remainder,
                kind: 'external',
              });
            return (
              <ResourceMap
                key={g.index}
                title={`GPU ${g.index} · ${g.name}`}
                total={g.total_mib}
                tiles={tiles}
                summary={`${memory(g.used_mib)} used · ${memory(g.free_mib)} free`}
              />
            );
          })}
          {!host.gpus?.length && (
            <p className="muted">GPU telemetry unavailable</p>
          )}
          {host.ram_total_mib != null && host.ram_available_mib != null && (
            <ResourceMap
              title="System RAM"
              total={host.ram_total_mib}
              summary={`${memory(host.ram_available_mib)} available`}
              tiles={[
                {
                  id: 'used',
                  label: 'System & applications',
                  mib: host.ram_total_mib - host.ram_available_mib,
                  kind: 'external',
                },
                {
                  id: 'free',
                  label: 'Available RAM (OS)',
                  mib: host.ram_available_mib,
                  kind: 'free',
                },
              ]}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
