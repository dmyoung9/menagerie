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
import { memory, timestamp, tokens } from '@/lib/formatters';
import { resourceHistory } from '@/contracts';
import type { ResourceHistoryGroup } from '@/types';
import { RunPeaks } from '@/components/charts/run-peaks';

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
        <CardDescription>Per-run peaks by configuration</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <p role="alert">History unavailable: {error}</p>
        ) : !groups ? (
          <p role="status">Loading resource history…</p>
        ) : !groups.length ? (
          <p>No observed runs in the retained history.</p>
        ) : (
          groups.map((group, index) => (
            <details key={group.profile_hash} open={index === 0}>
              <summary title={group.profile_hash}>
                {group.model_name} · {group.runtime_name || 'Configuration'}{' '}
                {typeof (
                  group.configuration?.['ctx-size'] ??
                  group.configuration?.['max-model-len']
                ) === 'number'
                  ? `· ${tokens(group.configuration?.['ctx-size'] ?? group.configuration?.['max-model-len'])} `
                  : `· ${group.profile_hash.slice(0, 8)} `}
                {typeof group.configuration?.parallel === 'number' &&
                  `· ${group.configuration.parallel} ${group.configuration.parallel === 1 ? 'slot' : 'slots'} `}
                · {group.run_count} runs
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
              {group.gpu_index != null && (
                <p className="muted">GPU {group.gpu_index}</p>
              )}
              <div className="resource-grid">
                <RunPeaks group={group} pool="gpu" />
                <RunPeaks group={group} pool="ram" />
              </div>
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
              <a href={`#/settings/history/runs/${group.artifact_id || ''}`}>
                View individual runs
              </a>
            </details>
          ))
        )}
      </CardContent>
    </Card>
  );
}
