import { getBy, setBy } from '@tanstack/react-form';
import { runtimeFlags } from './runtime-flags.ts';
import type { DeploymentSetDraft, EditorDraft, JsonValue } from './types';

export type FormDraft = EditorDraft | DeploymentSetDraft;
export type ConfigPath =
  'config' | 'configuration.config' | `members[${number}].configuration.config`;

export function configurations(
  draft: FormDraft,
): [ConfigPath, Record<string, JsonValue>][] {
  if ('members' in draft)
    return draft.members.flatMap((member, index) =>
      member.configuration
        ? [
            [
              `members[${index}].configuration.config` as ConfigPath,
              member.configuration.config,
            ] as [ConfigPath, Record<string, JsonValue>],
          ]
        : [],
    );
  if ('configuration' in draft && draft.configuration)
    return [['configuration.config', draft.configuration.config]];
  if ('config' in draft) return [['config', draft.config]];
  return [];
}

export const inputKey = (path: ConfigPath, key: string) =>
  `${path.replace(/[.[\]]/g, '_')}__${key}`;

export function flagInputs(draft: FormDraft): Record<string, string> {
  return Object.fromEntries(
    configurations(draft).flatMap(([path, config]) =>
      Object.entries(config)
        .filter(([key]) => key in runtimeFlags)
        .map(([key, value]) => [inputKey(path, key), String(value)]),
    ),
  );
}

export function commitFlagInputs<T extends FormDraft>(
  draft: T,
  inputs: Record<string, string>,
): T {
  let next = draft;
  for (const [path, config] of configurations(draft))
    for (const [key, value] of Object.entries(config)) {
      const text = inputs[inputKey(path, key)];
      if (text !== undefined && text !== String(value)) {
        if (key === 'flash-attn') next = setBy(next, `${path}.${key}`, text);
        else if (text.trim() && Number.isFinite(Number(text)))
          next = setBy(next, `${path}.${key}`, Number(text));
      }
    }
  return next;
}

export function configAt(
  draft: FormDraft,
  path: ConfigPath,
): Record<string, JsonValue> {
  return getBy(draft, path) ?? {};
}

function configOwner(draft: FormDraft, path: ConfigPath): string {
  const config = path.replace(/\.?config$/, '');
  const profile = config ? getBy(draft, config) : draft;
  const member =
    'members' in draft
      ? draft.members[Number(path.match(/\[(\d+)\]/)?.[1])]
      : undefined;
  return JSON.stringify([
    member?.id ?? member?.port,
    profile?.runtime_id,
    profile?.artifact_id,
  ]);
}

/** Keep a buffer with its model, not its former array index or engine. */
export function reconcileInputs(
  previous: FormDraft,
  next: FormDraft,
  inputs: Record<string, string>,
) {
  const oldConfigs = configurations(previous);
  const reconciled: Record<string, string> = {};
  for (const [path, config] of configurations(next)) {
    const source = oldConfigs.find(
      ([oldPath]) => configOwner(previous, oldPath) === configOwner(next, path),
    );
    for (const [key, value] of Object.entries(config)) {
      if (!(key in runtimeFlags)) continue;
      const oldText = source && inputs[inputKey(source[0], key)];
      reconciled[inputKey(path, key)] =
        source && source[1][key] === value && oldText !== undefined
          ? oldText
          : String(value);
    }
  }
  return reconciled;
}
