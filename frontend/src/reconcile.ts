import { isRecord } from './ui';
import { editable } from './editor-state';
import type {
  DeploymentSet,
  DeploymentSetDraft,
  DeploymentDraft,
  EditableSourceMap,
  ProfileDraft,
  RuntimeDraft,
} from './types';

export type DraftLike = Record<string, unknown>;

export type RecordKind = 'profiles' | 'deployments' | 'runtimes';

type EditorKindDraft<K extends RecordKind> = K extends 'profiles'
  ? ProfileDraft
  : K extends 'deployments'
    ? DeploymentDraft
    : RuntimeDraft;

/** Deep equality that treats missing keys as distinct from present values.
 *  An omitted field is an explicit choice (engine default), so it must never
 *  be "reconciled" into or out of existence silently. */
export function sameValue(
  a: unknown,
  b: unknown,
  aHasKey: boolean,
  bHasKey: boolean,
): boolean {
  if (aHasKey !== bHasKey) return false;
  if (!aHasKey) return true;
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      sameValue(
        (a as DraftLike)[key],
        (b as DraftLike)[key],
        key in a,
        key in b,
      ),
    );
  }
  return a === b;
}

/** Merge the fresh server value into the user's draft, using `old` as the
 * reference for what the user was based on. A field the user never touched
 * adopts the fresh value; a field the user touched keeps the user's value,
 * including explicit omissions. Nested objects merge field by field so a
 * partial edit does not discard unrelated server changes inside it. */
export function reconcileDeep(
  old: DraftLike,
  fresh: DraftLike,
  user: DraftLike,
): DraftLike {
  const keys = new Set([
    ...Object.keys(user),
    ...Object.keys(old),
    ...Object.keys(fresh),
  ]);
  const out: DraftLike = {};
  for (const key of keys) {
    const touched = !sameValue(user[key], old[key], key in user, key in old);
    if (touched) {
      if (key in user)
        out[key] =
          isRecord(user[key]) && isRecord(fresh[key])
            ? reconcileDeep(
                (old[key] ?? {}) as DraftLike,
                fresh[key],
                user[key],
              )
            : user[key];
    } else if (key in fresh) out[key] = fresh[key];
  }
  return out;
}

/** Draft shape for a saved record of an editor kind. */
export function kindDraft<K extends RecordKind>(
  kind: K,
  row: EditableSourceMap[K],
): { kind: K; value: EditorKindDraft<K> } {
  return { kind, value: editable(kind, row) as EditorKindDraft<K> };
}

/** Draft shape for a saved deployment set (multi-model group). Mirrors the
 * initial conversion the set editor uses for `initial`. */
export function deploymentSetToDraft(set: DeploymentSet): DeploymentSetDraft {
  return {
    name: 'New deployment',
    engine_pool: false,
    max_loaded: 4,
    residency: 'on-demand',
    priority: 50,
    idle_timeout: 300,
    allow_eviction: false,
    enabled: true,
    queue_timeout: 300,
    ...(set
      ? {
          id: set.id,
          name: set.name,
          engine_pool: set.engine_pool ?? false,
          max_loaded: set.max_loaded ?? 4,
          residency: set.residency || 'on-demand',
          priority: set.priority ?? 50,
          idle_timeout: set.idle_timeout ?? 300,
          allow_eviction: set.allow_eviction ?? false,
          enabled: set.enabled,
          queue_timeout: set.queue_timeout ?? 300,
        }
      : {}),
    members: (set?.members || []).map((m) => editable('deployments', m)),
  };
}
