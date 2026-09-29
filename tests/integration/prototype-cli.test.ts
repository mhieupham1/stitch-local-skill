import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;
let workspace: string;

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string; data: any }> {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'packages/cli/src/index.ts', ...args, '--workspace', workspace, '--json'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  return { ...result, data: JSON.parse(result.stdout) };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prototype-cli-'));
  workspace = join(root, 'workspace có dấu cách');
  expect((await cli('start')).code).toBe(0);
  expect((await cli('project', 'create', 'shop', '--name', 'Shop')).code).toBe(0);
  expect((await cli('screen', 'add', 'home', '--project', 'shop', '--name', 'Home', '--width', '800', '--height', '600')).code).toBe(0);
  expect((await cli('screen', 'add', 'detail', '--project', 'shop', '--name', 'Detail', '--width', '800', '--height', '600')).code).toBe(0);
});

afterEach(async () => {
  await cli('stop').catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('prototype CLI', () => {
  it('creates, reads, updates, regenerates and deletes by stable ID', async () => {
    const sources = await cli('prototype', 'sources', '--project', 'shop', '--screens', 'home,detail');
    expect(sources.data).toMatchObject({ ok: true, data: { home: expect.any(String), detail: expect.any(String) } });
    const projectPath = join(workspace, 'projects', 'shop', 'project.json');
    const projectBefore = await readFile(projectPath, 'utf8');
    const inputPath = join(root, 'prototype-input.json');
    await writeFile(inputPath, JSON.stringify({ id: 'booking', name: 'Booking', screenIds: ['home', 'detail'], startScreenId: 'home', transitions: [{ fromScreenId: 'home', elementId: 'home-link', toScreenId: 'detail' }], expectedSourceBaseline: sources.data.data }));
    const created = await cli('prototype', 'create', 'booking', '--project', 'shop', '--input', inputPath);
    expect(created.data).toMatchObject({ ok: true, data: { id: 'booking', revision: 0 } });
    expect(await readFile(projectPath, 'utf8')).toBe(projectBefore);
    expect((await cli('prototype', 'list', '--project', 'shop')).data.data.map((item: { id: string }) => item.id)).toEqual(['booking']);
    expect((await cli('prototype', 'get', 'booking', '--project', 'shop')).data.data.id).toBe('booking');
    await writeFile(inputPath, JSON.stringify({ expectedRevision: 0, name: 'Updated' }));
    expect((await cli('prototype', 'update', 'booking', '--project', 'shop', '--input', inputPath)).data).toMatchObject({ ok: true, data: { revision: 1, name: 'Updated' } });
    await writeFile(inputPath, JSON.stringify({ expectedRevision: 1, screenIds: ['home', 'detail'], startScreenId: 'detail', transitions: [], expectedSourceBaseline: sources.data.data }));
    expect((await cli('prototype', 'regenerate', 'booking', '--project', 'shop', '--input', inputPath)).data).toMatchObject({ ok: true, data: { revision: 2, startScreenId: 'detail' } });
    expect((await cli('prototype', 'delete', 'booking', '--project', 'shop', '--revision', '2')).data).toMatchObject({ ok: true });
    expect((await cli('prototype', 'list', '--project', 'shop')).data.data).toEqual([]);
  });

  it('surfaces source conflicts as one structured JSON result', async () => {
    const sources = await cli('prototype', 'sources', '--project', 'shop', '--screens', 'home,detail');
    await writeFile(join(workspace, 'projects', 'shop', 'screens', 'home', 'index.html'), '<h1>Changed</h1>');
    const inputPath = join(root, 'conflict.json');
    await writeFile(inputPath, JSON.stringify({ id: 'booking', name: 'Booking', screenIds: ['home', 'detail'], startScreenId: 'home', transitions: [], expectedSourceBaseline: sources.data.data }));
    const result = await cli('prototype', 'create', 'booking', '--project', 'shop', '--input', inputPath);
    expect(result.code).toBe(1);
    expect(result.data).toMatchObject({ ok: false, error: { code: 'SOURCE_CONFLICT' } });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });
});
