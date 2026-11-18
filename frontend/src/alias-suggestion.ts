/**
 * Client-side resolution of a model's deterministic API identifier.
 *
 * The server is the authoritative source for the slug (see the backend
 * `slug` contract). This module fetches it via `/api/deployments/alias/suggest`
 * and falls back to a small local approximation only so the save path still
 * works when the suggestion request fails; the fallback is never presented as
 * the authoritative value.
 */

import { object, oneOf, string } from './decode.ts';

export type IdentifierMode = 'generated' | 'custom';

export type AliasSuggestion = {
  alias: string;
  base: string;
  mode: IdentifierMode;
};

const aliasSuggestionDecoder = object<AliasSuggestion>({
  alias: string,
  base: string,
  mode: oneOf('generated', 'custom'),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Format a FastAPI error payload into one readable message. */
function formatApiError(detail: unknown): string {
  if (Array.isArray(detail)) {
    return detail
      .map((item: unknown) =>
        isRecord(item)
          ? `${
              Array.isArray(item.loc)
                ? (item.loc as string[]).slice(1).join('.')
                : ''
            }: ${String(item.msg ?? '')}`
          : String(item),
      )
      .join('\n');
  }
  if (typeof detail === 'string') return detail;
  return JSON.stringify(detail);
}

export async function fetchSuggestedAlias(
  name: string,
  exclude?: string,
): Promise<AliasSuggestion> {
  const path =
    '/api/deployments/alias/suggest?name=' +
    encodeURIComponent(name) +
    (exclude ? '&exclude=' + encodeURIComponent(exclude) : '');
  const response = await fetch(path, {});
  const data: unknown = await response.json();
  if (!response.ok) {
    const detail = isRecord(data) ? data.detail || data.error : data;
    throw new Error(formatApiError(detail));
  }
  return aliasSuggestionDecoder(data, path);
}

/**
 * Local approximation used only as a last-resort save fallback when the
 * suggestion request cannot be made. Never authoritative; the server slug is.
 */
export function localAliasFallback(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 140) || 'model'
  );
}
