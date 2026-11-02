import { useState } from 'react';
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
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { memory } from '@/lib/formatters';
import type { HostSnapshot, Deployment } from '@/types';

export function ProcessResources({
  host,
  deployments,
}: {
  host: HostSnapshot;
  deployments: Deployment[];
}) {
  const [query, setQuery] = useState('');
  const [owner, setOwner] = useState('all');
  const rows = (host.processes || []).map((p) => ({
    ...p,
    deployment: deployments.find((d) =>
      host.deployments?.[d.id]?.pids?.includes(p.pid),
    ),
  }));
  const filtered = rows.filter(
    (p) =>
      `${p.name} ${p.pid} ${p.deployment?.name || ''}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (owner === 'all' ||
        (owner === 'menagerie' ? !!p.deployment : !p.deployment)),
  );
  return (
    <Card className="mb-5 min-w-0">
      <CardHeader>
        <CardTitle>GPU processes</CardTitle>
        <CardDescription>Device-reported compute processes</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="toolbar">
          <Input
            type="search"
            aria-label="Filter GPU processes"
            placeholder="Process, PID or deployment…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <NativeSelect
            aria-label="Process ownership"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          >
            <NativeSelectOption value="all">All processes</NativeSelectOption>
            <NativeSelectOption value="menagerie">Menagerie</NativeSelectOption>
            <NativeSelectOption value="external">
              External / unattributed
            </NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="table-wrap">
          <Table
            containerProps={{
              tabIndex: 0,
              role: 'region',
              'aria-label': 'GPU processes table',
            }}
          >
            <TableHeader>
              <TableRow>
                <TableHead>Process / PID</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Device</TableHead>
                <TableHead className="numeric">Observed VRAM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p, index) => (
                <TableRow key={`${p.pid}-${p.gpu_index ?? index}`}>
                  <TableCell>
                    {p.name} · {p.pid}
                  </TableCell>
                  <TableCell>
                    {p.deployment ? (
                      <a
                        href={
                          '#/deployments/' +
                          (p.deployment.unit_id || p.deployment.id)
                        }
                      >
                        {p.deployment.name}
                      </a>
                    ) : (
                      'External / unattributed'
                    )}
                  </TableCell>
                  <TableCell>
                    {p.gpu_index == null
                      ? 'Device unavailable'
                      : `GPU ${p.gpu_index}`}
                  </TableCell>
                  <TableCell className="numeric">{memory(p.gpu_mib)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {!filtered.length && (
          <p>
            {rows.length
              ? 'No matching processes.'
              : 'Process telemetry unavailable or no compute processes reported.'}
          </p>
        )}
        <h3>Deployment residency</h3>
        <div className="table-wrap">
          <Table
            containerProps={{
              tabIndex: 0,
              role: 'region',
              'aria-label': 'Deployment residency table',
            }}
          >
            <TableHeader>
              <TableRow>
                <TableHead>Deployment</TableHead>
                <TableHead className="numeric">Process VRAM</TableHead>
                <TableHead className="numeric">System RAM (RSS)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deployments.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <a href={'#/deployments/' + (d.unit_id || d.id)}>
                      {d.name}
                    </a>
                  </TableCell>
                  <TableCell className="numeric">
                    {memory(host.deployments?.[d.id]?.gpu_mib)}
                  </TableCell>
                  <TableCell className="numeric">
                    {memory(host.deployments?.[d.id]?.rss_mib)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
