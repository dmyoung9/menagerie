import type { Deployment, Job, OperationEvent } from '../types/index.ts';

export type ActivityEntry = {
  id: string;
  ts: number;
  title: string;
  state: string;
  steps: OperationEvent[];
  links: { label: string; href: string }[];
  detail?: string;
  job?: Job;
};
const text = (v: unknown) => (typeof v === 'string' ? v : '');
export function activityEntries(
  events: OperationEvent[],
  deployments: Pick<Deployment, 'id' | 'name' | 'unit_id'>[],
  jobs: Job[] = [],
): ActivityEntry[] {
  const groups = new Map<string, ActivityEntry>();
  const byId = new Map(deployments.map((d) => [d.id, d]));
  const legacySequences = new Map<string, string>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const data = e.data || {},
      job = jobs.find((j) => j.id === data.id);
    let id = text(data.operation_id) || (e.kind === 'job' ? text(data.id) : '');
    // Legacy state rows have explicit transition boundaries but no operation ID.
    // Never batch unrelated events by time proximity.
    if (!id && e.kind === 'state' && e.deployment_id) {
      const begins = ['VALIDATING', 'STOPPING'].includes(text(data.to));
      if (begins || !legacySequences.has(e.deployment_id))
        legacySequences.set(e.deployment_id, `event-${e.seq}`);
      id = legacySequences.get(e.deployment_id)!;
      if (['READY', 'FAILED', 'STOPPED', 'DEGRADED'].includes(text(data.to)))
        legacySequences.delete(e.deployment_id);
    }
    id ||= `event-${e.seq}`;
    const d = byId.get(e.deployment_id || '');
    const links: ActivityEntry['links'] = [];
    const target = e.deployment_id || text(data.deployment_id);
    if (target) {
      const unit = byId.get(target)?.unit_id || target;
      links.push({ label: 'Deployment', href: `#/deployments/${unit}` });
      links.push({
        label: 'Logs',
        href: `#/deployments/${unit}/logs${data.session_id ? `?member=${encodeURIComponent(target)}&run=${encodeURIComponent(text(data.session_id))}` : `?member=${encodeURIComponent(target)}`}`,
      });
    }
    const model = text(data.model_id) || job?.model_id;
    if (model)
      links.push({ label: 'Model', href: `#/models/installed/${model}` });
    const repo = text(data.repo) || job?.repo;
    if (repo) links.push({ label: 'Downloads', href: '#/models/downloads' });
    let title: string;
    let state = text(data.to) || text(data.state) || 'Recorded';
    const detail = text(data.reason) || text(data.error);
    if (e.kind === 'state') {
      const action =
        data.to === 'STOPPING' || data.to === 'STOPPED' ? 'Unload' : 'Load';
      title = `${action} ${d?.name || text(data.name) || '—'}`;
    } else if (e.kind === 'job') title = job?.name || text(data.name) || '—';
    else if (e.kind === 'pressure') {
      state = data.active ? 'Warning' : 'Resolved';
      const conditions = data.active
        ? data.conditions
        : data.previous_conditions;
      const items = Array.isArray(conditions) ? conditions : [];
      title = items.length
        ? items
            .map(
              (c) =>
                `${c.resource} ${String(c.metric).replaceAll('_', ' ')} ${c.value} ${c.unit} ${c.direction} ${c.threshold} ${c.unit}`,
            )
            .join('; ')
        : '—';
      if (!data.active && items.length) title = `Recovered: ${title}`;
      links.push(
        { label: 'Host policy', href: '#/settings/host' },
        { label: 'Samples', href: '#/settings/history/samples' },
      );
    } else if (e.kind === 'deployment')
      title = `${data.enabled ? 'Enable' : 'Disable'} ${d?.name || text(data.alias) || '—'}`;
    else if (e.kind === 'delete')
      title = `Remove ${text(data.kind) || 'resource'}`;
    else if (e.kind === 'purge')
      title = `Remove telemetry older than ${data.older_than_days ?? '—'} days`;
    else
      title = text(data.name) || text(data.message) || text(data.reason) || '—';
    const prior = groups.get(id);
    if (prior) {
      prior.steps.push(e);
      prior.ts = e.ts;
      prior.state = state;
      if (e.kind === 'job') prior.title = title;
      if (detail) prior.detail = detail;
      for (const link of links)
        if (!prior.links.some((l) => l.href === link.href))
          prior.links.push(link);
    } else
      groups.set(id, {
        id,
        ts: e.ts,
        title,
        state,
        detail,
        steps: [e],
        links,
        job,
      });
  }
  for (const job of jobs) {
    const existing = groups.get(job.id);
    const result =
      job.result && typeof job.result === 'object' && 'id' in job.result
        ? text(job.result.id)
        : '';
    const download =
      job.operation === 'download' || job.name.startsWith('Download ');
    const resultRecord =
      job.result && typeof job.result === 'object'
        ? (job.result as Record<string, unknown>)
        : {};
    const title =
      job.name === 'Download model'
        ? `Download ${job.repo || text(resultRecord.repo) || '—'} · ${job.filename || text(resultRecord.name) || '—'}`
        : job.name;
    const links: ActivityEntry['links'] = [];
    if (job.deployment_id)
      links.push(
        { label: 'Deployment', href: `#/deployments/${job.deployment_id}` },
        { label: 'Logs', href: `#/deployments/${job.deployment_id}/logs` },
      );
    if (job.model_id || (result && download))
      links.push({
        label: 'Model',
        href: `#/models/installed/${job.model_id || result}`,
      });
    if (download)
      links.push({ label: 'Downloads', href: '#/models/downloads' });
    if (existing) {
      existing.title = title;
      existing.state = job.state;
      existing.job = job;
      existing.detail = job.error || existing.detail;
      for (const link of links)
        if (!existing.links.some((l) => l.href === link.href))
          existing.links.push(link);
    } else
      groups.set(job.id, {
        id: job.id,
        ts: job.ended_at || job.created_at,
        title,
        state: job.state,
        detail: job.error,
        steps: [],
        links,
        job,
      });
  }
  return [...groups.values()]
    .map((entry) => {
      const links = new Map<string, ActivityEntry['links'][number]>();
      for (const link of entry.links) {
        const key = link.href.split('?')[0];
        const previous = links.get(key);
        if (
          !previous ||
          link.href.includes('run=') ||
          !previous.href.includes('run=')
        )
          links.set(key, link);
      }
      return { ...entry, links: [...links.values()] };
    })
    .sort((a, b) => b.ts - a.ts);
}
