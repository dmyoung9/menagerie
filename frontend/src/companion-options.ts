import type { Artifact, JsonValue } from './types/index.ts';

export type CompanionOption = { name: string; path: string };

export function hasEmbeddedMtp(model?: Artifact): boolean {
  const meta = model?.metadata || {};
  const count = Number(meta[`${model?.architecture}.nextn_predict_layers`]);
  const layers = Number(meta[`${model?.architecture}.block_count`]);
  // A head-only file can also carry nextn metadata; it is not an embedded head.
  return model?.format === 'gguf' && count > 0 && layers > count;
}

export function companionOptions(
  model: Artifact | undefined,
  models: Artifact[],
) {
  const projectors: CompanionOption[] = [];
  const heads: CompanionOption[] = [];
  const add = (list: CompanionOption[], option: CompanionOption) => {
    if (option.path && !list.some((o) => o.path === option.path))
      list.push(option);
  };
  if (model?.metadata?.projector) add(projectors, model.metadata.projector);
  for (const candidate of models) {
    // A pinned source association, not a similar filename, establishes matching.
    if (
      !model?.repo ||
      !model.source_revision ||
      candidate.repo !== model.repo ||
      candidate.source_revision !== model.source_revision
    )
      continue;
    if (
      candidate.metadata?.projector &&
      candidate.architecture === model.architecture
    )
      add(projectors, candidate.metadata.projector);
    const meta = candidate.metadata || {};
    const arch = candidate.architecture;
    const nextn = Number(meta[`${arch}.nextn_predict_layers`]);
    const layers = Number(meta[`${arch}.block_count`]);
    const sameArchitecture =
      arch === model.architecture ||
      arch === `${model.architecture}-mtp` ||
      arch === `${model.architecture}-assistant`;
    if (
      candidate.id !== model.id &&
      candidate.format === 'gguf' &&
      candidate.local_path &&
      sameArchitecture &&
      nextn > 0 &&
      layers === nextn
    )
      add(heads, { name: candidate.name, path: candidate.local_path });
  }
  return { projectors, heads };
}

export function selectMtp(
  config: Record<string, JsonValue>,
  head: string,
  draftKey: string,
) {
  const next = { ...config };
  delete next['model-draft'];
  delete next['spec-draft-model'];
  next['spec-type'] = head ? 'draft-mtp' : 'none';
  if (head && head !== 'embedded') next[draftKey] = head;
  return next;
}
