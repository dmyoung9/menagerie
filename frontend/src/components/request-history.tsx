import { useEffect, useState } from 'react';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, Empty, readApi, message, number, Json } from '@/ui';
import { timestamp } from '@/lib/formatters';
import { historyRequest } from '@/contracts';
import { array } from '@/decode';
import type { HistoryRequest, Deployment } from '@/types';

export function RequestHistory({
  deploymentId,
  deployments = [],
}: {
  deploymentId?: string;
  deployments?: Deployment[];
}) {
  const [rows, setRows] = useState<HistoryRequest[]>([]),
    [error, setError] = useState(''),
    [selected, setSelected] = useState<HistoryRequest>();
  useEffect(() => {
    let alive = true;
    const load = () =>
      readApi(
        '/api/history/requests' +
          (deploymentId
            ? `?deployment_id=${encodeURIComponent(deploymentId)}`
            : ''),
        array(historyRequest),
      )
        .then((data) => {
          if (alive) {
            setRows(data);
            setError('');
          }
        })
        .catch((e) => {
          if (alive) setError(message(e));
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [deploymentId]);
  return (
    <Card className="mb-5 min-w-0">
      <CardContent>
        {error && <p role="alert">{error}</p>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="numeric">Latency (s)</TableHead>
              <TableHead className="numeric">First token (s)</TableHead>
              <TableHead className="numeric">Output tokens</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const d = deployments.find((d) => d.id === r.deployment_id);
              return (
                <TableRow key={r.id}>
                  <TableCell>{timestamp(r.ts)}</TableCell>
                  <TableCell>
                    <a href={`#/deployments/${d?.unit_id || r.deployment_id}`}>
                      {r.data.model_alias || d?.name || '—'}
                    </a>
                  </TableCell>
                  <TableCell className="numeric">
                    {number(r.data.latency, 2)}
                  </TableCell>
                  <TableCell className="numeric">
                    {number(r.data.ttft, 2)}
                  </TableCell>
                  <TableCell className="numeric">
                    {number(r.data.output_tokens, 0)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => setSelected(r)}
                    >
                      {r.data.error ? 'Errored' : 'Complete'}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {!rows.length && <Empty title="No requests yet" />}
        {selected && (
          <Dialog title="Request" close={() => setSelected(undefined)}>
            <Json value={selected} />
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}
