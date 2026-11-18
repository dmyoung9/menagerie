import { api, readApi } from './ui';
import * as d from './decode';

export type ApplyMode = 'apply' | 'reload' | 'idle' | 'now';
export const applyLabels: Record<ApplyMode, string> = {
  apply: 'Apply',
  reload: 'Apply and Reload',
  idle: 'Apply and Reload when Idle',
  now: 'Apply and Reload Now',
};
export const applyReview = d.object({
  plan_token: d.string,
  scope_fingerprint: d.string,
  affected: d.array(d.string),
  stop_names: d.array(d.string),
  errors: d.array(d.string),
  loaded: d.optional(d.boolean),
  inflight: d.optional(d.number),
});

export async function applyConfiguration(
  id: string,
  mode: ApplyMode,
  confirm: (message: string, label?: string) => Promise<boolean>,
) {
  const base = `/api/deployments/${id}`;
  const review = await readApi(`${base}/review-apply`, applyReview, {});
  if (review.errors.length) throw new Error(review.errors.join('\n'));
  if (review.loaded !== false) {
    const detail =
      `Restart the pool containing ${review.affected.join(', ')}. Cached context will be lost; models load again on demand.` +
      (review.stop_names.length
        ? ` Also unload: ${review.stop_names.join(', ')}.`
        : '') +
      (mode === 'now'
        ? ' Interrupt active requests now.'
        : mode === 'idle'
          ? ' Finish current requests first; new requests wait briefly.'
          : ' Reload only if no requests are active.');
    if (!(await confirm(detail, applyLabels[mode]))) return false;
  }
  await api(`${base}/request-apply`, {
    token: review.plan_token,
    scope_fingerprint: review.scope_fingerprint,
    mode,
    confirm_interrupt: mode === 'now',
  });
  return true;
}
