import type { JsonValue } from './types';

/** Refresh a schema without discarding edits or restoring deliberately cleared options. */
export function reconcileRuntimeOptions(
  current: Record<string, JsonValue>,
  defaults: Record<string, JsonValue>,
  previousKeys: string[],
  nextKeys: string[],
): Record<string, JsonValue> {
  const previous = new Set(previousKeys);
  const supported = new Set(nextKeys);
  return {
    ...Object.fromEntries(
      Object.entries(defaults).filter(([key]) => !previous.has(key)),
    ),
    ...Object.fromEntries(
      Object.entries(current).filter(
        ([key]) => !previous.has(key) || supported.has(key),
      ),
    ),
  };
}
