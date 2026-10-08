import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

// Every spec that drives the canvas serves it from packages/canvas/dist via
// LOCAL_CANVAS_STATIC_DIR. Vite's build runs with `emptyOutDir: true`, so a
// build wipes the directory before it writes. When each spec built in its own
// beforeAll, two workers could overlap: one emptied dist/ while the other was
// serving it, the browser got a 404 for /assets/index-*.js, and the app never
// booted — a different test failing on each run. Build once here, before any
// worker starts, so the served directory is read-only for the whole run.
export default async function globalSetup(): Promise<void> {
  await promisify(execFile)(process.execPath, [
    resolve('node_modules/vite/bin/vite.js'),
    'build',
    '--config',
    resolve('packages/canvas/vite.config.ts'),
  ]);
}
