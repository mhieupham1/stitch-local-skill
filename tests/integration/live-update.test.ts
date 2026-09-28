import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

type CanvasEvent = { type: string; projectId: string; screenIds: string[]; sequence: number };

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${runtime.url}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
}

async function openEventStream(): Promise<{ next: () => Promise<CanvasEvent>; close: () => Promise<void> }> {
  const response = await fetch(`${runtime.url}/api/events`);
  if (!response.body) throw new Error('SSE không trả về stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queued: CanvasEvent[] = [];
  let pending: ((event: CanvasEvent) => void) | undefined;
  let done = false;

  const feed = (chunk: string) => {
    buffer += chunk;
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data) {
        const event = JSON.parse(data.slice(6)) as CanvasEvent;
        if (pending) {
          const resolve = pending;
          pending = undefined;
          resolve(event);
        } else queued.push(event);
      }
      separator = buffer.indexOf('\n\n');
    }
  };
  const consume = async () => {
    while (!done) {
      const result = await reader.read();
      if (result.done) return;
      feed(decoder.decode(result.value, { stream: true }));
    }
  };
  void consume();
  return {
    next: async () => {
      if (queued.length) return queued.shift()!;
      return new Promise<CanvasEvent>((resolve) => { pending = resolve; });
    },
    close: async () => {
      done = true;
      await reader.cancel();
    },
  };
}

async function nextMatching(stream: Awaited<ReturnType<typeof openEventStream>>, type: string): Promise<CanvasEvent> {
  for (;;) {
    const event = await stream.next();
    if (event.type === type) return event;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-canvas-live-'));
  workspace = join(root, 'workspace');
  runtime = await ensureServer(workspace);
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
  await api('/api/projects/shop/screens', {
    method: 'POST', body: JSON.stringify({ id: 'overview', name: 'Overview', width: 1200, height: 800, expectedRevision: 0 }),
  });
  await api('/api/projects/shop/screens', {
    method: 'POST', body: JSON.stringify({ id: 'orders', name: 'Orders', width: 1200, height: 800, expectedRevision: 1 }),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
});

afterEach(async () => {
  await stopServer(workspace).catch(() => undefined);
  await rm(root, { force: true, recursive: true });
});

describe('live updates', () => {
  it('sửa token chung thông báo các màn hình của project', async () => {
    const stream = await openEventStream();
    await writeFile(join(workspace, 'projects', 'shop', 'design-system.css'), ':root { --accent: #2563eb; }');
    const event = await nextMatching(stream, 'screen.changed');
    expect(event).toMatchObject({ projectId: 'shop', screenIds: ['orders', 'overview'] });
    await stream.close();
  });

  it('gộp burst save cho một màn hình và cho phép save sau lỗi file phục hồi', async () => {
    const stream = await openEventStream();
    const file = join(workspace, 'projects', 'shop', 'screens', 'overview', 'styles.css');
    await writeFile(file, 'body { color: red; }');
    await writeFile(file, 'body { color: blue; }');
    const first = await nextMatching(stream, 'screen.changed');
    expect(first.screenIds).toEqual(['overview']);

    await rm(file);
    const error = await nextMatching(stream, 'project.error');
    expect(error.projectId).toBe('shop');
    await writeFile(file, 'body { color: green; }');
    const recovered = await nextMatching(stream, 'screen.changed');
    expect(recovered.screenIds).toEqual(['overview']);
    await stream.close();
  });

  it('refresh toàn bộ màn hình khi token chung và một màn hình cùng đổi trong một burst', async () => {
    const stream = await openEventStream();
    await Promise.all([
      writeFile(join(workspace, 'projects', 'shop', 'design-system.css'), ':root { --accent: #7c3aed; }'),
      writeFile(join(workspace, 'projects', 'shop', 'screens', 'overview', 'styles.css'), 'body { color: #7c3aed; }'),
    ]);

    const event = await nextMatching(stream, 'screen.changed');
    expect(event).toMatchObject({ projectId: 'shop', screenIds: ['orders', 'overview'] });
    await stream.close();
  });

  it('client reconnect đọc được manifest hiện tại sau khi bỏ lỡ event', async () => {
    const stream = await openEventStream();
    await stream.close();
    const project = await api('/api/projects/shop');
    const current = (await project.json()) as { ok: true; data: { revision: number } };
    await api('/api/projects/shop/layout', {
      method: 'PATCH',
      body: JSON.stringify({ patches: [{ id: 'overview', x: 1600 }], expectedRevision: current.data.revision }),
    });

    const reconnected = await openEventStream();
    const latest = await api('/api/projects/shop');
    const body = (await latest.json()) as { ok: true; data: { screens: { id: string; x: number }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.screens.find((screen) => screen.id === 'overview')?.x).toBe(1600);
    await reconnected.close();
  });
});
