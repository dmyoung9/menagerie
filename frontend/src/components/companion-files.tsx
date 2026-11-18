import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, message, readApi } from '@/ui';
import { RepositoryPage } from '@/RepositoryPage';
import { job } from '@/contracts';
import * as d from '@/decode';
import type { Artifact, Job } from '@/types';

const filesDecoder = d.array(
  d.object({
    id: d.string,
    name: d.string,
    repo: d.string,
    source_revision: d.string,
    status: d.string,
    local_path: d.optional(d.nullable(d.string)),
  }),
);

/** Explicit inventory escape hatch: classification is a hint, never a filter. */
export function CompanionFiles({
  model,
  selected,
}: {
  model?: Artifact;
  selected: (path: string) => void;
}) {
  const [screen, setScreen] = useState<'files' | 'download' | null>(null);
  const [files, setFiles] = useState<ReturnType<typeof filesDecoder>>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!screen) return;
    let alive = true;
    const refresh = () =>
      void Promise.all([
        readApi('/api/registry/downloaded_files', filesDecoder),
        readApi('/api/registry/jobs', d.array(job)),
      ])
        .then(([nextFiles, nextJobs]) => {
          if (alive) {
            setFiles(nextFiles);
            setJobs(nextJobs);
            setError('');
          }
        })
        .catch((e: unknown) => {
          if (alive) setError(message(e));
        });
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [screen]);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => setScreen('files')}
      >
        Choose another file
      </Button>
      {model?.repo && (
        <Button
          type="button"
          variant="outline"
          onClick={() => setScreen('download')}
        >
          Download companion files
        </Button>
      )}
      {screen && (
        <Dialog
          title={
            screen === 'files'
              ? 'Choose downloaded file'
              : 'Download companion files'
          }
          wide
          guardChanges={false}
          close={() => setScreen(null)}
        >
          <p>
            Repository and filename are pairing hints, not compatibility
            guarantees. Your setup stays open while you choose or download a
            file.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setScreen(null)}
          >
            Return to setup
          </Button>
          {screen === 'download' && model?.repo ? (
            <>
              <RepositoryPage
                repo={model.repo}
                revision={model.source_revision || ''}
                jobs={jobs}
              />
              <Button type="button" onClick={() => setScreen('files')}>
                Choose downloaded file
              </Button>
            </>
          ) : (
            <>
              <Input
                type="search"
                aria-label="Filter downloaded files"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {error && <p role="alert">{error}</p>}
              <ul>
                {files
                  .filter(
                    (file) =>
                      file.status === 'downloaded' &&
                      file.local_path &&
                      `${file.repo}/${file.name}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                  )
                  .map((file) => (
                    <li key={file.id}>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          selected(file.local_path!);
                          setScreen(null);
                        }}
                      >
                        {file.repo}/{file.name} ·{' '}
                        {file.source_revision.slice(0, 8)}
                      </Button>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
