import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureScreen } from '../../packages/server/src/capture.js';
import { ensureServer, stopServer } from '../../packages/server/src/lifecycle.js';

let root: string;
let workspace: string;

async function pngSize(path: string): Promise<{ width: number; height: number }> {
  const image = await readFile(path);
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-canvas-capture-'));
  workspace = join(root, 'workspace');
  const runtime = await ensureServer(workspace);
  const request = (path: string, body: unknown) => fetch(`${runtime.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await request('/api/projects', { id: 'shop', name: 'Shop' });
  await request('/api/projects/shop/screens', { id: 'overview', name: 'Overview', width: 640, height: 480, expectedRevision: 0 });
  await writeFile(join(workspace, 'projects', 'shop', 'screens', 'overview', 'index.html'), await readFile(resolve('tests/fixtures/capture-fixture.html')));
});

afterEach(async () => { await stopServer(workspace).catch(() => undefined); await rm(root, { force: true, recursive: true }); });

describe('preview capture', () => {
  it('lưu PNG đúng viewport và thu lỗi resource, console, page dù trang có timer', async () => {
    const result = await captureScreen(workspace, 'shop', 'overview');
    await expect(access(result.imagePath)).resolves.toBeUndefined();
    await expect(pngSize(result.imagePath)).resolves.toEqual({ width: 640, height: 480 });
    expect(result.errors.map((error) => error.type)).toEqual(expect.arrayContaining(['console', 'page', 'resource']));
    await expect(readFile(result.imagePath.replace(/\.png$/, '.json'), 'utf8')).resolves.toContain('capture page error');
  }, 15_000);
});
