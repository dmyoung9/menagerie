import { z } from 'zod';
import type { JsonValue, RuntimeField } from './types';

// Stable structural contract. Optional means omitted, never an implicit default.
export const runtimeFlagSchema = z
  .object({
    'flash-attn': z.enum(['auto', 'on', 'off']).optional(),
    threads: z.number().int().optional(),
    'threads-batch': z.number().int().optional(),
    'batch-size': z.number().int().optional(),
    'ubatch-size': z.number().int().optional(),
    temp: z.number().optional(),
    'top-p': z.number().optional(),
    'top-k': z.number().int().optional(),
    'min-p': z.number().optional(),
    'presence-penalty': z.number().optional(),
    'repeat-penalty': z.number().optional(),
    'reasoning-budget': z.number().int().optional(),
  })
  .catchall(z.unknown());

export const numericTextSchema = z
  .string()
  .trim()
  .min(1, 'Enter a number.')
  .refine((text) => Number.isFinite(Number(text)), 'Enter a finite number.');

export function flagError(
  key: string,
  value: JsonValue,
  schema: Record<string, RuntimeField>,
  config: Record<string, JsonValue>,
): string | undefined {
  const structural = runtimeFlagSchema.safeParse({ [key]: value });
  if (!structural.success)
    return typeof value === 'number'
      ? 'Enter a whole number.'
      : 'Choose a valid value.';
  const field = schema[key];
  if (!field) return;
  if (typeof value === 'number') {
    if (field.type === 'integer' && !Number.isInteger(value))
      return 'Enter a whole number.';
    if (field.min !== undefined && value < field.min)
      return `Enter at least ${field.min}.`;
    if (field.max !== undefined && value > field.max)
      return `Enter at most ${field.max}.`;
  }
  if (
    field.choices &&
    (typeof value !== 'string' || !field.choices.includes(value))
  )
    return 'Choose a supported value.';
  if (key === 'batch-size' || key === 'ubatch-size') {
    const batch = config['batch-size'] ?? schema['batch-size']?.engine_default;
    const physical =
      config['ubatch-size'] ?? schema['ubatch-size']?.engine_default;
    if (
      typeof batch === 'number' &&
      typeof physical === 'number' &&
      physical > batch
    )
      return 'Physical batch must not exceed batch size.';
  }
  if (
    key === 'flash-attn' &&
    value === 'off' &&
    (config['cache-type-v'] ??
      schema['cache-type-v']?.engine_default ??
      schema['cache-type-v']?.default ??
      'f16') !== 'f16'
  )
    return 'Quantized V cache requires flash attention.';
}

export function numericFlagError(
  key: string,
  text: string,
  schema: Record<string, RuntimeField>,
  config: Record<string, JsonValue>,
) {
  const parsed = numericTextSchema.safeParse(text);
  if (!parsed.success) return parsed.error.issues[0].message;
  return flagError(key, Number(parsed.data), schema, config);
}
