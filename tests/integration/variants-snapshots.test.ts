import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { duplicateScreen, createSnapshot, deleteSnapshot, listSnapshots, restoreSnapshot } from '../../packages/server/src/snapshots.js';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';
import { readProject } from '../../packages/core/src/project-store.js';

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-canvas-snapshot-'));
  workspace = join(root, 'workspace');
  runtime = await ensureServer(workspace);
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

  it('liệt kê snapshot mới nhất trước kèm thời gian và dung lượng', async () => {
    const first = await createSnapshot(workspace, 'shop');
    // A second snapshot a moment later must sort ahead of the first.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createSnapshot(workspace, 'shop');

    const listed = await listSnapshots(workspace, 'shop');
    expect(listed.map((entry) => entry.id)).toEqual([second.snapshotId, first.snapshotId]);
    for (const entry of listed) {
      expect(entry.bytes).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
    }
  });

  it('bỏ qua thư mục staging dở dang và file rác khi liệt kê', async () => {
    const snapshot = await createSnapshot(workspace, 'shop');
    const snapshotsDir = join(workspace, 'projects', 'shop', 'snapshots');
    await mkdir(join(snapshotsDir, '.snapshot-1-deadbeef.staging'), { recursive: true });
    await writeFile(join(snapshotsDir, 'junk.txt'), 'not a snapshot');

    const listed = await listSnapshots(workspace, 'shop');
    expect(listed.map((entry) => entry.id)).toEqual([snapshot.snapshotId]);
  });

  it('xóa một snapshot và bỏ nó khỏi danh sách', async () => {
    const snapshot = await createSnapshot(workspace, 'shop');
    await expect(deleteSnapshot(workspace, 'shop', snapshot.snapshotId)).resolves.toEqual({ deleted: true });
    await expect(access(join(workspace, 'projects', 'shop', 'snapshots', snapshot.snapshotId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(listSnapshots(workspace, 'shop')).resolves.toEqual([]);
  });

  it('từ chối ID snapshot không hợp lệ và không xóa gì', async () => {
    const source = join(workspace, 'projects', 'shop', 'screens', 'overview', 'index.html');
    // The id is validated before any filesystem call; the store throws the raw
    // schema error (the API maps it to VALIDATION_ERROR), so assert it rejects.
    await expect(deleteSnapshot(workspace, 'shop', '../../screens')).rejects.toThrow();
    await expect(readFile(source, 'utf8')).resolves.toContain('original');
  });

  it('trả SNAPSHOT_NOT_FOUND cho ID hợp lệ nhưng không tồn tại', async () => {
    await expect(deleteSnapshot(workspace, 'shop', 'snapshot-1-deadbeef')).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
  });

  it('phục vụ liệt kê và xóa snapshot qua HTTP', async () => {
    const snapshot = await createSnapshot(workspace, 'shop');
    const listed = await fetch(`${runtime.url}/api/projects/shop/snapshots`);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ ok: true, data: [{ id: snapshot.snapshotId, bytes: expect.any(Number), createdAt: expect.any(String) }] });

    const removed = await fetch(`${runtime.url}/api/projects/shop/snapshots/${encodeURIComponent(snapshot.snapshotId)}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ ok: true, data: { deleted: true } });
    await expect(listSnapshots(workspace, 'shop')).resolves.toEqual([]);

    const bad = await fetch(`${runtime.url}/api/projects/shop/snapshots/not%20valid`, { method: 'DELETE' });
    expect(bad.status).toBe(400);
  });
});
