import { useEffect, useState } from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { readApi, message } from '@/ui';
import { memory, timestamp } from '@/lib/formatters';
import { resourceHistory } from '@/contracts';
import type { ResourceHistoryGroup } from '@/types';

export function ResourceHistory({ artifactId }: { artifactId?: string }) {
  const [groups, setGroups] = useState<ResourceHistoryGroup[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    readApi(
      '/api/history/resources' +
        (artifactId ? `?artifact_id=${encodeURIComponent(artifactId)}` : ''),
      resourceHistory,
    )
      .then((data) => {
        if (alive) {
          setGroups(data);
          setError('');
        }
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [artifactId]);
  return (
    <Card className="mb-5 min-w-0">
      <CardHeader>
        <CardTitle>Observed resource history</CardTitle>
        <CardDescription>
          Per-process run peaks, grouped by execution configuration. Failed and
          partial runs are included, not guarantees of a future workload. No
          internal allocation split is measured.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <p role="alert">History unavailable: {error}</p>
        ) : !groups ? (
          <p role="status">Loading resource history…</p>
        ) : !groups.length ? (
          <p>No observed runs in the retained history.</p>
        ) : (
          groups.map((group) => (
            <details key={group.profile_hash} open>
              <summary>
                {group.model_name} · configuration{' '}
                {group.profile_hash.slice(0, 12)} · {group.run_count} runs
              </summary>
              <p>
                <time title={new Date(group.first_run_at * 1000).toISOString()}>
                  {timestamp(group.first_run_at)}
                </time>{' '}
                –{' '}
                <time title={new Date(group.last_run_at * 1000).toISOString()}>
                  {timestamp(group.last_run_at)}
                </time>
              </p>
              <div className="table-wrap">
                <Table
                  containerProps={{
                    tabIndex: 0,
                    role: 'region',
                    'aria-label': 'Run peak statistics',
                  }}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>Observed pool</TableHead>
                      <TableHead className="numeric">Measured runs</TableHead>
                      <TableHead className="numeric">Mean run peak</TableHead>
                      <TableHead className="numeric">Max run peak</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(['gpu', 'ram'] as const).map((pool) => (
                      <TableRow key={pool}>
                        <TableCell>
                          {pool === 'gpu'
                            ? 'GPU VRAM (process aggregate)'
                            : 'System RAM (RSS)'}
                        </TableCell>
                        <TableCell className="numeric">
                          {group[pool].sample_count}
                        </TableCell>
                        <TableCell className="numeric">
                          {memory(group[pool].mean_peak_mib)}
                        </TableCell>
                        <TableCell className="numeric">
                          {memory(group[pool].max_peak_mib)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <details>
                <summary>Individual runs</summary>
                <div className="table-wrap">
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
                        <TableHead>Outcome</TableHead>
                        <TableHead className="numeric">GPU peak</TableHead>
                        <TableHead className="numeric">RAM peak</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.runs.map((run) => (
                        <TableRow key={run.id}>
                          <TableCell
                            title={new Date(
                              run.started_at * 1000,
                            ).toISOString()}
                          >
                            {timestamp(run.started_at)}
                          </TableCell>
                          <TableCell>{run.outcome}</TableCell>
                          <TableCell className="numeric">
                            {memory(run.peak_gpu_mib)}
                          </TableCell>
                          <TableCell className="numeric">
                            {memory(run.peak_ram_mib)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </details>
            </details>
          ))
        )}
      </CardContent>
    </Card>
  );
}
