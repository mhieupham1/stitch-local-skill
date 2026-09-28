import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

afterEach(async () => {
  if (workspace) await cli('stop', '--workspace', workspace, '--json').catch(() => undefined);
  if (root) await rm(root, { force: true, recursive: true });
  root = undefined;
  workspace = undefined;
});

describe('project and screen CLI commands', () => {
  it('tạo, liệt kê và cập nhật màn hình qua CLI', async () => {
    root = await mkdtemp(join(tmpdir(), 'local canvas cli project '));
    workspace = join(root, 'workspace có dấu cách');
    expect((await cli('start', '--workspace', workspace, '--json')).code).toBe(0);

    const project = await cli('project', 'create', 'shop', '--name', 'Quản lý bán hàng', '--workspace', workspace, '--json');
    expect(project.code).toBe(0);
    expect(JSON.parse(project.stdout)).toMatchObject({ ok: true, data: { project: { id: 'shop' } } });

    const screen = await cli(
      'screen', 'add', 'overview', '--project', 'shop', '--name', 'Tổng quan', '--width', '1440', '--height', '1000', '--workspace', workspace, '--json',
    );
    expect(screen.code).toBe(0);
    expect(JSON.parse(screen.stdout)).toMatchObject({ ok: true, data: { screen: { id: 'overview' } } });

    const update = await cli('screen', 'update', 'overview', '--project', 'shop', '--x', '1600', '--y', '0', '--workspace', workspace, '--json');
    expect(update.code).toBe(0);
    expect(JSON.parse(update.stdout)).toMatchObject({ ok: true, data: { screens: [{ id: 'overview', x: 1600, y: 0 }] } });

    const listed = await cli('screen', 'list', '--project', 'shop', '--workspace', workspace, '--json');
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, data: [{ id: 'overview', x: 1600, y: 0 }] });
  });

  it('tạo variant và snapshot qua CLI', async () => {
    root = await mkdtemp(join(tmpdir(), 'local canvas cli m2 '));
    workspace = join(root, 'workspace');
    expect((await cli('start', '--workspace', workspace, '--json')).code).toBe(0);
    expect((await cli('project', 'create', 'shop', '--name', 'Shop', '--workspace', workspace, '--json')).code).toBe(0);
    expect((await cli('screen', 'add', 'overview', '--project', 'shop', '--name', 'Overview', '--width', '640', '--height', '480', '--workspace', workspace, '--json')).code).toBe(0);

    const capture = await cli('screenshot', 'overview', '--project', 'shop', '--workspace', workspace, '--json');
    expect(JSON.parse(capture.stdout)).toMatchObject({ ok: true, data: { width: 640, height: 480, imagePath: expect.stringContaining('.png') } });

    const duplicate = await cli('screen', 'duplicate', 'overview', '--new-id', 'overview-alt', '--project', 'shop', '--workspace', workspace, '--json');
    expect(JSON.parse(duplicate.stdout)).toMatchObject({ ok: true, data: { id: 'overview-alt' } });

    const created = await cli('snapshot', 'create', '--project', 'shop', '--workspace', workspace, '--json');
    const snapshotId = JSON.parse(created.stdout).data.snapshotId as string;
    await writeFile(join(workspace, 'projects', 'shop', 'screens', 'overview', 'index.html'), '<h1>changed</h1>');
    const restored = await cli('snapshot', 'restore', snapshotId, '--project', 'shop', '--workspace', workspace, '--json');
    expect(JSON.parse(restored.stdout)).toMatchObject({ ok: true, data: { backupSnapshotId: expect.any(String) } });
  });
});
