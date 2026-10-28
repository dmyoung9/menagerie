import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamCompletion } from '../src/completionStream.ts';

test('streams fragmented UTF-8 SSE content and ignores reasoning/usage', async () => {
  const original = globalThis.fetch;
  const bytes = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"héllo"}}]}\r\n\r\ndata: {"usage":{}}\r\n\r\ndata: [DONE]\r\n\r\n',
  );
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 128);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
    );
  };
  try {
    let output = '';
    await streamCompletion(
      'starter',
      'Hello',
      new AbortController().signal,
      (text) => (output += text),
    );
    assert.equal(output, 'héllo');
  } finally {
    globalThis.fetch = original;
  }
});

test('reports HTTP errors, stream errors, empty text and truncated responses', async () => {
  const original = globalThis.fetch;
  try {
    for (const [response, expected] of [
      [
        new Response('{"error":{"message":"engine failed"}}', { status: 503 }),
        /engine failed/,
      ],
      [
        new Response('data: {"error":{"message":"out of memory"}}\n\n'),
        /out of memory/,
      ],
      [new Response('data: [DONE]\n\n'), /no text/],
      [
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
        /ended unexpectedly/,
      ],
    ] as const) {
      globalThis.fetch = async () => response;
      await assert.rejects(
        streamCompletion(
          'starter',
          'Hello',
          new AbortController().signal,
          () => {},
        ),
        expected,
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('forwards cancellation to the gateway request', async () => {
  const original = globalThis.fetch,
    controller = new AbortController();
  controller.abort();
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.signal, controller.signal);
    throw new DOMException('Cancelled', 'AbortError');
  };
  try {
    await assert.rejects(
      streamCompletion('starter', 'Hello', controller.signal, () => {}),
      { name: 'AbortError' },
    );
  } finally {
    globalThis.fetch = original;
  }
});
