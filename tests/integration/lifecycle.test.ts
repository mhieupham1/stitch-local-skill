import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureServer, getServerStatus, stopServer } from '../../packages/server/src/lifecycle.js';

const workspaces: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local canvas lifecycle '));
  const workspace = join(root, 'workspace có dấu cách');
  await mkdir(workspace, { recursive: true });
  workspaces.push(root);
  return workspace;
}

afterEach(async () => {
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
});
