import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureServer, getServerStatus, stopServer } from '../../packages/server/src/lifecycle.js';

const workspaces: string[] = [];
const impostors: ReturnType<typeof spawn>[] = [];

/**
 * Stands in for a server left running by an older build: it answers /health so
 * it looks alive, but has no /api/shutdown, which is how such a server behaves.
 * It reports no build id at all, like any server that predates the report.
 */
async function startImpostor(): Promise<{ pid: number; port: number }> {
  const script = `
    const http = require('node:http');
    const server = http.createServer((request, response) => {
      if (request.url === '/health') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true, data: { appId: 'local-design-canvas', protocolVersion: 1, instanceId: 'old-instance' } }));
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  impostors.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString())));
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`impostor thoát sớm với mã ${code}`)));
  });
  if (!child.pid) throw new Error('Không lấy được PID của impostor.');
  return { pid: child.pid, port };
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local canvas lifecycle '));
  const workspace = join(root, 'workspace có dấu cách');
  await mkdir(workspace, { recursive: true });
  workspaces.push(root);
  return workspace;
}

afterEach(async () => {
  for (const impostor of impostors.splice(0)) impostor.kill('SIGKILL');
  await Promise.all(
    workspaces.splice(0).map(async (root) => {
      const workspace = join(root, 'workspace có dấu cách');
      await stopServer(workspace).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }),
  );
});

describe('server lifecycle', () => {
  it('hai lần start cùng workspace trả cùng instance', async () => {
    const workspace = await createWorkspace();
    const [first, second] = await Promise.all([ensureServer(workspace), ensureServer(workspace)]);

    expect(first.instanceId).toBe(second.instanceId);
    expect(first.url).toBe(second.url);
    await expect(getServerStatus(workspace)).resolves.toEqual(first);
  });

  it('bỏ qua runtime state cũ mà không dừng PID không thuộc ứng dụng', async () => {
    const workspace = await createWorkspace();
    const runtimeDirectory = join(workspace, '.local-canvas');
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(
      join(runtimeDirectory, 'runtime.json'),
      JSON.stringify({
        instanceId: 'old-instance',
        pid: process.pid,
        url: 'http://127.0.0.1:1',
        previewUrl: 'http://127.0.0.1:2',
      }),
    );

    const runtime = await ensureServer(workspace);
    expect(runtime.instanceId).not.toBe('old-instance');
    expect(process.kill(process.pid, 0)).toBe(true);
  });

  it('báo port conflict do người dùng chọn mà không dừng tiến trình đang chiếm port', async () => {
    const workspace = await createWorkspace();
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Không lấy được port test.');

    await expect(ensureServer(workspace, { managementPort: address.port })).rejects.toMatchObject({
      code: 'PORT_IN_USE',
    });
    await expect(getServerStatus(workspace)).resolves.toBeNull();
    expect(occupied.listening).toBe(true);
    await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));
  });

  it('status không tự khởi động server và stop đóng cả management lẫn preview origin', async () => {
    const workspace = await createWorkspace();
    await expect(getServerStatus(workspace)).resolves.toBeNull();
    const runtime = await ensureServer(workspace);

    await stopServer(workspace);
    await expect(getServerStatus(workspace)).resolves.toBeNull();
    await expect(fetch(`${runtime.url}/health`)).rejects.toThrow();
    await expect(fetch(`${runtime.previewUrl}/health`)).rejects.toThrow();
  });

  it('khôi phục lock khởi động có owner không còn sống', async () => {
    const workspace = await createWorkspace();
    const lock = join(workspace, '.local-canvas', 'start.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999, createdAt: Date.now() - 60_000 }));

    await expect(ensureServer(workspace)).resolves.toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) });
  }, 15_000);

  it('thay server của bản build cũ thay vì tái sử dụng nó', async () => {
    const workspace = await createWorkspace();
    const impostor = await startImpostor();
    const runtimeDirectory = join(workspace, '.local-canvas');
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(
      join(runtimeDirectory, 'runtime.json'),
      JSON.stringify({
        instanceId: 'old-instance',
        pid: impostor.pid,
        url: `http://127.0.0.1:${impostor.port}`,
        previewUrl: `http://127.0.0.1:${impostor.port}`,
      }),
    );
    // It is alive and answers /health, so only the build it reports separates it
    // from a server this code can use.
    await expect(fetch(`http://127.0.0.1:${impostor.port}/health`)).resolves.toMatchObject({ ok: true });

    const runtime = await ensureServer(workspace);
    expect(runtime.instanceId).not.toBe('old-instance');
    expect(runtime.url).not.toBe(`http://127.0.0.1:${impostor.port}`);
    await expect(fetch(`http://127.0.0.1:${impostor.port}/health`)).rejects.toThrow();
    await expect(getServerStatus(workspace)).resolves.toEqual(runtime);
  }, 15_000);
});
