import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { duplicateScreen, createSnapshot, restoreSnapshot } from '../../packages/server/src/snapshots.js';
import { ensureServer, stopServer } from '../../packages/server/src/lifecycle.js';
import { readProject } from '../../packages/core/src/project-store.js';

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-canvas-snapshot-'));
  workspace = join(root, 'workspace');
  const runtime = await ensureServer(workspace);
  const request = (path: string, body: unknown) => fetch(`${runtime.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await request('/api/projects', { id: 'shop', name: 'Shop' });
  await request('/api/projects/shop/screens', { id: 'overview', name: 'Overview', width: 800, height: 600, expectedRevision: 0 });
  await writeFile(join(workspace, 'projects', 'shop', 'screens', 'overview', 'index.html'), '<h1>original</h1>');
  await writeFile(join(workspace, 'projects', 'shop', 'assets', 'logo.txt'), 'asset');
});

afterEach(async () => { await stopServer(workspace).catch(() => undefined); await rm(root, { force: true, recursive: true }); });

describe('variants and snapshots', () => {
  it('duplicate tạo source độc lập nhưng dùng tokens chung', async () => {
    const copy = await duplicateScreen(workspace, 'shop', 'overview', 'overview-alt');
    expect(copy).toMatchObject({ id: 'overview-alt', entry: 'screens/overview-alt/index.html' });
    const copyPath = join(workspace, 'projects', 'shop', copy.entry);
    await writeFile(copyPath, '<h1>variant</h1>');
    await expect(readFile(join(workspace, 'projects', 'shop', 'screens', 'overview', 'index.html'), 'utf8')).resolves.toContain('original');
    await expect(duplicateScreen(workspace, 'shop', 'overview', 'overview-alt')).rejects.toMatchObject({ code: 'SCREEN_EXISTS' });
  });

  it('snapshot phục hồi manifest, source và assets, rồi tạo backup', async () => {
    const before = await readProject(workspace, 'shop');
    const stylesheet = join(workspace, 'projects', 'shop', 'screens', 'overview', 'styles.css');
    const originalStyles = await readFile(stylesheet, 'utf8');
    await writeFile(join(workspace, 'projects', 'shop', 'artifacts', 'runtime-note.txt'), 'do not snapshot');
    const snapshot = await createSnapshot(workspace, 'shop');
    await expect(access(join(workspace, 'projects', 'shop', 'snapshots', snapshot.snapshotId, 'artifacts', 'runtime-note.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(workspace, 'projects', 'shop', 'snapshots', snapshot.snapshotId, 'snapshots'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(workspace, 'projects', 'shop', 'screens', 'overview', 'index.html'), '<h1>changed</h1>');
    await writeFile(stylesheet, 'main { color: red; }');
    await rm(join(workspace, 'projects', 'shop', 'assets', 'logo.txt'));
    const restored = await restoreSnapshot(workspace, 'shop', snapshot.snapshotId);
    expect(restored.backupSnapshotId).toBeTruthy();
    await expect(readFile(join(workspace, 'projects', 'shop', 'screens', 'overview', 'index.html'), 'utf8')).resolves.toContain('original');
    await expect(readFile(stylesheet, 'utf8')).resolves.toBe(originalStyles);
    await expect(access(join(workspace, 'projects', 'shop', 'assets', 'logo.txt'))).resolves.toBeUndefined();
    await expect(readProject(workspace, 'shop')).resolves.toMatchObject({ revision: expect.any(Number), screens: [{ id: 'overview' }] });
    expect((await readProject(workspace, 'shop')).revision).toBeGreaterThan(before.revision);
  });

  it('không công bố snapshot dở dang khi nguồn liên tục thay đổi', async () => {
    const asset = join(workspace, 'projects', 'shop', 'assets', 'changing.bin');
    let changing = true;
    const mutate = async () => {
      let version = 0;
      while (changing) await writeFile(asset, Buffer.alloc(16 * 1024 * 1024, version++));
    };
    const writer = mutate();
    try {
      await expect(createSnapshot(workspace, 'shop')).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    } finally {
      changing = false;
      await writer;
    }
    await expect(readdir(join(workspace, 'projects', 'shop', 'snapshots'))).resolves.toEqual([]);
  }, 30_000);
});
