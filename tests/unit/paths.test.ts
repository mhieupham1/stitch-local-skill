import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveProjectFile } from '../../packages/core/src/paths.js';

describe('resolveProjectFile', () => {
  let root: string;
  let projectRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'local-canvas-paths-'));
    projectRoot = join(root, 'project có dấu cách');
    await mkdir(join(projectRoot, 'screens', 'overview'), { recursive: true });
    await writeFile(join(projectRoot, 'screens', 'overview', 'index.html'), '<h1>Overview</h1>');
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('trả về đường dẫn chuẩn hóa của file bên trong project', async () => {
    await expect(resolveProjectFile(projectRoot, 'screens/overview/index.html')).resolves.toBe(
      await realpath(join(projectRoot, 'screens', 'overview', 'index.html')),
    );
  });

  it('từ chối traversal ra ngoài project', async () => {
    await expect(resolveProjectFile(projectRoot, '../secret.txt')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_PROJECT',
    });
  });

  it('không theo symlink đi ra ngoài project', async () => {
    const outside = join(root, 'secret.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(projectRoot, 'screens', 'overview', 'outside.html'));

    await expect(resolveProjectFile(projectRoot, 'screens/overview/outside.html')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_PROJECT',
    });
  });
});
