import type { ManifestGroup, RepositoryManifest } from './types';

export type RepoType =
  | 'Model weights'
  | 'Projector candidate'
  | 'Drafting head candidate'
  | 'Configuration'
  | 'Tokenizer'
  | 'Documentation'
  | 'Other';

export type SortKey = 'file' | 'type' | 'quantization' | 'size' | 'status';
export type SortDir = 'asc' | 'desc';

export type StatusFilter =
  'all' | 'not_downloaded' | 'downloading' | 'downloaded' | 'failed';
export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: 'All',
  not_downloaded: 'Not downloaded',
  downloading: 'Downloading',
  downloaded: 'Downloaded',
  failed: 'Failed',
};

export interface GroupRow {
  id: string;
  name: string;
  kind: string;
  count: number;
  complete: boolean;
  type: RepoType;
  quantization: string;
  size: number | null;
  /** Coarse bucket used by the Local status filter. */
  statusBucket: 'not_downloaded' | 'downloading' | 'downloaded' | 'failed';
  /** Precise cell text (may be a partial count). */
  statusLabel: string;
  local_status: Record<string, string>;
  downloaded_count: number;
  failed_count: number;
  downloading_count: number;
  files: { name: string; size: number | null; status: string }[];
}

/**
 * Classify a single file name into a model-card "type" bucket. Unknown files
 * stay "Other" and are never hidden.
 */
export function classifyFileName(name: string): RepoType {
  const lower = name.toLowerCase();
  // A drafting head is a distinct model identified by "draft" in its name; it
  // wins over the generic weights buckets.
  if (lower.includes('draft')) return 'Drafting head candidate';
  // Extension-based classification is unambiguous and takes priority over
  // substring guesses (so `my_model.safetensors` is weights, not config).
  if (lower.endsWith('.safetensors')) return 'Model weights';
  if (lower.endsWith('.gguf'))
    return lower.includes('mmproj') ? 'Projector candidate' : 'Model weights';
  // Tokenizer files beat config files (tokenizer_config.json is a tokenizer).
  if (
    lower.includes('tokenizer') ||
    lower.includes('vocab') ||
    lower.includes('special_tokens')
  )
    return 'Tokenizer';
  if (lower.includes('config')) return 'Configuration';
  if (
    lower.endsWith('.md') ||
    lower.includes('readme') ||
    lower.includes('license') ||
    lower.includes('terms')
  )
    return 'Documentation';
  return 'Other';
}

/** The type of a whole group (dominant kind + file classification). */
export function groupType(group: ManifestGroup): RepoType {
  if (group.kind === 'gguf_split' || group.kind === 'safetensors') {
    return 'Model weights';
  }
  // companion / standalone: classify from the representative name.
  const named = group.required[0];
  return named ? classifyFileName(named) : 'Other';
}

/**
 * The quantization label for a group, derived from its file names. A split
 * GGUF bundle and safetensors weights share one base; pick the most common
 * detected quantization, falling back to "Unknown" (never hides the row).
 */
export function groupQuantization(group: ManifestGroup): string {
  const counts: Record<string, number> = {};
  for (const n of group.required) {
    const q = detectQuant(n);
    if (q === 'Unknown') continue; // unlabelled files don't vote
    counts[q] = (counts[q] || 0) + 1;
  }
  if (!counts || Object.keys(counts).length === 0) return 'Unknown';
  // Prefer the most common detected quantization; tie-broken alphabetically so
  // the result is deterministic (a split bundle's members share one stem, so
  // the whole bundle votes the same quantization).
  const best = Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0];
  return best ? best[0] : 'Unknown';
}

/** Extract a quantization label from a single file name. */
export function detectQuant(name: string): string {
  const stem = name.replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/i, '');
  const m = stem.match(
    /(?:^|[-_/])((?:IQ\d+|Q\d+K|Q\d+_K|Q\d+|FP\d+|F\d+|BF\d+|W\d+\+B\d+|W\d+_B\d+))(?:-\d{5}-of-\d{5})?/i,
  );
  if (!m) return 'Unknown';
  let q = m[1].toUpperCase();
  // Normalize the short forms to canonical GGUF labels (Q5K -> Q5_K).
  q = q.replace(/(Q\d+)K$/, '$1_K');
  return q;
}

/** Total required files in a group. */
export function groupFileCount(group: ManifestGroup): number {
  return group.required.length;
}

/** Coarse local-status bucket for a group (drives the filter). */
export function groupStatusBucket(
  group: ManifestGroup,
): 'not_downloaded' | 'downloading' | 'downloaded' | 'failed' {
  if (group.downloading_count > 0) return 'downloading';
  if (group.failed_count > 0) return 'failed';
  if (group.downloaded_count >= groupFileCount(group)) return 'downloaded';
  return 'not_downloaded';
}

/** Precise cell text for a group's local status. */
export function groupStatusLabel(group: ManifestGroup): string {
  if (group.downloading_count > 0) return 'Downloading';
  if (group.failed_count > 0) return 'Failed';
  if (group.downloaded_count >= groupFileCount(group)) return 'Downloaded';
  if (group.downloaded_count > 0)
    return `${group.downloaded_count}/${groupFileCount(group)} files`;
  return 'Not downloaded';
}

const TYPE_ORDER: Record<string, number> = {
  'Model weights': 0,
  'Projector candidate': 1,
  'Drafting head candidate': 2,
  Configuration: 3,
  Tokenizer: 4,
  Documentation: 5,
  Other: 6,
};

/** Build display rows from a manifest. `size` is summed over a group's
 * required files (null if any member has an unknown size). */
export function buildGroupRows(manifest: RepositoryManifest): GroupRow[] {
  const sizeBy = new Map<string, number | null>();
  for (const f of manifest.files) {
    sizeBy.set(f.name, f.size);
  }
  return manifest.groups.map((group) => {
    let size: number | null = null;
    let unknown = false;
    for (const n of group.required) {
      const s = sizeBy.get(n);
      if (s === null || s === undefined) {
        unknown = true;
        continue;
      }
      size = (size || 0) + s;
    }
    if (unknown) size = null;
    const files = group.required.map((name) => ({
      name,
      size: sizeBy.get(name) ?? null,
      status: group.local_status[name] || 'not_downloaded',
    }));
    return {
      id: group.id,
      name: group.name,
      kind: group.kind,
      count: group.required.length,
      complete: group.complete,
      type: groupType(group),
      quantization: groupQuantization(group),
      size,
      statusBucket: groupStatusBucket(group),
      statusLabel: groupStatusLabel(group),
      local_status: group.local_status,
      downloaded_count: group.downloaded_count,
      failed_count: group.failed_count,
      downloading_count: group.downloading_count,
      files,
    };
  });
}

export interface RepositoryFilters {
  search: string;
  type: 'all' | RepoType;
  quantization: string;
  status: StatusFilter;
}

export function filterGroupRows(
  rows: GroupRow[],
  filters: RepositoryFilters,
): GroupRow[] {
  const q = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    const matchesSearch =
      !q ||
      row.name.toLowerCase().includes(q) ||
      row.files.some((f) => f.name.toLowerCase().includes(q));
    const matchesType =
      filters.type === 'all' || row.type === (filters.type as RepoType);
    const matchesQuant =
      filters.quantization === 'all' ||
      row.quantization === filters.quantization;
    const matchesStatus =
      filters.status === 'all' || row.statusBucket === filters.status;
    return matchesSearch && matchesType && matchesQuant && matchesStatus;
  });
}

/** Case-insensitive name comparison, the common tie-break for every sort. */
function nameCmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

/** Primary comparator for one sort key, without direction. Direction is applied
 * by the caller so the table can flip asc/desc on a single click. */
function compareRows(a: GroupRow, b: GroupRow, key: SortKey): number {
  switch (key) {
    case 'file':
      return nameCmp(a.name, b.name);
    case 'type': {
      const cmp = (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9);
      return cmp === 0 ? nameCmp(a.name, b.name) : cmp;
    }
    case 'quantization': {
      const cmp = a.quantization.localeCompare(b.quantization, undefined, {
        sensitivity: 'base',
      });
      return cmp === 0 ? nameCmp(a.name, b.name) : cmp;
    }
    case 'size': {
      const cmp = (a.size ?? -1) - (b.size ?? -1);
      return cmp === 0 ? nameCmp(a.name, b.name) : cmp;
    }
    case 'status': {
      const order: Record<string, number> = {
        not_downloaded: 0,
        downloading: 1,
        downloaded: 2,
        failed: 3,
      };
      const cmp = (order[a.statusBucket] ?? 4) - (order[b.statusBucket] ?? 4);
      return cmp === 0 ? nameCmp(a.name, b.name) : cmp;
    }
    default:
      return nameCmp(a.name, b.name);
  }
}

export function sortGroupRows(
  rows: GroupRow[],
  key: SortKey,
  dir: SortDir,
): GroupRow[] {
  const dirMult = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => compareRows(a, b, key) * dirMult);
}

const sizeOf = (manifest: RepositoryManifest): Map<string, number | null> => {
  const out = new Map<string, number | null>();
  for (const f of manifest.files) out.set(f.name, f.size);
  return out;
};
const fileSizes = sizeOf;

const statusOf = (manifest: RepositoryManifest): Map<string, string> => {
  const out = new Map<string, string>();
  for (const f of manifest.files) out.set(f.name, f.status);
  return out;
};
const fileStatusMap = statusOf;

/** Resolve a selection (group ids) to the flat set of required file paths,
 * mirroring `required_files` on the server. */
export function selectionToFiles(
  manifest: RepositoryManifest,
  selected: string[],
): string[] {
  const byId = new Map<string, ManifestGroup>();
  for (const g of manifest.groups) byId.set(g.id, g);
  const needed = new Set<string>();
  for (const id of selected) {
    const g = byId.get(id);
    if (!g) continue; // stale id; server rejects, but skip defensively.
    for (const n of g.required) needed.add(n);
  }
  return [...needed].sort();
}

export interface AcquisitionSummary {
  count: number; // required files in the selection
  size: number | null; // null => "partly unknown" (at least one byte count unknown)
  toDownload: number; // files the Download action would still transfer
  retryFiles: string[]; // failed/missing required files ("Retry failed files")
  allDownloaded: boolean;
}

/** Required files that would still transfer on "Download selected" (everything
 * except already-downloaded and in-flight files). */
function filesToTransfer(
  manifest: RepositoryManifest,
  required: string[],
): string[] {
  const status = fileStatusMap(manifest);
  return required.filter(
    (n) => status.get(n) !== 'downloaded' && status.get(n) !== 'downloading',
  );
}

export function summaryFor(
  manifest: RepositoryManifest,
  selected: string[],
): AcquisitionSummary {
  const sizes = fileSizes(manifest);
  const required = selectionToFiles(manifest, selected);
  const toDownload = filesToTransfer(manifest, required);
  const retryFiles = required.filter(
    (n) =>
      fileStatusMap(manifest).get(n) === 'failed' ||
      fileStatusMap(manifest).get(n) === 'missing',
  );
  let size: number | null = 0;
  let unknown = false;
  for (const n of toDownload) {
    const s = sizes.get(n);
    if (s === null || s === undefined) unknown = true;
    else size = (size || 0) + s;
  }
  if (unknown) size = null;
  return {
    count: required.length,
    size,
    toDownload: toDownload.length,
    retryFiles,
    allDownloaded: toDownload.length === 0,
  };
}

/** Group ids whose required files contain a failed or missing byte — the
 * payload for "Retry failed files". */
export function retryGroups(
  manifest: RepositoryManifest,
  selected: string[],
): string[] {
  const status = fileStatusMap(manifest);
  const out: string[] = [];
  const byId = new Map<string, ManifestGroup>();
  for (const g of manifest.groups) byId.set(g.id, g);
  const retryFiles = new Set(
    selectionToFiles(manifest, selected).filter(
      (n) => status.get(n) === 'failed' || status.get(n) === 'missing',
    ),
  );
  if (!retryFiles.size) return out;
  for (const id of selected) {
    const g = byId.get(id);
    if (!g) continue;
    if (g.required.some((n) => retryFiles.has(n))) out.push(id);
  }
  return out;
}

/** A set of group ids that are currently *visible* after filtering + sorting. */
export function visibleIds(
  rows: GroupRow[],
  filters: RepositoryFilters,
  sortKey: SortKey,
  sortDir: SortDir,
): string[] {
  const visible = filterGroupRows(rows, filters);
  sortGroupRows(visible, sortKey, sortDir);
  return visible.map((r) => r.id);
}
