import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Download,
  Info,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { useIsMobile } from '@/hooks/use-mobile';
import { bytes } from '@/lib/formatters';
import { SafeMarkdownArticle } from '@/components/safe-markdown';
import {
  STATUS_FILTER_LABELS,
  buildGroupRows,
  classifyFileName,
  filterGroupRows,
  retryGroups,
  sortGroupRows,
  summaryFor,
  type AcquisitionSummary,
  type GroupRow,
  type RepositoryFilters,
  type SortDir,
  type SortKey,
  type StatusFilter,
} from '@/repository-model';
import { repositoryManifest, repositoryReadme } from '@/contracts';
import { api, message, readApi, waitForToken } from '@/ui';
import type { Job, RepositoryManifest, RepositoryReadme } from '@/types';
import { go } from '@/navigation';

interface RepositoryPageProps {
  /** `org/model` path of the repository to show. */
  repo: string;
  /** Pinned revision (commit/tag) to open; empty = repository default. */
  revision?: string;
  /** Hash to return to via "Back"; defaults to the Models tab. */
  returnTo?: string;
  /** Running jobs, used to surface the in-flight acquisition for this repo. */
  jobs?: Job[];
  /** Optional: let the App refresh slices when a job finishes. */
  onJobFinished?: (repo: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  not_downloaded: 'Not downloaded',
  downloading: 'Downloading',
  downloaded: 'Downloaded',
  failed: 'Failed',
  missing: 'Failed',
};
const STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  not_downloaded: 'outline',
  downloading: 'outline',
  downloaded: 'default',
  failed: 'destructive',
  missing: 'destructive',
};

function repositoryRepoPath(repo: string) {
  return 'models/repo/' + repo;
}

export function RepositoryPage({
  repo,
  revision = '',
  returnTo,
  jobs = [],
  onJobFinished,
}: RepositoryPageProps) {
  const [requestedRepo, setRequestedRepo] = useState<string | null>(null);
  const [requestedRevision, setRequestedRevision] = useState<string | null>(
    null,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [revisionPrompt, setRevisionPrompt] = useState<string | null>(null);

  const [manifest, setManifest] = useState<RepositoryManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState('');

  const [readme, setReadme] = useState<RepositoryReadme | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [readmeError, setReadmeError] = useState('');

  const [filters, setFilters] = useState<RepositoryFilters>({
    search: '',
    type: 'all',
    quantization: 'all',
    status: 'all',
  });
  const [sortKey, setSortKey] = useState<SortKey>('file');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [quantGuidanceOpen, setQuantGuidanceOpen] = useState(false);

  const manifestSeq = useRef(0);
  const readmeSeq = useRef(0);
  const processedJob = useRef<string | null>(null);
  const cardTriggerRef = useRef<HTMLButtonElement>(null);
  const mobile = useIsMobile();

  const resolvedRevision = manifest?.revision ?? null;

  // The manifest is a POST; block it until the dashboard token is established
  // so an initial-load POST never races the /api/status that carries it.
  const loadManifest = useCallback(async (repoName: string, rev: string) => {
    const seq = ++manifestSeq.current;
    setManifestLoading(true);
    setManifestError('');
    await waitForToken();
    readApi<RepositoryManifest>('/api/downloads/manifest', repositoryManifest, {
      repo: repoName,
      revision: rev || 'main',
    })
      .then((value) => {
        if (seq === manifestSeq.current) {
          setManifest(value);
          setManifestLoading(false);
        }
      })
      .catch((err) => {
        if (seq === manifestSeq.current) {
          setManifestError(message(err));
          setManifestLoading(false);
        }
      });
  }, []);

  const loadReadme = useCallback((repoName: string, rev: string) => {
    const seq = ++readmeSeq.current;
    setReadmeLoading(true);
    setReadmeError('');
    readApi<RepositoryReadme>(
      '/api/catalog/hf/readme?repo=' +
        encodeURIComponent(repoName) +
        '&revision=' +
        encodeURIComponent(rev || 'main'),
      repositoryReadme,
    )
      .then((value) => {
        if (seq === readmeSeq.current) {
          setReadme(value);
          setReadmeLoading(false);
        }
      })
      .catch((err) => {
        if (seq === readmeSeq.current) {
          setReadmeError(message(err));
          setReadmeLoading(false);
        }
      });
  }, []);

  const adopt = useCallback(
    (repoName: string, revName: string) => {
      setSelected([]);
      setRequestedRepo(repoName);
      setRequestedRevision(revName);
      void loadManifest(repoName, revName);
      loadReadme(repoName, revName);
    },
    [loadManifest, loadReadme],
  );

  function reload() {
    void loadManifest(repo, requestedRevision || 'main');
    loadReadme(repo, requestedRevision || 'main');
  }

  function acceptChangeRevision() {
    if (revisionPrompt === null) return;
    setRevisionPrompt(null);
    setSelected([]);
    setRequestedRepo(repo);
    setRequestedRevision(revisionPrompt);
    void loadManifest(repo, revisionPrompt);
    loadReadme(repo, revisionPrompt);
  }

  function keepRevision() {
    setRevisionPrompt(null);
    const current = requestedRevision || '';
    go(
      repositoryRepoPath(repo) +
        (current ? '?revision=' + encodeURIComponent(current) : ''),
    );
  }

  // Adopt a new repo/revision from the props, guarding an in-flight selection.
  useEffect(() => {
    if (revisionPrompt) return;
    if (
      requestedRepo !== null &&
      requestedRepo === repo &&
      requestedRevision === revision
    )
      return;
    // Same repo, incoming revision differs, user has a selection -> explicit
    // "Change revision?" prompt; never silently apply old bytes to new bytes.
    if (
      selected.length > 0 &&
      requestedRepo === repo &&
      requestedRevision !== revision
    ) {
      setRevisionPrompt(revision);
      return;
    }
    adopt(repo, revision);
  }, [
    revisionPrompt,
    requestedRepo,
    requestedRevision,
    repo,
    revision,
    selected,
    adopt,
  ]);

  // When the in-flight acquisition for this repo reaches a terminal state,
  // refresh the manifest to pick up the new local statuses.
  useEffect(() => {
    const job = jobs.find(
      (j) => j.repo === repo && j.operation === 'download_files',
    );
    if (!job) {
      processedJob.current = null;
      return;
    }
    if (
      (job.state === 'SUCCEEDED' || job.state === 'FAILED') &&
      processedJob.current !== job.id
    ) {
      processedJob.current = job.id;
      onJobFinished?.(repo);
      const rev = requestedRevision || 'main';
      void loadManifest(repo, rev);
      loadReadme(repo, rev);
    }
  }, [jobs, repo, requestedRevision, onJobFinished, loadManifest, loadReadme]);

  const rows = useMemo(
    () => (manifest ? buildGroupRows(manifest) : []),
    [manifest],
  );
  const filtered = useMemo(
    () => filterGroupRows(rows, filters),
    [rows, filters],
  );
  const sorted = useMemo(
    () => sortGroupRows(filtered, sortKey, sortDir),
    [filtered, sortKey, sortDir],
  );
  const visibleIds = useMemo(() => sorted.map((r) => r.id), [sorted]);
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  const partial =
    !allSelected && visibleIds.some((id) => selected.includes(id));
  const hiddenSelected =
    selected.length - visibleIds.filter((id) => selected.includes(id)).length;

  const summary: AcquisitionSummary | undefined =
    manifest && selected.length > 0
      ? summaryFor(manifest, selected)
      : undefined;
  const retryIds = manifest ? retryGroups(manifest, selected) : [];

  const currentJob = useMemo(
    () => jobs.find((j) => j.repo === repo && j.operation === 'download_files'),
    [jobs, repo],
  );

  function isBundle(row: GroupRow) {
    return row.kind === 'gguf_split' || row.kind === 'safetensors';
  }

  function toggleSelected(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function setHeaderSelection() {
    setSelected(
      allSelected
        ? selected.filter((id) => !visibleIds.includes(id))
        : [...new Set([...selected, ...visibleIds])],
    );
  }

  function clearSelection() {
    setSelected([]);
  }

  function downloadSelected() {
    if (!manifest || !resolvedRevision || summary?.toDownload === 0) return;
    api('/api/downloads/files', {
      repo,
      revision: resolvedRevision,
      selected,
    })
      .then((value) => {
        const j = value as Job;
        onJobFinished?.(repo);
        processedJob.current = j.id;
      })
      .catch((err) => {
        setManifestError(message(err));
      });
  }

  function retryFailed() {
    if (!manifest || !resolvedRevision || retryIds.length === 0) return;
    api('/api/downloads/files', {
      repo,
      revision: resolvedRevision,
      selected: retryIds,
    })
      .then((value) => {
        const j = value as Job;
        onJobFinished?.(repo);
        processedJob.current = j.id;
      })
      .catch((err) => {
        setManifestError(message(err));
      });
  }

  function statusBadge(status: string) {
    return (
      <Badge
        variant={STATUS_VARIANT[status] ?? 'default'}
        className="text-[10px]"
      >
        {STATUS_LABELS[status] ?? status}
      </Badge>
    );
  }

  function localStatus(row: GroupRow) {
    if (row.downloading_count > 0) return statusBadge('downloading');
    if (row.failed_count > 0) return statusBadge('failed');
    if (row.count > 0 && row.downloaded_count === row.count)
      return statusBadge('downloaded');
    if (row.downloaded_count > 0)
      return (
        <span className="text-xs text-muted-foreground">
          {row.downloaded_count}/{row.count} files
        </span>
      );
    return statusBadge('not_downloaded');
  }

  function groupStatus(row: GroupRow) {
    if (row.downloading_count > 0) return 'Downloading';
    if (row.failed_count > 0) return 'Failed';
    if (row.count > 0 && row.downloaded_count === row.count)
      return 'Downloaded';
    if (row.downloaded_count > 0)
      return `${row.downloaded_count}/${row.count} files`;
    return 'Not downloaded';
  }

  /** Click a column header: re-sort by that column, or flip direction on repeat. */
  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'size' ? 'desc' : 'asc');
    }
  }

  function jobTitle(job: Job) {
    switch (job.state) {
      case 'QUEUED':
        return `Download queued: ${repo}`;
      case 'RUNNING':
        return `Downloading ${repo}`;
      case 'SUCCEEDED':
        return `Download complete: ${repo}`;
      default:
        return `Download failed: ${repo}`;
    }
  }

  function jobDesc(job: Job) {
    if (job.state === 'FAILED') return job.error || 'Something went wrong.';
    return job.progress || (job.state === 'RUNNING' ? 'Starting…' : '');
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to models"
          onClick={() => go(returnTo ? returnTo : 'models')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="font-heading text-sm font-medium tracking-tight">
            {repo}
          </h1>
          {resolvedRevision && (
            <p className="text-xs text-muted-foreground truncate">
              Revision {resolvedRevision.slice(0, 7)}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="flex items-center gap-1.5"
          aria-label="Open model card"
          ref={cardTriggerRef}
          onClick={() => setCardOpen(true)}
        >
          <BookOpen className="h-4 w-4" />
          Model card
        </Button>
      </div>

      {manifestError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the repository files.</AlertTitle>
          <AlertDescription>{manifestError}</AlertDescription>
          <Button variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        </Alert>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 border-b p-3">
            <label className="flex w-full sm:w-96 items-center gap-2 text-xs text-muted-foreground">
              <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
              <Input
                placeholder="Filter files…"
                aria-label="Filter repository files"
                value={filters.search}
                onChange={(e) =>
                  setFilters({ ...filters, search: e.target.value })
                }
              />
            </label>
            <SelectFilter
              label="File type"
              value={filters.type}
              options={typeOptions()}
              onChange={(v) =>
                setFilters({ ...filters, type: v as RepositoryFilters['type'] })
              }
            />
            <SelectFilter
              label="Quantization"
              value={filters.quantization}
              options={quantOptions(rows)}
              onChange={(v) => setFilters({ ...filters, quantization: v })}
            />
            <SelectFilter
              label="Local status"
              value={filters.status}
              options={statusFilterOptions()}
              onChange={(v) =>
                setFilters({ ...filters, status: v as StatusFilter })
              }
            />
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setQuantGuidanceOpen((o) => !o)}
              aria-expanded={quantGuidanceOpen}
            >
              How to choose
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!anyActiveFilters(filters)}
              onClick={() =>
                setFilters({
                  search: '',
                  type: 'all',
                  quantization: 'all',
                  status: 'all',
                })
              }
            >
              Clear filters
            </Button>
            <span className="text-xs text-muted-foreground">
              {sorted.length} of {rows.length} rows
            </span>
          </div>
          {quantGuidanceOpen && (
            <div className="border-b p-2 bg-muted/25 text-xs text-muted-foreground">
              Smaller quantizations use less memory but may reduce accuracy.
              Larger ones leave less room for context and may run more slowly.
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full caption-bottom text-xs">
              <thead className="border-b">
                <tr>
                  <th
                    className="h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground"
                    style={{ width: '2.5rem' }}
                  >
                    <Checkbox
                      aria-label="Select all visible files"
                      checked={allSelected}
                      indeterminate={partial}
                      onCheckedChange={setHeaderSelection}
                    />
                  </th>
                  <SortableHeader
                    label="File"
                    columnKey="file"
                    align="left"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onToggle={toggleSort}
                  />
                  <SortableHeader
                    label="Type"
                    columnKey="type"
                    align="left"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onToggle={toggleSort}
                  />
                  <SortableHeader
                    label="Quantization"
                    columnKey="quantization"
                    align="left"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onToggle={toggleSort}
                  />
                  <SortableHeader
                    label="Size"
                    columnKey="size"
                    align="right"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onToggle={toggleSort}
                  />
                  <SortableHeader
                    label="Local status"
                    columnKey="status"
                    align="left"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onToggle={toggleSort}
                  />
                </tr>
              </thead>
              <tbody className="[&>tr:last-child]:border-0">
                {manifestLoading && (
                  <tr>
                    <td colSpan={6} className="p-4">
                      <Skeleton className="w-full h-4 rounded" />
                    </td>
                  </tr>
                )}
                {sorted.map((row) => {
                  const isRowBundle = isBundle(row);
                  const isExpanded = expanded === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr
                        className="border-b transition-colors hover:bg-muted/50"
                        style={{
                          backgroundColor: selected.includes(row.id)
                            ? 'rgb(230 246 234 / 0.25)'
                            : undefined,
                        }}
                      >
                        <td className="py-1.5" style={{ width: '2.5rem' }}>
                          <Checkbox
                            aria-label={
                              isRowBundle
                                ? `Select ${row.name} and all required files`
                                : `Select ${row.name}`
                            }
                            checked={selected.includes(row.id)}
                            onCheckedChange={() => toggleSelected(row.id)}
                          />
                        </td>
                        <td className="p-2">
                          <div className="flex items-center gap-1.5 text-xs">
                            {isRowBundle ? (
                              <button
                                type="button"
                                className="flex items-center gap-1"
                                onClick={() =>
                                  setExpanded((prev) =>
                                    prev === row.id ? null : row.id,
                                  )
                                }
                                aria-expanded={isExpanded}
                                aria-label={
                                  isExpanded
                                    ? `Hide files in ${row.name}`
                                    : `Show files in ${row.name}`
                                }
                              >
                                <span className="text-muted-foreground">
                                  {isExpanded ? '▲' : '▼'}
                                </span>
                                {row.name}
                                <span className="text-muted-foreground">
                                  · {row.count} files
                                </span>
                              </button>
                            ) : (
                              <span className="text-xs">{row.name}</span>
                            )}
                          </div>
                          {isRowBundle && !row.complete && (
                            <p className="text-[10px] text-destructive/90">
                              Incomplete model bundle
                            </p>
                          )}
                        </td>
                        <td className="p-2">
                          <Badge variant="default">{row.type}</Badge>
                        </td>
                        <td className="p-2">
                          <span className="text-xs">
                            {row.quantization === 'Unknown'
                              ? 'Unknown'
                              : row.quantization}
                          </span>
                        </td>
                        <td className="p-2 text-right text-xs">
                          {row.size === null ? '—' : bytes(row.size)}
                        </td>
                        <td className="p-2 min-w-32">
                          {isRowBundle && !row.complete ? (
                            <span className="text-[10px] text-destructive/90">
                              {groupStatus(row)}
                            </span>
                          ) : (
                            localStatus(row)
                          )}
                        </td>
                      </tr>
                      {isRowBundle &&
                        isExpanded &&
                        row.files.map((f) => (
                          <tr key={f.name} className="bg-muted/20 border-b">
                            <td
                              className="py-1"
                              style={{
                                width: '2.5rem',
                                background: 'rgba(230, 246, 234, 0.15)',
                              }}
                            />
                            <td className="p-2 text-[10px] text-muted-foreground pl-6">
                              {f.name}
                            </td>
                            <td
                              className="p-2"
                              style={{
                                background: 'rgba(230, 246, 234, 0.15)',
                              }}
                            >
                              <span className="text-[10px] text-muted-foreground">
                                {classifyFileName(f.name)}
                              </span>
                            </td>
                            <td
                              className="p-2"
                              style={{
                                background: 'rgba(230, 246, 234, 0.15)',
                              }}
                            >
                              <span className="text-[10px] text-muted-foreground">
                                {row.quantization}
                              </span>
                            </td>
                            <td className="p-2 text-right text-[10px]">
                              {f.size === null ? '—' : bytes(f.size)}
                            </td>
                            <td className="p-2 min-w-32">
                              {statusBadge(f.status)}
                            </td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t bg-muted/50 p-3 flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {summary ? (
                <>
                  {summary.count} files selected ·{' '}
                  {summary.size === null
                    ? 'download size partly unknown'
                    : bytes(summary.size) + ' to download'}
                </>
              ) : (
                'No selection'
              )}
            </span>
            {hiddenSelected > 0 && (
              <Badge variant="outline" className="text-[10px]">
                {hiddenSelected} selected file{hiddenSelected > 1 ? 's' : ''}{' '}
                hidden by filters
              </Badge>
            )}
            <div className="flex-1 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={selected.length === 0}
                onClick={clearSelection}
              >
                Clear selection
              </Button>
              {summary?.allDownloaded ? (
                <span className="text-xs text-muted-foreground">
                  All selected files are already downloaded.
                </span>
              ) : (
                <Button
                  variant="default"
                  size="sm"
                  disabled={!summary || summary.toDownload === 0}
                  onClick={downloadSelected}
                >
                  <Download className="h-3.5 w-3.5" />
                  Download selected
                </Button>
              )}
              {retryIds.length > 0 && (
                <Button variant="outline" size="sm" onClick={retryFailed}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry failed files
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => go('models/downloads')}
              >
                View downloads
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {currentJob && (
        <Alert variant="default" className="flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 text-primary shrink-0" />
          <div className="flex-1">
            <AlertTitle>{jobTitle(currentJob)}</AlertTitle>
            {currentJob.progress ? (
              <AlertDescription>{currentJob.progress}</AlertDescription>
            ) : currentJob.state !== 'QUEUED' &&
              currentJob.state !== 'SUCCEEDED' ? (
              <AlertDescription>{jobDesc(currentJob)}</AlertDescription>
            ) : null}
          </div>
        </Alert>
      )}

      <Drawer
        open={cardOpen}
        swipeDirection={mobile ? 'down' : 'right'}
        onOpenChange={(open) => setCardOpen(open)}
      >
        <DrawerContent finalFocus={cardTriggerRef}>
          <DrawerHeader>
            <div className="flex items-center justify-between gap-2">
              <DrawerTitle>Model card</DrawerTitle>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close model card"
                onClick={() => setCardOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              <a
                href={`https://huggingface.co/${repo}`}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-3 hover:text-foreground"
              >
                View on Hugging Face
              </a>
            </p>
            {resolvedRevision && (
              <p className="text-xs text-muted-foreground">
                Revision{' '}
                <span className="font-mono truncate" title={resolvedRevision}>
                  {resolvedRevision}
                </span>
              </p>
            )}
          </DrawerHeader>
          <div className="flex-1 overflow-y-auto">
            {readmeLoading ? (
              <p className="p-4 text-sm text-muted-foreground">
                Loading model card…
              </p>
            ) : readme ? (
              <SafeMarkdownArticle
                markdown={readme.content}
                repo={repo}
                revision={resolvedRevision ?? (revision || 'main')}
              />
            ) : readmeError ? (
              <Alert variant="destructive" className="p-3">
                <AlertTitle>Could not load the model card.</AlertTitle>
                <AlertDescription>
                  {readmeError} You can still browse and download files.
                </AlertDescription>
              </Alert>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                This repository has no README at this revision.
              </p>
            )}
          </div>
        </DrawerContent>
      </Drawer>

      {revisionPrompt !== null && (
        <AlertDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) keepRevision();
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Change revision?</AlertDialogTitle>
              <AlertDialogDescription>
                Your file selection belongs to{' '}
                {requestedRevision || 'the current revision'}. Changing revision
                clears the selection; downloaded files are kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={keepRevision}>
                Keep revision
              </AlertDialogCancel>
              <AlertDialogAction onClick={acceptChangeRevision}>
                Change revision
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

/** A clickable table header that sorts rows and shows direction when active. */
function SortableHeader({
  label,
  columnKey,
  align,
  sortKey,
  sortDir,
  onToggle,
}: {
  label: string;
  columnKey: SortKey;
  align: 'left' | 'right';
  sortKey: SortKey;
  sortDir: SortDir;
  onToggle: (key: SortKey) => void;
}) {
  const active = sortKey === columnKey;
  const ariaSort = active
    ? sortDir === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  return (
    <th
      className={`h-10 px-2 align-middle font-medium whitespace-nowrap text-foreground ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
      aria-sort={ariaSort}
    >
      <button
        type="button"
        className={`flex h-10 w-full items-center gap-1 text-left text-foreground hover:bg-muted/50 ${
          align === 'right' ? 'justify-end text-right' : ''
        }`}
        onClick={() => onToggle(columnKey)}
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active &&
          (sortDir === 'asc' ? (
            <ArrowUp
              className="h-3 w-3 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <ArrowDown
              className="h-3 w-3 text-muted-foreground"
              aria-hidden="true"
            />
          ))}
      </button>
    </th>
  );
}

function anyActiveFilters(f: RepositoryFilters): boolean {
  return (
    f.search.trim() !== '' ||
    f.type !== 'all' ||
    f.quantization !== 'all' ||
    f.status !== 'all'
  );
}

const TYPE_ORDER = [
  'all',
  'Model weights',
  'Projector candidate',
  'Drafting head candidate',
  'Configuration',
  'Tokenizer',
  'Documentation',
  'Other',
];

function typeOptions(): string[] {
  return [...TYPE_ORDER];
}

function quantOptions(rows: GroupRow[]): string[] {
  const set = new Set<string>(['all']);
  for (const r of rows) set.add(r.quantization);
  return [...set].sort();
}

function statusFilterOptions(): string[] {
  const opts: string[] = [];
  for (const k of Object.keys(
    STATUS_FILTER_LABELS,
  ) as (keyof typeof STATUS_FILTER_LABELS)[]) {
    if (k !== 'all') opts.push(k);
  }
  return ['all', ...opts];
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
      <span>{label}</span>
      <NativeSelect
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      >
        {options.map((o) => (
          <NativeSelectOption key={o} value={o}>
            {o === 'all'
              ? 'All'
              : ((STATUS_FILTER_LABELS as Record<string, string>)[o] ?? o)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  );
}
