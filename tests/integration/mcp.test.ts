import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../packages/mcp/src/index.js';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${runtime.url}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
}

async function connectClient(): Promise<Client> {
  const server = createMcpServer(workspace);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-canvas-mcp-'));
  workspace = join(root, 'workspace');
  runtime = await ensureServer(workspace);
});

afterEach(async () => {
  await stopServer(workspace).catch(() => undefined);
  await rm(root, { force: true, recursive: true });
});

describe('mcp adapter', () => {
  it('trả cùng dữ liệu project như management API dùng bởi CLI', async () => {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
    await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'overview', name: 'Overview', width: 800, height: 600, expectedRevision: 0 }) });

    const client = await connectClient();
    try {
      const projectsViaApi = (await (await api('/api/projects')).json()) as { data: unknown };
      const projectsViaMcp = await callJson(client, 'project_list');
      expect(projectsViaMcp.ok).toBe(true);
      expect(projectsViaMcp.data).toEqual(projectsViaApi.data);

      const screensViaApi = ((await (await api('/api/projects/shop')).json()) as { data: { screens: unknown } }).data.screens;
      const screensViaMcp = await callJson(client, 'screen_list', { project: 'shop' });
      expect(screensViaMcp.data).toEqual(screensViaApi);

      const status = await callJson(client, 'canvas_status');
      expect(status).toMatchObject({ ok: true, data: { running: true } });
    } finally {
      await client.close();
    }
  }, 15_000);

  it('map lỗi có cấu trúc tương đương cho id không hợp lệ và selection chưa có', async () => {
    const client = await connectClient();
    try {
      const missing = await callJson(client, 'screen_list', { project: 'khong-ton-tai' });
      expect(missing).toMatchObject({ ok: false, error: { code: 'PROJECT_NOT_FOUND' } });

      await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
      const noSelection = await callJson(client, 'selection_get', { project: 'shop' });
      expect(noSelection).toMatchObject({ ok: false, error: { code: 'NO_SELECTION' } });
    } finally {
      await client.close();
    }
  }, 15_000);

  it('tạo và tạo lại prototype qua MCP trên cùng dữ liệu API', async () => {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
    await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'home', name: 'Home', width: 800, height: 600, expectedRevision: 0 }) });
    await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'detail', name: 'Detail', width: 800, height: 600, expectedRevision: 1 }) });
    const client = await connectClient();
    try {
      const source = await callJson(client, 'prototype_sources', { project: 'shop', screens: ['home', 'detail'] });
      expect(source.ok).toBe(true);
      const expectedSourceBaseline = source.data as Record<string, string>;
      const created = await callJson(client, 'prototype_create', { project: 'shop', id: 'booking', name: 'Booking', screens: ['home', 'detail'], startScreen: 'home', transitions: [{ fromScreenId: 'home', elementId: 'home-link', toScreenId: 'detail' }], expectedSourceBaseline });
      expect(created).toMatchObject({ ok: true, data: { id: 'booking', revision: 0 } });
      const regenerated = await callJson(client, 'prototype_regenerate', { project: 'shop', id: 'booking', expectedRevision: 0, screens: ['home', 'detail'], startScreen: 'detail', transitions: [], expectedSourceBaseline });
      expect(regenerated).toMatchObject({ ok: true, data: { id: 'booking', revision: 1, startScreenId: 'detail' } });
      const viaApi = (await (await api('/api/projects/shop/prototypes/booking')).json()) as { data: { startScreenId: string } };
      expect(viaApi.data.startScreenId).toBe('detail');
    } finally { await client.close(); }
  });

  it('dọn dẹp và bố cục lại màn hình qua MCP', async () => {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
    await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'home', name: 'Home', width: 800, height: 600, expectedRevision: 0 }) });
    await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'detail', name: 'Detail', width: 800, height: 600, expectedRevision: 1 }) });
    const client = await connectClient();
    try {
      const renamed = await callJson(client, 'project_rename', { project: 'shop', name: 'Cửa hàng' });
      expect(renamed).toMatchObject({ ok: true, data: { id: 'shop', name: 'Cửa hàng' } });

      const moved = await callJson(client, 'screen_update', { project: 'shop', screens: [{ id: 'home', x: 1600, y: 120, width: 1024 }] });
      expect(moved).toMatchObject({ ok: true, data: { screens: expect.arrayContaining([expect.objectContaining({ id: 'home', x: 1600, y: 120, width: 1024 })]) } });

      const duplicated = await callJson(client, 'screen_duplicate', { project: 'shop', screen: 'home', newId: 'home-alt' });
      expect(duplicated).toMatchObject({ ok: true, data: { id: 'home-alt' } });

      const deleted = await callJson(client, 'screen_delete', { project: 'shop', screens: ['home-alt', 'detail'] });
      expect(deleted.ok).toBe(true);
      const screens = await callJson(client, 'screen_list', { project: 'shop' });
      expect(screens.data).toMatchObject([{ id: 'home' }]);
    } finally { await client.close(); }
  }, 20_000);

  it('chụp và phục hồi snapshot qua MCP', async () => {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
    await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'home', name: 'Home', width: 800, height: 600, expectedRevision: 0 }) });
    const client = await connectClient();
    try {
      const created = await callJson(client, 'snapshot_create', { project: 'shop' });
      expect(created).toMatchObject({ ok: true, data: { snapshotId: expect.any(String) } });
      const snapshotId = (created.data as { snapshotId: string }).snapshotId;

      const restored = await callJson(client, 'snapshot_restore', { project: 'shop', snapshot: snapshotId });
      expect(restored).toMatchObject({ ok: true, data: { backupSnapshotId: expect.any(String) } });

      const missing = await callJson(client, 'snapshot_restore', { project: 'shop', snapshot: 'khong-ton-tai' });
      expect(missing).toMatchObject({ ok: false, error: { code: 'SNAPSHOT_NOT_FOUND' } });
    } finally { await client.close(); }
  }, 20_000);

  it('figma_export đi đúng route của server', async () => {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
    await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'home', name: 'Home', width: 800, height: 600, expectedRevision: 0 }) });
    const client = await connectClient();
    try {
      // Màn hình không tồn tại để không phải khởi động Chromium.
      const exported = await callJson(client, 'figma_export', { project: 'shop', screen: 'khong-ton-tai' });
      expect(exported).toMatchObject({ ok: false, error: { code: 'SCREEN_NOT_FOUND' } });
    } finally { await client.close(); }
  }, 20_000);

  it('từ chối xóa màn hình cuối cùng của project', async () => {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
    await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'home', name: 'Home', width: 800, height: 600, expectedRevision: 0 }) });
    const client = await connectClient();
    try {
      const deleted = await callJson(client, 'screen_delete', { project: 'shop', screens: ['home'] });
      expect(deleted).toMatchObject({ ok: false, error: { code: 'LAST_SCREEN' } });
    } finally { await client.close(); }
  }, 20_000);
});
