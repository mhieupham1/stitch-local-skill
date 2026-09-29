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
});
