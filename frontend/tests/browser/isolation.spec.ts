import { test, expect } from './network';

test('fixture boundary blocks external HTTP and unmocked local APIs', async ({
  page,
  blockedRequests,
}) => {
  await page.goto('/tests/effects.html');
  for (const url of [
    'https://example.test/private',
    '/api/status',
    'http://127.0.0.1:8001/v1/models',
  ]) {
    expect(
      await page.evaluate(async (target) => {
        try {
          await fetch(target);
          return false;
        } catch {
          return true;
        }
      }, url),
    ).toBe(true);
    expect(blockedRequests.splice(0)).toEqual(['Blocked non-fixture request']);
  }
});

test('fixture boundary blocks external WebSockets', async ({
  page,
  blockedRequests,
}) => {
  await page.goto('/tests/effects.html');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const socket = new WebSocket('ws://example.test/private');
        socket.onclose = () => resolve();
        socket.onerror = () => resolve();
      }),
  );
  expect(blockedRequests.splice(0)).toEqual(['Blocked non-fixture WebSocket']);
});
