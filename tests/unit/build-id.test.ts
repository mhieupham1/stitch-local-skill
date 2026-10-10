import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprint } from '../../packages/server/src/build-id.js';

const roots: string[] = [];

/** A throwaway copy of the layout `codeRoots` looks for in a checkout. */
async function fixture(): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'build id '));
  roots.push(root);
  const repository = join(root, 'repo');
  await mkdir(join(repository, 'packages', 'server', 'src'), { recursive: true });
  await mkdir(join(repository, 'packages', 'canvas', 'dist', 'assets'), { recursive: true });
  await mkdir(join(repository, 'packages', 'canvas', 'src'), { recursive: true });
  await mkdir(join(repository, 'templates', 'basic-screen'), { recursive: true });
  await mkdir(join(repository, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(repository, 'packages', 'server', 'src', 'app.ts'), 'export const a = 1;\n');
  await writeFile(join(repository, 'packages', 'canvas', 'src', 'main.tsx'), 'export const b = 2;\n');
  await writeFile(join(repository, 'templates', 'basic-screen', 'index.html'), '<!doctype html>\n');
  await writeFile(join(repository, 'packages', 'canvas', 'dist', 'index.html'), '<!doctype html>built\n');
  await writeFile(join(repository, 'packages', 'canvas', 'dist', 'assets', 'index-abc.js'), 'console.log(1)\n');
  await writeFile(join(repository, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n');
  return [join(repository, 'packages'), join(repository, 'templates')];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('computeBuildId', () => {
  it('is the same for the same tree', async () => {
    const roots = await fixture();
    const before = await fingerprint(roots);
    expect(await fingerprint(roots)).toBe(before);
  });

  it('changes when the code changes', async () => {
    const roots = await fixture();
    const before = await fingerprint(roots);
    await writeFile(join(roots[0], 'server', 'src', 'app.ts'), 'export const a = 2;\n');
    expect(await fingerprint(roots)).not.toBe(before);
  });

  it('changes when a template changes', async () => {
    const roots = await fixture();
    const before = await fingerprint(roots);
    await writeFile(join(roots[1], 'basic-screen', 'index.html'), '<!doctype html><p>x\n');
    expect(await fingerprint(roots)).not.toBe(before);
  });

  it('ignores a rebuilt canvas bundle', async () => {
    const roots = await fixture();
    const before = await fingerprint(roots);
    // A build replaces the bundle without touching the code the server runs.
    // Counting these files would restart a healthy server whenever the canvas
    // is rebuilt — and make the id drift mid-way through a test run.
    const dist = join(roots[0], 'canvas', 'dist');
    await rm(dist, { force: true, recursive: true });
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'index.html'), '<!doctype html>rebuilt\n');
    await writeFile(join(dist, 'assets', 'index-def.js'), 'console.log(2)\n');
    expect(await fingerprint(roots)).toBe(before);
  });

  it('ignores dependency and workspace churn', async () => {
    const roots = await fixture();
    const before = await fingerprint(roots);
    const repository = join(roots[0], '..');
    await mkdir(join(repository, '.local-canvas'), { recursive: true });
    await writeFile(join(repository, '.local-canvas', 'runtime.json'), '{}\n');
    await writeFile(join(repository, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 2\n');
    expect(await fingerprint(roots)).toBe(before);
  });

  it('notices a file whose content changed without changing size', async () => {
    const roots = await fixture();
    const target = join(roots[0], 'server', 'src', 'app.ts');
    const before = await fingerprint(roots);
    const info = await stat(target);
    await writeFile(target, 'export const a = 3;\n'); // Same length as `= 1;`.
    await utimes(target, info.atime, new Date(info.mtimeMs + 1_000));
    expect(await fingerprint(roots)).not.toBe(before);
  });
});
