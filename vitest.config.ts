import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests spawn a real CLI subprocess (tsx + server), and the
    // capture tests additionally launch Chromium. The default 15s was tuned for
    // in-process unit tests and expired under parallel load, not because of a
    // hang. Timeouts below are generous on purpose: they bound a genuine hang,
    // they are not a performance budget.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // Each file forks a server plus a tsx CLI. Letting all 15 files run at once
    // oversubscribes the 8-core host and starves the spawned children.
    maxWorkers: 4,
  },
});
