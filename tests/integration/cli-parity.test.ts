import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

let root: string | undefined;
let workspace: string | undefined;

async function cli(...argumentsList: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'packages/cli/src/index.ts', ...argumentsList], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function setup(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'local canvas cli parity '));
  workspace = join(root, 'workspace');
  expect((await cli('start', '--workspace', workspace, '--json')).code).toBe(0);
  expect((await cli('project', 'create', 'shop', '--name', 'Shop', '--workspace', workspace, '--json')).code).toBe(0);
  expect((await cli('screen', 'add', 'home', '--project', 'shop', '--name', 'Home', '--width', '800', '--height', '600', '--workspace', workspace, '--json')).code).toBe(0);
  expect((await cli('screen', 'add', 'detail', '--project', 'shop', '--name', 'Detail', '--width', '800', '--height', '600', '--workspace', workspace, '--json')).code).toBe(0);
  return workspace;
}

afterEach(async () => {
  if (workspace) await cli('stop', '--workspace', workspace, '--json').catch(() => undefined);
  if (root) await rm(root, { force: true, recursive: true });
  root = undefined;
  workspace = undefined;
});

describe('CLI commands that mirror the management API', () => {
  it('đổi tên project mà giữ nguyên id', async () => {
    const space = await setup();
    const renamed = await cli('project', 'rename', 'shop', '--name', 'Cửa hàng', '--workspace', space, '--json');
    expect(renamed.code).toBe(0);
    expect(JSON.parse(renamed.stdout)).toMatchObject({ ok: true, data: { id: 'shop', name: 'Cửa hàng' } });

    const listed = await cli('project', 'list', '--workspace', space, '--json');
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, data: [{ id: 'shop', name: 'Cửa hàng' }] });
  });

  it('xóa màn hình theo danh sách id', async () => {
    const space = await setup();
    const deleted = await cli('screen', 'delete', 'detail', '--project', 'shop', '--workspace', space, '--json');
    expect(deleted.code).toBe(0);

    const listed = await cli('screen', 'list', '--project', 'shop', '--workspace', space, '--json');
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, data: [{ id: 'home' }] });
  });

  it('từ chối xóa khi không truyền id màn hình nào', async () => {
    const space = await setup();
    const deleted = await cli('screen', 'delete', '--project', 'shop', '--workspace', space, '--json');
    expect(deleted.code).not.toBe(0);
    expect(JSON.parse(deleted.stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining('ít nhất một ID màn hình') } });
  });

  it('từ chối đổi thứ tự khi không truyền id màn hình nào', async () => {
    const space = await setup();
    const ordered = await cli('screen', 'order', '--project', 'shop', '--workspace', space, '--json');
    expect(ordered.code).not.toBe(0);
    expect(JSON.parse(ordered.stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining('thứ tự layer') } });
  });

  it('đổi thứ tự layer màn hình', async () => {
    const space = await setup();
    const ordered = await cli('screen', 'order', 'detail', 'home', '--project', 'shop', '--workspace', space, '--json');
    expect(ordered.code).toBe(0);

    const listed = await cli('screen', 'list', '--project', 'shop', '--workspace', space, '--json');
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, data: [{ id: 'detail' }, { id: 'home' }] });
  });

  it('figma export đi đúng route của server', async () => {
    const space = await setup();
    // Màn hình không tồn tại để không phải khởi động Chromium: server trả SCREEN_NOT_FOUND
    // trước khi render, đủ để chứng minh lệnh đã tới đúng endpoint.
    const exported = await cli('figma', 'export', 'khong-ton-tai', '--project', 'shop', '--workspace', space, '--json');
    expect(exported.code).not.toBe(0);
    expect(JSON.parse(exported.stdout)).toMatchObject({ ok: false, error: { code: 'SCREEN_NOT_FOUND' } });
  });
});
