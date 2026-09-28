import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const release = join(root, 'dist', 'release', 'local-design-canvas');
const runtime = join(release, 'runtime');

await rm(release, { force: true, recursive: true });
await mkdir(runtime, { recursive: true });
await viteBuild({ configFile: join(root, 'packages', 'canvas', 'vite.config.ts') });
await Promise.all([
  bundle({ entryPoints: [join(root, 'packages', 'cli', 'src', 'index.ts')], outfile: join(runtime, 'cli.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node22' }),
  bundle({
    entryPoints: [join(root, 'packages', 'server', 'src', 'standalone.ts')],
    outfile: join(runtime, 'server.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    external: ['playwright'],
  }),
]);
await Promise.all([
  cp(join(root, 'packages', 'canvas', 'dist'), join(runtime, 'canvas'), { recursive: true }),
  cp(join(root, 'templates', 'basic-screen'), join(runtime, 'templates', 'basic-screen'), { recursive: true }),
  cp(join(root, 'skills', 'local-design-canvas'), release, { recursive: true }),
  cp(join(root, 'node_modules', 'playwright'), join(release, 'node_modules', 'playwright'), { recursive: true }),
  cp(join(root, 'node_modules', 'playwright-core'), join(release, 'node_modules', 'playwright-core'), { recursive: true }),
]);
process.stdout.write(`${release}\n`);
