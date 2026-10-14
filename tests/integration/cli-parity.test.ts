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

  it('xoá project, có dry run giữ nguyên dự án', async () => {
    const space = await setup();
    const preview = await cli('project', 'delete', 'shop', '--dry-run', '--workspace', space, '--json');
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ ok: true, data: { projectId: 'shop', screens: ['home', 'detail'], deleted: false } });
    const stillThere = await cli('project', 'list', '--workspace', space, '--json');
    expect(JSON.parse(stillThere.stdout)).toMatchObject({ ok: true, data: [{ id: 'shop' }] });

    const deleted = await cli('project', 'delete', 'shop', '--workspace', space, '--json');
    expect(deleted.code).toBe(0);
    expect(JSON.parse(deleted.stdout)).toMatchObject({ ok: true, data: { deleted: true } });
    const gone = await cli('project', 'list', '--workspace', space, '--json');
    expect(JSON.parse(gone.stdout)).toMatchObject({ ok: true, data: [] });
  });

  it('audit tokens đọc được báo cáo của server', async () => {
    const space = await setup();
    const audited = await cli('audit', 'tokens', '--project', 'shop', '--workspace', space, '--json');
    expect(audited.code).toBe(0);
    const report = JSON.parse(audited.stdout) as { ok: boolean; data: { tokens: unknown[]; findings: unknown[]; summary: { errors: number } } };
    expect(report.ok).toBe(true);
    // A freshly scaffolded project has no tokens yet, so the audit is empty but valid.
    expect(report.data.summary.errors).toBe(0);
    expect(Array.isArray(report.data.findings)).toBe(true);
  });

  it('figma export đi đúng route của server', async () => {
    const space = await setup();
    // Màn hình không tồn tại để không phải khởi động Chromium: server trả SCREEN_NOT_FOUND
    // trước khi render, đủ để chứng minh lệnh đã tới đúng endpoint.
    const exported = await cli('figma', 'export', 'khong-ton-tai', '--project', 'shop', '--workspace', space, '--json');
    expect(exported.code).not.toBe(0);
    expect(JSON.parse(exported.stdout)).toMatchObject({ ok: false, error: { code: 'SCREEN_NOT_FOUND' } });
  });

  it('đổi tên màn hình mà giữ nguyên id', async () => {
    const space = await setup();
    const renamed = await cli('screen', 'rename', 'home', '--name', 'Trang chủ', '--project', 'shop', '--workspace', space, '--json');
    expect(renamed.code).toBe(0);

    const listed = await cli('screen', 'list', '--project', 'shop', '--workspace', space, '--json');
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, data: [{ id: 'home', name: 'Trang chủ' }, { id: 'detail', name: 'Detail' }] });
  });

  it('xóa project và bỏ khỏi danh sách', async () => {
    const space = await setup();
    const deleted = await cli('project', 'delete', 'shop', '--workspace', space, '--json');
    expect(deleted.code).toBe(0);
    expect(JSON.parse(deleted.stdout)).toMatchObject({ ok: true, data: { deleted: true } });

    const listed = await cli('project', 'list', '--workspace', space, '--json');
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, data: [] });
  });

  it('liệt kê và xóa snapshot qua CLI', async () => {
    const space = await setup();
    const created = await cli('snapshot', 'create', '--project', 'shop', '--workspace', space, '--json');
    expect(created.code).toBe(0);
    const snapshotId = (JSON.parse(created.stdout) as { data: { snapshotId: string } }).data.snapshotId;

    const listed = await cli('snapshot', 'list', '--project', 'shop', '--workspace', space, '--json');
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, data: [{ id: snapshotId, bytes: expect.any(Number) }] });

    const removed = await cli('snapshot', 'delete', snapshotId, '--project', 'shop', '--workspace', space, '--json');
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ ok: true, data: { deleted: true } });

    const after = await cli('snapshot', 'list', '--project', 'shop', '--workspace', space, '--json');
    expect(JSON.parse(after.stdout)).toMatchObject({ ok: true, data: [] });
  });

  it('từ chối xóa snapshot khi không truyền id', async () => {
    const space = await setup();
    const removed = await cli('snapshot', 'delete', '--project', 'shop', '--workspace', space, '--json');
    expect(removed.code).not.toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining('Thiếu ID snapshot') } });
  });
});
