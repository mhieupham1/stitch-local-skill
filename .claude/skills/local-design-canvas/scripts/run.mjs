import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtime = join(skillRoot, 'runtime');
const child = spawn(process.execPath, [join(runtime, 'cli.mjs'), ...process.argv.slice(2)], {
  env: {
    ...process.env,
    LOCAL_CANVAS_SERVER_ENTRY: join(runtime, 'server.mjs'),
    LOCAL_CANVAS_STATIC_DIR: join(runtime, 'canvas'),
    LOCAL_CANVAS_TEMPLATE_DIR: join(runtime, 'templates', 'basic-screen'),
  },
  stdio: ['inherit', 'pipe', 'pipe'],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
const result = await new Promise((resolve) => {
  child.once('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    resolve({ code: 1, signal: null });
  });
  child.once('close', (code, signal) => resolve({ code, signal }));
});
process.exitCode = result.code ?? (result.signal ? 1 : 0);
