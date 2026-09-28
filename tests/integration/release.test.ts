import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
let root: string;
let releaseRoot: string;
let workspace: string;

async function run(...argumentsList: string[]): Promise<{ stdout: string; stderr: string }> {
  return execute(process.execPath, [join(releaseRoot, 'scripts', 'run.mjs'), ...argumentsList], { cwd: root });
}

beforeAll(async () => {
  await execute(process.execPath, ['scripts/build-release.mjs'], { cwd: resolve('.') });
  root = await mkdtemp(join(tmpdir(), 'local canvas release copy '));
  releaseRoot = join(root, 'local-design-canvas release');
  workspace = join(root, 'design workspace có dấu cách');
  await cp(resolve('dist/release/local-design-canvas'), releaseRoot, { recursive: true });
});

afterAll(async () => {
  if (releaseRoot && workspace) await run('stop', '--workspace', workspace, '--json').catch(() => undefined);
  if (root) await rm(root, { force: true, recursive: true });
});

describe('local release bundle', () => {
  it('chạy từ thư mục cài riêng, tạo source rồi stop/start và đọc lại dữ liệu', async () => {
    const started = JSON.parse((await run('start', '--workspace', workspace, '--json')).stdout) as { ok: boolean };
    expect(started.ok).toBe(true);
    const project = JSON.parse((await run('project', 'create', 'shop', '--name', 'Cửa hàng', '--workspace', workspace, '--json')).stdout) as { ok: boolean };
    expect(project.ok).toBe(true);
    const screen = JSON.parse((await run('screen', 'add', 'overview', '--project', 'shop', '--name', 'Tổng quan', '--width', '1440', '--height', '1000', '--workspace', workspace, '--json')).stdout) as { ok: boolean };
    expect(screen.ok).toBe(true);
    await run('stop', '--workspace', workspace, '--json');
    expect(JSON.parse((await run('start', '--workspace', workspace, '--json')).stdout)).toMatchObject({ ok: true });
    const screens = JSON.parse((await run('screen', 'list', '--project', 'shop', '--workspace', workspace, '--json')).stdout) as { ok: boolean; data: { id: string }[] };
    expect(screens).toMatchObject({ ok: true, data: [{ id: 'overview' }] });
    await expect(readFile(join(workspace, 'projects', 'shop', 'screens', 'overview', 'index.html'), 'utf8')).resolves.toContain('Tổng quan');
  });
});
