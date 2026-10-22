import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'node tools/fixture-server.mjs',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
