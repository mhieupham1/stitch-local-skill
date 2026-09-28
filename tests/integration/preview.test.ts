import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

async function createPreview(): Promise<void> {
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${runtime.url}${path}`, {
      ...init,
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  await request('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
  await request('/api/projects/shop/screens', {
    method: 'POST',
    body: JSON.stringify({ id: 'overview', name: 'Overview', width: 1200, height: 800, expectedRevision: 0 }),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-canvas-preview-'));
  workspace = join(root, 'workspace');
  runtime = await ensureServer(workspace);
  await createPreview();
});

afterEach(async () => {
  await stopServer(workspace).catch(() => undefined);
  await rm(root, { force: true, recursive: true });
});

describe('preview origin', () => {
  it('phục vụ template cục bộ nhưng từ chối traversal đã encode và runtime file', async () => {
    const valid = await fetch(`${runtime.previewUrl}/projects/shop/screens/overview/index.html`);
    expect(valid.status).toBe(200);
    expect(await valid.text()).toContain('data-screen-id="overview"');

    const traversal = await fetch(`${runtime.previewUrl}/projects/shop/%2e%2e%2f.local-canvas%2fruntime.json`);
    expect(traversal.status).not.toBe(200);
    const runtimeFile = await fetch(`${runtime.previewUrl}/projects/shop/.local-canvas/runtime.json`);
    expect(runtimeFile.status).not.toBe(200);
  });

  it('inject script đo chiều cao vào HTML phục vụ, không ghi vào file nguồn', async () => {
    const served = await fetch(`${runtime.previewUrl}/projects/shop/screens/overview/index.html?screen=overview`);
    expect(served.status).toBe(200);
    const html = await served.text();
    expect(html).toContain('content-size');
    expect(html).toContain('"screenId":"overview"');
    const source = await readFile(join(workspace, 'projects', 'shop', 'screens', 'overview', 'index.html'), 'utf8');
    expect(source).not.toContain('content-size');
  });

  it('từ chối symlink vượt project và không có API ghi trên preview origin', async () => {
    const outside = join(root, 'secret.txt');
    await writeFile(outside, 'secret', 'utf8');
    await symlink(outside, join(workspace, 'projects', 'shop', 'screens', 'overview', 'outside.txt'));

    const escaped = await fetch(`${runtime.previewUrl}/projects/shop/screens/overview/outside.txt`);
    expect(escaped.status).toBe(403);
    const writeAttempt = await fetch(`${runtime.previewUrl}/api/projects`, { method: 'POST' });
    expect(writeAttempt.status).toBe(404);
  });
});
