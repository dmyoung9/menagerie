import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changeControl,
  controlFor,
  parseMapping,
} from '../src/variant-mapping.ts';
import { canNavigate, setNavigationGuard } from '../src/navigation.ts';

test('guided edits preserve additional request and chat template settings', () => {
  const original = {
    reasoning_effort: 'high',
    thinking_budget: 8192,
    chat_template_kwargs: { style: 'research', enable_thinking: true },
  };
  assert.equal(controlFor(original), 'custom');
  const effort = changeControl(original, 'custom', 'effort', 'low');
  assert.deepEqual(effort, original);
  assert.deepEqual(changeControl(effort, 'effort', 'thinking', 'instant'), {
    thinking_budget: 8192,
    chat_template_kwargs: { style: 'research', enable_thinking: false },
  });
  assert.deepEqual(original.reasoning_effort, 'high');
});

test('simple mappings recognize guided controls for both effort destinations and budget keys', () => {
  assert.equal(controlFor({ thinking_budget: -1 }), 'budget');
  assert.equal(
    controlFor({ chat_template_kwargs: { reasoning_effort: 'max' } }),
    'effort',
  );
  assert.equal(controlFor({ reasoning_budget: 8192 }), 'budget');
  assert.equal(controlFor({ reasoning_effort: 'low' }), 'effort');
  assert.equal(
    controlFor({ chat_template_kwargs: { enable_thinking: false } }),
    'thinking',
  );
});

test('request JSON accepts composite reasoning mappings but rejects unsupported fields and malformed values', () => {
  const body = {
    reasoning_effort: 'ultra',
    reasoning_budget: 1234,
    chat_template_kwargs: { style: ['research'], enable_thinking: false },
  };
  assert.deepEqual(parseMapping(JSON.stringify(body)), body);
  for (const value of [
    '{invalid',
    '[]',
    'null',
    '{"temperature":1}',
    '{"reasoning_effort":" "}',
    '{"reasoning_budget":1.2}',
    '{"thinking_budget":-2}',
    '{"chat_template_kwargs":{"messages":[]}}',
    '{"chat_template_kwargs":{"enable_thinking":"yes"}}',
    '{"chat_template_kwargs":{"__proto__":{}}}',
  ]) {
    assert.throws(() => parseMapping(value), value);
  }
});

test('nested navigation guards preserve the parent and require both drafts to permit navigation', async () => {
  let calls = '';
  const parent = setNavigationGuard(async () => {
    calls += 'p';
    return false;
  });
  const child = setNavigationGuard(async () => {
    calls += 'c';
    return true;
  });
  assert.equal(await canNavigate(), false);
  assert.equal(calls, 'cp');
  child();
  calls = '';
  assert.equal(await canNavigate(), false);
  assert.equal(calls, 'p');
  parent();
  assert.equal(await canNavigate(), true);
});
