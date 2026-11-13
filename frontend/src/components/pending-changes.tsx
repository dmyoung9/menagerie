import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, readApi, message } from '@/ui';
import * as d from '@/decode';

const statusDecoder = d.object({
  pending: d.boolean,
  affected: d.array(d.string),
  op: d.nullable(d.object({ state: d.string, error: d.nullable(d.string) })),
});
const reviewDecoder = d.object({
  plan_token: d.string,
  scope_fingerprint: d.string,
  affected: d.array(d.string),
  stop_names: d.array(d.string),
  errors: d.array(d.string),
});

export function PendingChanges({
  deploymentId,
  changed,
}: {
  deploymentId: string;
  changed: () => void;
}) {
  const [status, setStatus] = useState<ReturnType<typeof statusDecoder> | null>(
    null,
  );
  const [review, setReview] = useState<ReturnType<typeof reviewDecoder> | null>(
    null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/deployments/${deploymentId}`;
  const onChanged = useRef(changed);
  useEffect(() => {
    onChanged.current = changed;
  }, [changed]);
  useEffect(() => {
    let alive = true;
    let wasPending = false;
    const refresh = () =>
      void readApi(`${base}/pending`, statusDecoder)
        .then((value) => {
          if (alive) {
            setStatus(value);
            if (wasPending && !value.pending) onChanged.current();
            wasPending = value.pending;
          }
        })
        .catch((e: unknown) => {
          if (alive) setError(message(e));
        });
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base]);
  async function action(
    kind: 'review-apply' | 'request-apply' | 'cancel' | 'discard',
  ) {
    setBusy(true);
    setError('');
    try {
      if (kind === 'review-apply')
        setReview(await readApi(`${base}/${kind}`, reviewDecoder, {}));
      else {
        await api(
          `${base}/${kind}`,
          kind === 'request-apply'
            ? {
                token: review?.plan_token,
                scope_fingerprint: review?.scope_fingerprint,
              }
            : {},
        );
        setReview(null);
        setStatus(await readApi(`${base}/pending`, statusDecoder));
        changed();
      }
    } catch (e) {
      setError(message(e));
      setReview(null);
    } finally {
      setBusy(false);
    }
  }
  if (!status?.pending && !error) return null;
  const queued = status?.op?.state === 'queued';
  const applying = status?.op?.state === 'applying';
  return (
    <section aria-label="Pending changes" className="warning">
      <h3>Changes pending</h3>
      <p>
        Your changes are saved. The runtime is still using the previous
        configuration.
      </p>
      <p>Affected models: {status?.affected.join(', ')}</p>
      {status?.op?.error && <p role="status">{status.op.error}</p>}
      {error && <p role="alert">{error}</p>}
      {queued ? (
        <>
          <p>Waiting for active requests to finish…</p>
          <Button disabled={busy} onClick={() => void action('cancel')}>
            Cancel scheduled apply
          </Button>
        </>
      ) : applying ? (
        <p>Applying changes…</p>
      ) : review ? (
        <>
          <h4>Apply changes when idle?</h4>
          <p>
            Current requests will finish first. New requests will wait briefly
            while the shared runtime restarts.
          </p>
          <p>Restart affects: {review.affected.join(', ')}</p>
          {review.stop_names.length > 0 && (
            <p>
              Will also unload: {review.stop_names.join(', ')}. KV caches will
              be lost.
            </p>
          )}
          {review.errors.map((e) => (
            <p role="alert" key={e}>
              {e}
            </p>
          ))}
          <Button
            disabled={busy || review.errors.length > 0}
            onClick={() => void action('request-apply')}
          >
            Apply when idle
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setReview(null)}
          >
            Keep editing
          </Button>
        </>
      ) : (
        <>
          <Button disabled={busy} onClick={() => void action('review-apply')}>
            Review restart
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void action('discard')}
          >
            Discard pending changes
          </Button>
        </>
      )}
    </section>
  );
}
