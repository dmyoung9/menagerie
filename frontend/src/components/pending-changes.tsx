import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, readApi, message } from '@/ui';
import {
  applyConfiguration,
  applyLabels,
  type ApplyMode,
} from '@/configuration-apply';
import { useConfirmation } from '@/hooks/use-confirmation';
import * as d from '@/decode';

const statusDecoder = d.object({
  pending: d.boolean,
  affected: d.array(d.string),
  loaded: d.optional(d.boolean),
  inflight: d.optional(d.number),
  op: d.nullable(d.object({ state: d.string, error: d.nullable(d.string) })),
});

/** One compact editor status/action bar for a scheduled or interrupted reload. */
export function PendingChanges({
  deploymentId,
  changed,
  onBusyChange,
  onPendingChange,
  hideApplyActions,
}: {
  deploymentId: string;
  changed: () => void;
  onBusyChange?: (busy: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
  hideApplyActions?: boolean;
}) {
  const [status, setStatus] = useState<ReturnType<typeof statusDecoder> | null>(
    null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { confirm, confirmation } = useConfirmation();
  const callbacks = useRef({ changed, onBusyChange, onPendingChange });
  useEffect(() => {
    callbacks.current = { changed, onBusyChange, onPendingChange };
  }, [changed, onBusyChange, onPendingChange]);
  const base = `/api/deployments/${deploymentId}`;
  useEffect(() => {
    let alive = true;
    let wasPending = false;
    const refresh = async () => {
      try {
        const next = await readApi(`${base}/pending`, statusDecoder);
        if (!alive) return;
        setStatus(next);
        callbacks.current.onPendingChange?.(next.pending);
        callbacks.current.onBusyChange?.(
          ['queued', 'applying'].includes(next.op?.state || ''),
        );
        if (wasPending && !next.pending) callbacks.current.changed();
        wasPending = next.pending;
      } catch (e) {
        if (alive) setError(message(e));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base]);
  async function action(kind: ApplyMode | 'cancel' | 'discard') {
    setBusy(true);
    setError('');
    try {
      if (kind === 'cancel' || kind === 'discard')
        await api(`${base}/${kind}`, {});
      else await applyConfiguration(deploymentId, kind, confirm);
      setStatus(await readApi(`${base}/pending`, statusDecoder));
      changed();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (!status?.pending && !error) return null;
  const queued = status?.op?.state === 'queued';
  const applying = status?.op?.state === 'applying';
  const mode: ApplyMode =
    status?.loaded === false ? 'apply' : status?.inflight ? 'idle' : 'reload';
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      aria-label="Configuration application"
    >
      {confirmation}
      <span role="status">
        {queued
          ? `Reload scheduled — waiting for ${status?.inflight ?? 'active'} requests`
          : applying
            ? 'Applying configuration…'
            : 'Configuration not applied'}
      </span>
      {status?.op?.error && <span role="status">{status.op.error}</span>}
      {error && <span role="alert">{error}</span>}
      {queued ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void action('cancel')}
        >
          Cancel scheduled reload
        </Button>
      ) : (
        !applying &&
        !hideApplyActions && (
          <>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void action(mode)}
            >
              {applyLabels[mode]}
            </Button>
            {Boolean(status?.inflight) && (
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => void action('now')}
              >
                Apply and Reload Now
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void action('discard')}
            >
              Discard proposed configuration
            </Button>
          </>
        )
      )}
    </div>
  );
}
