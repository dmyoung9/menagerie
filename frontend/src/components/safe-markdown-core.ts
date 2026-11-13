/**
 * Safe, non-raw-HTML rendering of untrusted model READMEs.
 *
 * READMEs are treated as untrusted content. We never enable TanStack
 * Markdown's raw-HTML rendering (`allowHtml`) and never run a general-purpose
 * HTML sanitizer. Instead we:
 *   - Parse with `allowHtml: false`, so raw `<tag>` markup collapses into
 *     escaped text nodes and renders literally (e.g. `<svg>...` shows as text).
 *   - Generate hash-route-safe heading ids (`hf-<index>-<slug>`), never plain
 *     slugs, so in-page anchors cannot collide with the app's hash routing.
 *   - Resolve links/images through a URL transform that strips unsafe schemes
 *     and pins relative paths to the repository.
 *   - Strip Hugging Face frontmatter so it is never rendered.
 *
 * The parse is cached by (repo, revision, content) so unrelated polling never
 * re-parses or remounts the article.
 */
import { parseMarkdown, type MarkdownDocument } from '@tanstack/markdown';

export type MarkdownKind = 'link' | 'image';

/** Normalized, hash-route-safe slug from heading text. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** A heading id that is guaranteed to be safe inside a hash route. */
export function headingIdFor(text: string, index: number): string {
  return `hf-${index}-${slugify(text) || 'section'}`;
}

/** Recover the slug from a `hf-<index>-<slug>` id. */
export function slugFromId(id: string): string {
  const match = id.match(/^hf-\d+-(.+)$/);
  return match ? match[1] : '';
}

const SAFE_SCHEMES = new Set(['http:', 'https:']);

const isScheme = (u: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(u.trim());

/**
 * Sanitize a link/image URL. Returns the resolved, scheme-safe URL, or `null`
 * when the URL is unsafe (javascript:, data:, file:, etc.) or unresolvable.
 * In-page anchors (`#...`) are returned as-is so the renderer's anchor
 * handler can intercept them without changing the route. Relative paths are
 * pinned to the repository raw base (`https://huggingface.co/<repo>/raw/<rev>/`).
 */
export function resolveSafeUrl(
  url: string,
  kind: MarkdownKind,
  rawBase: string,
): string | null {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  if (!value) return null;
  if (value.startsWith('#')) return value;
  if (isScheme(value)) {
    const lower = value.toLowerCase();
    if (
      lower.startsWith('javascript:') ||
      lower.startsWith('data:') ||
      lower.startsWith('file:')
    ) {
      return null;
    }
    if (lower.startsWith('http://') || lower.startsWith('https://'))
      return value;
    if (lower.startsWith('mailto:')) return kind === 'link' ? value : null;
    return null;
  }
  // Relative path: pin to the repository raw base. A leading slash is a
  // repository-root-relative path, not an origin reset, so strip it.
  const path = value.startsWith('/') ? value.slice(1) : value;
  if (!path) return null;
  try {
    const resolved = new URL(`${rawBase}${path}`, 'https://huggingface.co');
    return SAFE_SCHEMES.has(resolved.protocol) ? resolved.href : null;
  } catch {
    return null;
  }
}

/** The repository raw base used to pin relative links/images. */
export function repoRawBaseFor(repo: string, revision: string): string {
  const safeRepo = repo.replace(/([^/]+)/g, (segment) =>
    encodeURIComponent(segment),
  );
  return `https://huggingface.co/${safeRepo}/raw/${encodeURIComponent(revision)}/`;
}

interface CacheEntry {
  document: MarkdownDocument;
}

const parseCache = new Map<string, CacheEntry>();

/**
 * Parse README markdown into a safe, pre-rendered document. Cache key is
 * (repo, revision, content); entries are bounded so long sessions stay light.
 */
export function parseSafeMarkdown(
  markdown: string,
  repo: string,
  revision: string,
): MarkdownDocument {
  const key = `${repo}\0${revision}\0${markdown}`;
  const cached = parseCache.get(key);
  if (cached) return cached.document;
  const base = repoRawBaseFor(repo, revision);
  const document = parseMarkdown(markdown, {
    allowHtml: false,
    frontmatter: true,
    headingIds: (text, index) => headingIdFor(text, index),
    urlTransform: (url, kind) => resolveSafeUrl(url, kind, base) ?? null,
  });
  if (parseCache.size >= 50) {
    const firstKey = parseCache.keys().next().value;
    if (firstKey) parseCache.delete(firstKey);
  }
  parseCache.set(key, { document });
  return document;
}

export function clearSafeMarkdownCache() {
  parseCache.clear();
}
