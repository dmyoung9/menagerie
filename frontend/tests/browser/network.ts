import { test as base, expect } from '@playwright/test';

// Context-level routing also covers popups. Page-level mocks fulfill API calls;
// requests that would reach the network must pass this boundary.
export const test = base.extend<{ blockedRequests: string[] }>({
  blockedRequests: async ({ baseURL }, use) => {
    expect(baseURL, 'A dedicated fixture server is required').toBeDefined();
    const blocked: string[] = [];
    await use(blocked);
    expect(
      blocked,
      'Unexpected network request outside fixture assets',
    ).toEqual([]);
  },
  context: async ({ context, baseURL, blockedRequests }, use) => {
    const origin = new URL(baseURL!).origin;
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (
        url.origin === origin &&
        !/^\/(api|v1|models)(\/|$)/.test(url.pathname) &&
        route.request().method() === 'GET'
      )
        return route.continue();
      blockedRequests.push('Blocked non-fixture request');
      return route.abort();
    });
    await context.routeWebSocket('**/*', (socket) => {
      const url = new URL(socket.url());
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      if (url.origin === origin && url.pathname === '/')
        socket.connectToServer();
      else {
        blockedRequests.push('Blocked non-fixture WebSocket');
        socket.close();
      }
    });
    await use(context);
  },
});
export { expect };
