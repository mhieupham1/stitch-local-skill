import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // The canvas bundle is built once here, not per spec: concurrent `vite build`
  // runs empty packages/canvas/dist while another worker is serving it.
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  // Playwright's default expect timeout is 5s, which the m1-acceptance width
  // assertion exceeded when the box ran alongside the other browser suites.
  // Layout saves are async (drag -> PATCH -> Saved), so give assertions room.
  expect: {
    timeout: 15_000,
  },
  // Each test starts a server and a Chromium instance; 2 workers keeps the
  // 8-core host from thrashing on browser startup.
  workers: 2,
  use: {
    browserName: 'chromium',
    headless: true,
  },
});
