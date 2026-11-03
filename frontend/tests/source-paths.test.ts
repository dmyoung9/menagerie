import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';

test('TypeScript module paths are unambiguous on case-insensitive filesystems', () => {
  const modules = new Map<string, string>();
  for (const file of readdirSync(new URL('../src/', import.meta.url), {
    recursive: true,
    encoding: 'utf8',
  })) {
    if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) continue;
    const key = file
      .replace(/\.tsx?$/, '')
      .replaceAll('\\', '/')
      .toLowerCase();
    assert(
      !modules.has(key),
      `Conflicting module paths: ${modules.get(key)} and ${file}`,
    );
    modules.set(key, file);
  }
});
