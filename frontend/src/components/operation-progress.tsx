import { Progress } from '@/components/ui/progress';
import { bytes, duration, memoryTick } from '@/lib/formatters';
import { downloadProgress } from '@/lib/download-progress';
import type { Job } from '@/types';

export function OperationProgress({ job }: { job: Job }) {
  if (job.error) return <p className="error-text">{job.error}</p>;
  const download = job.state === 'RUNNING' ? downloadProgress(job) : null;
  if (!download) return <p className="muted">{job.progress}</p>;
  const fraction = `${bytes(download.done)} / ${download.total === null ? 'Unknown total' : bytes(download.total)}`;
  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex flex-wrap justify-between gap-2 tabular-nums">
        <span
          title={`${download.done.toLocaleString()} / ${download.total?.toLocaleString() ?? '?'} bytes`}
        >
          Downloading · {fraction}
        </span>
        {download.percent !== null && (
          <span>{Math.floor(download.percent)}%</span>
        )}
      </div>
      <Progress
        aria-label={`Download ${job.name}`}
        aria-valuetext={fraction}
        value={download.percent}
      />
      <span className="text-muted-foreground tabular-nums">
        {download.rate === null
          ? 'Rate unavailable · ETA estimating…'
          : `${memoryTick(download.rate / 1048576, 1)}/s · ${download.total === null ? 'ETA estimating…' : duration((download.total - download.done) / download.rate) + ' remaining'}`}
      </span>
    </div>
  );
}
