import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';
import type { Result } from '../../packages/core/src/schema.js';

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${runtime.url}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await api(path, init);
  const body = (await response.json()) as Result<T>;
  if (!body.ok) throw new Error(`${body.error.code} ${body.error.message}`);
  return body.data;
}

async function setScreen(html: string): Promise<void> {
  await writeFile(join(workspace, 'projects', 'shop', 'screens', 'overview', 'index.html'), html);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local canvas imagediff '));
  workspace = join(root, 'workspace');
  runtime = await ensureServer(workspace);
  await json('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
  await json('/api/projects/shop/screens', {
    method: 'POST',
    body: JSON.stringify({ id: 'overview', name: 'Overview', width: 320, height: 240, expectedRevision: 0 }),
  });
  await setScreen('<!doctype html><html><body style="margin:0;background:#fff"><div style="width:100px;height:80px;background:#000"></div></body></html>');
});

afterEach(async () => {
  await stopServer(workspace).catch(() => undefined);
  await rm(root, { force: true, recursive: true });
});

describe('image diff API', () => {
  it('so ảnh cũ với live: sau một sửa đổi — đếm đổi, khoanh vùng, ghi overlay', async () => {
    const baseline = await json<{ imagePath: string }>('/api/projects/shop/screens/overview/capture', { method: 'POST' });

    await setScreen('<!doctype html><html><body style="margin:0;background:#fff"><div style="width:100px;height:80px;background:#000"></div><div style="width:120px;height:60px;background:#e11"></div></body></html>');
    // Workflow thật: agent cầm absolute imagePath từ screenshot và truyền thẳng vào diff.
    const result = await json<{
      identical: boolean;
      changedPixels: number;
      changedPercent: number;
      width: number;
      height: number;
      regions: { x: number; y: number; width: number; height: number }[];
      diffPath: string;
    }>('/api/projects/shop/image-diff', { method: 'POST', body: JSON.stringify({ base: baseline.imagePath, target: 'live:overview' }) });

    expect(result.identical).toBe(false);
    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
    // The added block alone is 120×60 = 7200 px = 9.375% của 76800.
    expect(result.changedPixels).toBeGreaterThanOrEqual(7200);
    expect(result.changedPercent).toBeGreaterThan(8);
    expect(result.changedPercent).toBeLessThan(12);
    // Một vùng đổi duy nhất, nằm phần dưới frame nơi khối mới xuất hiện.
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].y).toBeGreaterThanOrEqual(64);
    const overlay = await readFile(result.diffPath);
    expect(overlay.subarray(1, 4).toString()).toBe('PNG');
    expect(overlay.readUInt32BE(16)).toBe(320);
  }, 30_000);

  it('nguồn không đổi giữa hai lần chụp: identical, zero pixel', async () => {
    const a = await json<{ imagePath: string }>('/api/projects/shop/screens/overview/capture', { method: 'POST' });
    const b = await json<{ imagePath: string }>('/api/projects/shop/screens/overview/capture', { method: 'POST' });
    const result = await json<{ identical: boolean; changedPixels: number }>('/api/projects/shop/image-diff', {
      method: 'POST',
      body: JSON.stringify({ base: a.imagePath, target: b.imagePath }),
    });
    expect(result.identical).toBe(true);
    expect(result.changedPixels).toBe(0);
  }, 30_000);

  it('đường dẫn ra ngoài project bị chặn bằng PATH_OUTSIDE_PROJECT', async () => {
    const response = await api('/api/projects/shop/image-diff', {
      method: 'POST',
      body: JSON.stringify({ base: '../../project.json', target: 'live:overview' }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_PROJECT' } });
  });

  it('DIFF_SIZE_MISMATCH khi hai lần chụp khác viewport', async () => {
    const baseline = await json<{ imagePath: string }>('/api/projects/shop/screens/overview/capture', { method: 'POST' });
    await json('/api/projects/shop/layout', {
      method: 'PATCH',
      body: JSON.stringify({ patches: [{ id: 'overview', width: 640, height: 240 }], expectedRevision: 1 }),
    });
    const response = await api('/api/projects/shop/image-diff', {
      method: 'POST',
      body: JSON.stringify({ base: baseline.imagePath, target: 'live:overview' }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: 'DIFF_SIZE_MISMATCH' } });
  }, 30_000);
});
