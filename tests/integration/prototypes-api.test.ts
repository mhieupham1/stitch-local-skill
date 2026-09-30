import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${runtime.url}${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
}

async function sources(): Promise<Record<string, string>> {
  const response = await api('/api/projects/shop/prototype-sources?screenIds=home,detail');
  expect(response.status).toBe(200);
  const body = await response.json() as { data: Record<string, string> };
  return body.data;
}

async function create(): Promise<Response> {
  return api('/api/projects/shop/prototypes', { method: 'POST', body: JSON.stringify({
    id: 'booking', name: 'Booking', screenIds: ['home', 'detail'], startScreenId: 'home',
    transitions: [{ fromScreenId: 'home', elementId: 'home-link', toScreenId: 'detail' }],
    expectedSourceBaseline: await sources(),
  }) });
}

async function nextPrototypeEvent(action: () => Promise<void>, allowProjectError = false): Promise<{ type: string; projectId: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const response = await fetch(`${runtime.url}/api/events`, { signal: controller.signal });
  if (!response.body) throw new Error('Missing event stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    await action();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Event stream closed');
      buffer += decoder.decode(chunk.value, { stream: true });
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data) {
          const event = JSON.parse(data.slice(6)) as { type: string; projectId: string };
          if (event.type === 'project.error' && !allowProjectError) throw new Error('Prototype change emitted project.error');
          if (event.type === 'prototype.updated') return event;
        }
        end = buffer.indexOf('\n\n');
      }
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prototype-api-'));
  workspace = join(root, 'workspace');
  runtime = await ensureServer(workspace);
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
  await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'home', name: 'Home', width: 800, height: 600, expectedRevision: 0 }) });
  await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'detail', name: 'Detail', width: 800, height: 600, expectedRevision: 1 }) });
});

afterEach(async () => {
  await stopServer(workspace).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('prototype API', () => {
  it('creates, lists, patches, regenerates and deletes with revision checks', async () => {
    const created = await create();
    expect(created.status).toBe(201);
    const first = (await created.json() as { data: { revision: number; id: string } }).data;
    expect(first).toMatchObject({ id: 'booking', revision: 0 });
    const list = await api('/api/projects/shop/prototypes');
    expect((await list.json() as { data: { id: string }[] }).data.map((item) => item.id)).toEqual(['booking']);
    expect((await api('/api/projects/shop/prototypes/booking')).status).toBe(200);
    const wrongRevision = await api('/api/projects/shop/prototypes/booking', { method: 'PATCH', body: JSON.stringify({ expectedRevision: 9, name: 'Wrong' }) });
    expect(wrongRevision.status).toBe(409);
    const updated = await api('/api/projects/shop/prototypes/booking', { method: 'PATCH', body: JSON.stringify({ expectedRevision: 0, name: 'Updated' }) });
    expect((await updated.json() as { data: { revision: number; name: string } }).data).toMatchObject({ revision: 1, name: 'Updated' });
    const regenerated = await api('/api/projects/shop/prototypes/booking/regenerate', { method: 'POST', body: JSON.stringify({
      expectedRevision: 1, screenIds: ['home', 'detail'], startScreenId: 'detail', transitions: [], expectedSourceBaseline: await sources(),
    }) });
    expect((await regenerated.json() as { data: { revision: number; startScreenId: string } }).data).toMatchObject({ revision: 2, startScreenId: 'detail' });
    const wrongDelete = await api('/api/projects/shop/prototypes/booking', { method: 'DELETE', body: JSON.stringify({ expectedRevision: 1 }) });
    expect(wrongDelete.status).toBe(409);
    const deleted = await api('/api/projects/shop/prototypes/booking', { method: 'DELETE', body: JSON.stringify({ expectedRevision: 2 }) });
    expect(deleted.status).toBe(200);
    expect((await api('/api/projects/shop/prototypes')).status).toBe(200);
    expect((await api('/api/projects/shop/prototypes/booking')).status).toBe(404);
  });

  it('rejects unsafe inputs and does not expose prototype JSON on preview origin', async () => {
    const invalid = await api('/api/projects/shop/prototypes', { method: 'POST', body: JSON.stringify({ id: 'booking' }) });
    expect(invalid.status).toBe(400);
    const origin = await api('/api/projects/shop/prototypes', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
    expect(origin.status).toBe(403);
    await create();
    const preview = await fetch(`${runtime.previewUrl}/projects/shop/prototypes/booking.json`);
    expect(preview.status).toBe(403);
    const otherProject = await api('/api/projects/other/prototypes/booking');
    expect(otherProject.status).toBe(404);
    await writeFile(join(workspace, 'projects', 'shop', 'prototypes', 'broken.json'), '{');
    const broken = await api('/api/projects/shop/prototypes/broken');
    expect(broken.status).toBe(500);
    await expect(broken.json()).resolves.toMatchObject({ error: { code: 'INVALID_PROTOTYPE' } });
  });

  it('returns SOURCE_CONFLICT rather than marking stale source as newly generated', async () => {
    const baseline = await sources();
    await writeFile(join(workspace, 'projects', 'shop', 'screens', 'home', 'index.html'), '<h1>Changed</h1>');
    const response = await api('/api/projects/shop/prototypes', { method: 'POST', body: JSON.stringify({
      id: 'booking', name: 'Booking', screenIds: ['home', 'detail'], startScreenId: 'home', transitions: [], expectedSourceBaseline: baseline,
    }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'SOURCE_CONFLICT' } });
    const list = await api('/api/projects/shop/prototypes');
    expect((await list.json() as { data: unknown[] }).data).toEqual([]);
  });

  it('does not change project manifest when creating a prototype', async () => {
    const manifest = join(workspace, 'projects', 'shop', 'project.json');
    const before = await readFile(manifest, 'utf8');
    await create();
    expect(await readFile(manifest, 'utf8')).toBe(before);
  });

  it('announces direct prototype deletion without project.error', async () => {
    await create();
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    const path = join(workspace, 'projects', 'shop', 'prototypes', 'booking.json');
    const event = await nextPrototypeEvent(() => rm(path));
    expect(event).toMatchObject({ type: 'prototype.updated', projectId: 'shop' });
  });

  it('refreshes stale state when a shared source file is deleted', async () => {
    const shared = join(workspace, 'projects', 'shop', 'design-system.css');
    await writeFile(shared, 'body { color: red; }');
    await create();
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    const event = await nextPrototypeEvent(() => rm(shared), true);
    expect(event).toMatchObject({ type: 'prototype.updated', projectId: 'shop' });
    const loaded = await api('/api/projects/shop/prototypes/booking');
    expect((await loaded.json() as { data: { stale: boolean } }).data.stale).toBe(true);
  });
});
