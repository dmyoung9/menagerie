import type { Artifact } from './types';

const positiveNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

/** Metadata is extensible; narrow only the fields the configuration UI consumes. */
export function artifactLimits(
  artifact?: Pick<Artifact, 'architecture' | 'metadata'>,
): { context?: number; layers?: number } {
  const metadata = artifact?.metadata || {};
  const hf = metadata.config?.text_config || metadata.config || {};
  return {
    context:
      positiveNumber(metadata[`${artifact?.architecture}.context_length`]) ??
      positiveNumber(hf.max_position_embeddings),
    layers:
      positiveNumber(metadata[`${artifact?.architecture}.block_count`]) ??
      positiveNumber(hf.num_hidden_layers),
  };
}
