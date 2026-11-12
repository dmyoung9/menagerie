import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  slugify,
  headingIdFor,
  slugFromId,
  resolveSafeUrl,
  repoRawBaseFor,
  parseSafeMarkdown,
  clearSafeMarkdownCache,
} from '../src/components/safe-markdown-core.ts';

const base = repoRawBaseFor('org/model', 'abc');
assert.ok(base.startsWith('https://huggingface.co/org/model/raw/abc/'));

test('slugify collapses whitespace and punctuation to single dashes and lowercases', () => {
  assert.equal(slugify('Model Card'), 'model-card');
  assert.equal(slugify('### Weird!!!'), 'weird');
  assert.equal(slugify('  spaced  out  '), 'spaced-out');
  assert.equal(slugify(''), '');
  assert.equal(slugify('A B C D'), 'a-b-c-d');
});

test('heading ids are hash-route-safe (hf-<index>-<slug>, never a bare slug)', () => {
  assert.equal(headingIdFor('Model Card', 0), 'hf-0-model-card');
  assert.equal(headingIdFor('Features', 1), 'hf-1-features');
  assert.equal(headingIdFor('', 2), 'hf-2-section');
  assert.equal(headingIdFor('A/B/C', 3), 'hf-3-a-b-c');
  for (const text of ['Model Card', '# Hash', 'Path/To/Here', 'Plain', '   ']) {
    const id = headingIdFor(text, 9);
    assert.match(id, /^hf-\d+-[a-z0-9-]+$/);
  }
});

test('slugFromId round-trips the slug portion of an hf id', () => {
  assert.equal(slugFromId('hf-0-model-card'), 'model-card');
  assert.equal(slugFromId('hf-42-a-b-c'), 'a-b-c');
  assert.equal(slugFromId('not-an-hf-id'), '');
  assert.equal(slugFromId('hf-0-'), '');
});

test('resolveSafeUrl pins relative links/images to the repo raw base', () => {
  assert.equal(
    resolveSafeUrl('/images/cat.png', 'image', base),
    'https://huggingface.co/org/model/raw/abc/images/cat.png',
  );
  assert.equal(
    resolveSafeUrl('images/cat.png', 'image', base),
    'https://huggingface.co/org/model/raw/abc/images/cat.png',
  );
  // `..` from the raw base climbs back into raw/, never escaping the repo.
  assert.equal(
    resolveSafeUrl('../other.md', 'link', base),
    'https://huggingface.co/org/model/raw/other.md',
  );
  assert.equal(
    resolveSafeUrl('/README.md', 'link', base),
    'https://huggingface.co/org/model/raw/abc/README.md',
  );
});

test('resolveSafeUrl passes through absolute http(s) and mailto, preserves in-page anchors', () => {
  assert.equal(
    resolveSafeUrl('https://huggingface.co/x', 'link', base),
    'https://huggingface.co/x',
  );
  assert.equal(
    resolveSafeUrl('http://example.com/a.png', 'image', base),
    'http://example.com/a.png',
  );
  assert.equal(resolveSafeUrl('mailto:a@b.co', 'link', base), 'mailto:a@b.co');
  assert.equal(resolveSafeUrl('mailto:a@b.co', 'image', base), null);
  assert.equal(resolveSafeUrl('#section', 'link', base), '#section');
  assert.equal(resolveSafeUrl('#section-two', 'link', base), '#section-two');
});

test('resolveSafeUrl blocks javascript:, data:, and file: schemes', () => {
  assert.equal(resolveSafeUrl('javascript:alert(1)', 'link', base), null);
  assert.equal(resolveSafeUrl('javascript:void(0)', 'link', base), null);
  assert.equal(resolveSafeUrl('data:text/html,x', 'image', base), null);
  assert.equal(resolveSafeUrl('data:image/png;base64,x', 'image', base), null);
  assert.equal(resolveSafeUrl('file:///etc/passwd', 'link', base), null);
  assert.equal(resolveSafeUrl('file:///etc/passwd', 'image', base), null);
  assert.equal(resolveSafeUrl(' ', 'link', base), null);
  assert.equal(resolveSafeUrl('', 'link', base), null);
});

test('parseSafeMarkdown strips frontmatter, sets hf ids, and resolves URLs', () => {
  clearSafeMarkdownCache();
  const doc = parseSafeMarkdown(
    '---\nname: test\nlicense: MIT\n---\n# Model Card\nSee [img](/images/c.png) and [jump](#model-card)\n',
    'org/model',
    'abc',
  );
  // Frontmatter removed from body; the body begins with the heading.
  assert.equal(doc.children[0].type, 'heading');
  assert.equal(doc.frontmatter, 'name: test\nlicense: MIT');
  assert.equal(doc.children[0].id, 'hf-0-model-card');
  // Relative image resolved against the repo raw base (first link in the paragraph).
  const link = doc.children[1].children.find((c) => c.type === 'link');
  assert.ok(
    link && link.type === 'link',
    'expected a link node in the paragraph',
  );
  assert.equal(
    link.href,
    'https://huggingface.co/org/model/raw/abc/images/c.png',
  );
  // In-page anchor href preserved (starts with '#') for the anchor handler.
  assert.ok(
    doc.children.some((c) =>
      c.children?.some(
        (i) =>
          i.type === 'link' &&
          typeof i.href === 'string' &&
          i.href.startsWith('#'),
      ),
    ),
  );
});
