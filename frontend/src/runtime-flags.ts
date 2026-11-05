import type { JsonValue, RuntimeField } from './types';

// Descriptions and fallback defaults: llama.cpp tools/server/README.md.
// Installed-engine help takes precedence over this upstream reference.
export const runtimeFlags: Record<
  string,
  {
    title: string;
    syntax: string;
    default: JsonValue;
    note: string;
    min?: number;
  }
> = {
  'flash-attn': {
    title: 'Flash attention',
    syntax: '--flash-attn [on|off|auto]',
    default: 'auto',
    note: 'auto',
  },
  threads: {
    title: 'Number of CPU threads to use during generation',
    syntax: '--threads N',
    default: -1,
    note: '-1',
    min: -1,
  },
  'threads-batch': {
    title: 'Number of threads to use during batch and prompt processing',
    syntax: '--threads-batch N',
    default: -1,
    note: 'same as --threads',
    min: -1,
  },
  'batch-size': {
    title: 'Logical maximum batch size',
    syntax: '--batch-size N',
    default: 2048,
    note: '2048',
  },
  'ubatch-size': {
    title: 'Physical maximum batch size',
    syntax: '--ubatch-size N',
    default: 512,
    note: '512',
  },
  temp: {
    title: 'Temperature',
    syntax: '--temp N',
    default: 0.8,
    note: '0.80',
  },
  'top-p': {
    title: 'Top-p sampling',
    syntax: '--top-p N',
    default: 0.95,
    note: '0.95, 1.0 = disabled',
  },
  'top-k': {
    title: 'Top-k sampling',
    syntax: '--top-k N',
    default: 40,
    note: '40, 0 = disabled',
  },
  'min-p': {
    title: 'Min-p sampling',
    syntax: '--min-p N',
    default: 0.05,
    note: '0.05, 0.0 = disabled',
  },
  'presence-penalty': {
    title: 'Repeat alpha presence penalty',
    syntax: '--presence-penalty N',
    default: 0,
    note: '0.00, 0.0 = disabled',
  },
  'repeat-penalty': {
    title: 'Penalize repeat sequence of tokens',
    syntax: '--repeat-penalty N',
    default: 1,
    note: '1.00, 1.0 = disabled',
  },
  'reasoning-budget': {
    title: 'Token budget for thinking',
    syntax: '--reasoning-budget N',
    default: -1,
    note: '-1; -1 = unrestricted, 0 = immediate end',
  },
};

export function flagDefault(
  key: string,
  schema: Record<string, RuntimeField>,
  value: Record<string, JsonValue>,
): JsonValue {
  const field = schema[key] ?? {};
  const source =
    field.default_from ?? (key === 'threads-batch' ? 'threads' : undefined);
  return (
    (source ? (value[source] ?? schema[source]?.engine_default) : undefined) ??
    field.engine_default ??
    runtimeFlags[key].default
  );
}

export function flagDefaultNote(key: string, field: RuntimeField): string {
  if (field.default_from) return `same as --${field.default_from}`;
  if (field.default_note) return field.default_note;
  if (field.engine_default !== undefined) {
    const [, suffix] = runtimeFlags[key].note.split(/,(.*)/s);
    return `${field.engine_default}${suffix ? `,${suffix}` : ''}`;
  }
  return runtimeFlags[key].note;
}
