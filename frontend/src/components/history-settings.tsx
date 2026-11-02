import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Tabs, readApi, message } from '@/ui';
import { go } from '@/navigation';
import {
  memory,
  percent,
  temperature,
  timestamp,
  watts,
} from '@/lib/formatters';
import { array } from '@/decode';
import { host, resourceHistory } from '@/contracts';
import { ResourceHistory } from './resource-history';
import type { HostSnapshot, ResourceHistoryGroup } from '@/types';

export function HistorySettings() {
  const parts = window.location.hash.slice(2).split('/'),
    tab = parts[2] === 'samples' ? 'Samples' : 'Runs',
    artifactId = parts[3];
  const [samples, setSamples] = useState<HostSnapshot[]>([]),
    [groups, setGroups] = useState<ResourceHistoryGroup[]>([]),
    [error, setError] = useState(''),
    [query, setQuery] = useState('');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        if (tab === 'Samples') {
          const rows = await readApi(
            '/api/history/metrics?hours=24',
            array(host),
          );
          if (alive) setSamples(rows);
        } else {
          const rows = await readApi(
            '/api/history/resources' +
              (artifactId
                ? `?artifact_id=${encodeURIComponent(artifactId)}`
                : ''),
            resourceHistory,
          );
          if (alive) setGroups(rows);
        }
        if (alive) setError('');
      } catch (e) {
        if (alive) setError(message(e));
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [tab, artifactId]);
  return (
    <>
      <Tabs
        items={['Runs', 'Samples']}
        value={tab}
        label="History data"
        onChange={(t) => go(`settings/history/${t.toLowerCase()}`)}
      />
      {error && <p role="alert">{error}</p>}
      {tab === 'Samples' ? (
        <Card>
          <CardHeader>
            <CardTitle>Telemetry samples · last 24 hours</CardTitle>
          </CardHeader>
          <CardContent>
            <Table
              containerProps={{
                tabIndex: 0,
                role: 'region',
                'aria-label': 'Telemetry samples',
              }}
            >
              <TableHeader>
                <TableRow>
                  {[
                    'Time',
                    'Resource',
                    'Memory used',
                    'Memory free',
                    'Activity',
                    'Temperature',
                    'Power',
                    'Swap used',
                    'Disk free',
                  ].map((s) => (
                    <TableHead key={s}>{s}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...samples].reverse().flatMap((s) => [
                  <TableRow key={`${s.ts}-host`}>
                    <TableCell>{timestamp(s.ts)}</TableCell>
                    <TableCell>CPU / RAM</TableCell>
                    <TableCell className="numeric">
                      {memory(
                        s.ram_total_mib != null && s.ram_available_mib != null
                          ? s.ram_total_mib - s.ram_available_mib
                          : null,
                      )}
                    </TableCell>
                    <TableCell className="numeric">
                      {memory(s.ram_available_mib)}
                    </TableCell>
                    <TableCell className="numeric">
                      {percent(s.cpu_percent)}
                    </TableCell>
                    <TableCell>—</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell className="numeric">
                      {memory(s.swap_used_mib)}
                    </TableCell>
                    <TableCell className="numeric">
                      {memory(
                        s.disk_free_gib == null ? null : s.disk_free_gib * 1024,
                      )}
                    </TableCell>
                  </TableRow>,
                  ...(s.gpus || []).map((g) => (
                    <TableRow key={`${s.ts}-${g.index}`}>
                      <TableCell>{timestamp(s.ts)}</TableCell>
                      <TableCell>
                        GPU {g.index} · {g.name}
                      </TableCell>
                      <TableCell className="numeric">
                        {memory(g.used_mib)}
                      </TableCell>
                      <TableCell className="numeric">
                        {memory(g.free_mib)}
                      </TableCell>
                      <TableCell className="numeric">
                        {percent(g.utilization)}
                      </TableCell>
                      <TableCell className="numeric">
                        {temperature(g.temperature)}
                      </TableCell>
                      <TableCell className="numeric">
                        {watts(g.power_w)}
                      </TableCell>
                      <TableCell>—</TableCell>
                      <TableCell>—</TableCell>
                    </TableRow>
                  )),
                ])}
              </TableBody>
            </Table>
            {!samples.length && <p>No retained samples.</p>}
          </CardContent>
        </Card>
      ) : (
        <>
          <Input
            type="search"
            aria-label="Filter resource runs"
            placeholder="Filter model or configuration…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {groups
            .filter((g) =>
              `${g.model_name} ${g.runtime_name} ${g.profile_hash}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((g) => (
              <Card className="my-5 min-w-0" key={g.profile_hash}>
                <CardHeader>
                  <CardTitle>{g.model_name}</CardTitle>
                  <p>
                    {g.runtime_name} · {g.profile_hash.slice(0, 8)} · GPU{' '}
                    {g.gpu_index ?? '—'}
                  </p>
                </CardHeader>
                <CardContent>
                  <Table
                    containerProps={{
                      tabIndex: 0,
                      role: 'region',
                      'aria-label': 'Individual resource runs',
                    }}
                  >
                    <TableHeader>
                      <TableRow>
                        <TableHead>Started</TableHead>
                        <TableHead>Ended</TableHead>
                        <TableHead>Outcome</TableHead>
                        <TableHead className="numeric">GPU peak</TableHead>
                        <TableHead className="numeric">RAM peak</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {g.runs.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{timestamp(r.started_at)}</TableCell>
                          <TableCell>{timestamp(r.ended_at)}</TableCell>
                          <TableCell>{r.outcome}</TableCell>
                          <TableCell className="numeric">
                            {memory(r.peak_gpu_mib)}
                          </TableCell>
                          <TableCell className="numeric">
                            {memory(r.peak_ram_mib)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))}
          {!groups.length && <p>No retained runs.</p>}
          <ResourceHistory artifactId={artifactId} />
        </>
      )}
    </>
  );
}
