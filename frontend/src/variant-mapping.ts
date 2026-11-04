import type { JsonObject, JsonValue } from './types';
import { jsonObject } from './contracts.ts';
import { mappingKind, standardReasoningIds } from './capabilityOptions.ts';

export type Control = 'effort' | 'budget' | 'thinking' | 'custom';

export function controlFor(body: JsonObject): Control {
  const kind = mappingKind(body);
  if (kind === 'effort' || kind === 'template-effort') return 'effort';
  if (kind === 'template') return 'thinking';
  if (kind === 'reasoning_budget' || kind === 'thinking_budget')
    return 'budget';
  return 'custom';
}

export function templateArgs(body: JsonObject): JsonObject {
  const value = body.chat_template_kwargs;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

/** Change only the guided control, never discard other JSON/template settings. */
export function changeControl(
  body: JsonObject,
  from: Control,
  to: Control,
  id: string,
): JsonObject {
  if (to === 'custom') return body;
  const next = { ...body };
  const kwargs = { ...templateArgs(body) };
  if (from === 'effort') {
    delete next.reasoning_effort;
    delete kwargs.reasoning_effort;
  } else if (from === 'budget') {
    delete next.reasoning_budget;
    delete next.thinking_budget;
  } else if (from === 'thinking') delete kwargs.enable_thinking;
  if (Object.keys(kwargs).length) next.chat_template_kwargs = kwargs;
  else delete next.chat_template_kwargs;
  if (to === 'effort')
    next.reasoning_effort =
      typeof body.reasoning_effort === 'string'
        ? body.reasoning_effort
        : id === 'instant'
          ? 'none'
          : standardReasoningIds.includes(id)
            ? id
            : 'medium';
  if (to === 'budget')
    next.reasoning_budget =
      typeof body.reasoning_budget === 'number' ? body.reasoning_budget : 4096;
  if (to === 'thinking')
    next.chat_template_kwargs = {
      ...kwargs,
      enable_thinking: id !== 'instant',
    };
  return next;
}

const controlKey = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
function templateValue(value: JsonValue, depth = 0): boolean {
  if (depth > 4) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 4096;
  if (typeof value === 'number')
    return (
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Math.abs(value) <= 2 ** 53)
    );
  if (Array.isArray(value))
    return (
      value.length <= 64 && value.every((v) => templateValue(v, depth + 1))
    );
  return (
    Object.keys(value).length <= 64 &&
    Object.entries(value).every(
      ([k, v]) =>
        controlKey.test(k) &&
        !['__proto__', 'prototype', 'constructor'].includes(k) &&
        templateValue(v, depth + 1),
    )
  );
}

/** Mirror the reasoning-only backend boundary before applying the local draft. */
export function parseMapping(text: string): JsonObject {
  const body = jsonObject(JSON.parse(text) as unknown);
  if (
    Object.keys(body).some(
      (k) =>
        ![
          'reasoning_effort',
          'reasoning_budget',
          'thinking_budget',
          'chat_template_kwargs',
        ].includes(k),
    )
  )
    throw new Error(
      'Only reasoning_effort, reasoning_budget, thinking_budget and chat_template_kwargs are supported.',
    );
  if (
    'reasoning_effort' in body &&
    (typeof body.reasoning_effort !== 'string' ||
      !body.reasoning_effort.trim() ||
      body.reasoning_effort.length > 128)
  )
    throw new Error('Effort must contain 1–128 characters.');
  for (const key of ['reasoning_budget', 'thinking_budget']) {
    if (
      key in body &&
      (typeof body[key] !== 'number' ||
        !Number.isInteger(body[key]) ||
        body[key] < -1 ||
        body[key] > 1048576)
    )
      throw new Error(
        'Token budgets must be whole numbers from -1 to 1048576.',
      );
  }
  if ('chat_template_kwargs' in body) {
    const kwargs = body.chat_template_kwargs;
    if (
      !kwargs ||
      typeof kwargs !== 'object' ||
      Array.isArray(kwargs) ||
      !templateValue(kwargs) ||
      JSON.stringify(kwargs).length > 16384 ||
      Object.keys(kwargs).some((k) =>
        [
          'messages',
          'tools',
          'add_generation_prompt',
          'bos_token',
          'eos_token',
        ].includes(k),
      ) ||
      ('enable_thinking' in kwargs &&
        typeof kwargs.enable_thinking !== 'boolean')
    )
      throw new Error('Invalid or reserved chat template arguments.');
  }
  return body;
}
