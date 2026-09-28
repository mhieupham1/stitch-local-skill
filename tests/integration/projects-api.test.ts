import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${runtime.url}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local canvas api '));
  workspace = join(root, 'workspace có dấu cách');
  runtime = await ensureServer(workspace);
});

afterEach(async () => {
  await stopServer(workspace).catch(() => undefined);
  await rm(root, { force: true, recursive: true });
});

describe('project management API', () => {
  it('API quản lý mở cho localhost nhưng vẫn từ chối Origin không hợp lệ', async () => {
    const local = await fetch(`${runtime.url}/api/projects`);
    expect(local.status).toBe(200);

    // A page on another origin must not be able to drive the workspace over fetch.
    const crossOrigin = await fetch(`${runtime.url}/api/projects`, { headers: { origin: 'http://evil.example' } });
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN_ORIGIN' } });
  });

  it('tạo màn hình có entry tồn tại, giữ source khi ID trùng và từ chối viewport sai', async () => {
    const created = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ id: 'shop', name: 'Quản lý bán hàng' }),
    });
    expect(created.status).toBe(201);

    const screen = await api('/api/projects/shop/screens', {
      method: 'POST',
      body: JSON.stringify({
        id: 'overview',
        name: 'Tổng quan',
        width: 1440,
        height: 1000,
        expectedRevision: 0,
      }),
    });
    expect(screen.status).toBe(201);
    const screenBody = (await screen.json()) as { ok: true; data: { entryPath: string } };
    await expect(access(screenBody.data.entryPath)).resolves.toBeUndefined();
    await writeFile(screenBody.data.entryPath, 'giữ nguyên nội dung', 'utf8');

    const duplicate = await api('/api/projects/shop/screens', {
      method: 'POST',
      body: JSON.stringify({
        id: 'overview',
        name: 'Tổng quan khác',
        width: 1440,
        height: 1000,
        expectedRevision: 1,
      }),
    });
    expect(duplicate.status).toBe(409);
    await expect(readFile(screenBody.data.entryPath, 'utf8')).resolves.toBe('giữ nguyên nội dung');

    const badViewport = await api('/api/projects/shop/screens', {
      method: 'POST',
      body: JSON.stringify({ id: 'too-small', name: 'Sai', width: 239, height: 1000, expectedRevision: 1 }),
    });
    expect(badViewport.status).toBe(400);
  });

  it('từ chối Origin lạ', async () => {
    const response = await api('/api/projects', { headers: { origin: 'https://untrusted.example' } });
    expect(response.status).toBe(403);
  });

  it('trả lỗi validation thay vì lỗi nội bộ cho body API không hợp lệ', async () => {
    const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop' }) });
    expect(project.status).toBe(400);
    await expect(project.json()).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });

    const layout = await api('/api/projects/shop/layout', { method: 'PATCH', body: JSON.stringify({ patches: 'not-an-array' }) });
    expect(layout.status).toBe(400);
    await expect(layout.json()).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('từ chối tạo source qua thư mục screens là symlink ra ngoài project', async () => {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Quản lý bán hàng' }) });
    const outside = join(root, 'outside');
    await mkdir(outside);
    const screens = join(workspace, 'projects', 'shop', 'screens');
    await rm(screens, { recursive: true });
    await symlink(outside, screens);

    const response = await api('/api/projects/shop/screens', {
      method: 'POST',
      body: JSON.stringify({ id: 'overview', name: 'Tổng quan', width: 1440, height: 1000, expectedRevision: 0 }),
    });
    expect(response.status).toBe(403);
    await expect(access(join(outside, 'overview', 'index.html'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ghi và đọc màn hình đang được chọn trên canvas', async () => {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
    await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'overview', name: 'Tổng quan', width: 800, height: 600, expectedRevision: 0 }) });
    const missing = await api('/api/projects/shop/focus');
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ ok: false, error: { code: 'NO_SCREEN_FOCUS' } });

    const saved = await api('/api/projects/shop/focus', { method: 'PUT', body: JSON.stringify({ screenId: 'overview' }) });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ ok: true, data: { screenId: 'overview', name: 'Tổng quan' } });
    const current = await api('/api/projects/shop/focus');
    await expect(current.json()).resolves.toMatchObject({ ok: true, data: { screenId: 'overview', entry: 'screens/overview/index.html' } });
    const cleared = await api('/api/projects/shop/focus', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    await expect((await api('/api/projects/shop/focus')).json()).resolves.toMatchObject({ ok: false, error: { code: 'NO_SCREEN_FOCUS' } });
  });

  it('khóa và mở khóa phiên chỉnh sửa màn hình', async () => {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
    await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'overview', name: 'Tổng quan', width: 800, height: 600, expectedRevision: 0 }) });
    const locked = await api('/api/projects/shop/editing', { method: 'PUT', body: JSON.stringify({ screenId: 'overview', message: 'Đang chỉnh sửa bảng' }) });
    expect(locked.status).toBe(200);
    await expect(locked.json()).resolves.toMatchObject({ ok: true, data: { screenId: 'overview', message: 'Đang chỉnh sửa bảng' } });
    const current = await api('/api/projects/shop/editing');
    await expect(current.json()).resolves.toMatchObject({ ok: true, data: { session: { screenId: 'overview' } } });
    const cleared = await api('/api/projects/shop/editing', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    await expect((await api('/api/projects/shop/editing')).json()).resolves.toMatchObject({ ok: true, data: { session: null } });
  });
});
