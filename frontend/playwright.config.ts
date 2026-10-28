import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  workers: 3,
  timeout: 30000,
  use: {baseURL: 'http://127.0.0.1:8049', viewport: {width: 1440, height: 1000}, trace: 'retain-on-failure'},
  webServer: {command: 'npm run dev -- --port 8049 --strictPort', url: 'http://127.0.0.1:8049', reuseExistingServer: false},
});
