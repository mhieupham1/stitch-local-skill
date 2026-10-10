import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addScreen, createProject, deleteProject, getProjectRoot, listProjects } from '../../packages/core/src/project-store.js';

type Fixture = { root: string; workspace: string };

/** Mirrors the manifest entry the server writes when it creates a screen. */
const screen = (id: string, name: string, index: number) => ({
  id,
  name,
  entry: `screens/${id}/index.html`,
  x: index * 920,
  y: 0,
  width: 800,
  height: 600,
});

describe('deleteProject', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'local canvas delete '));
    fixture = { root, workspace: join(root, 'không gian thiết kế') };
  });

  afterEach(async () => {
    await rm(fixture.root, { force: true, recursive: true });
  });

  /** A project with two screens plus a snapshot and a prototype directory. */
  async function seeded() {
    await createProject(fixture.workspace, { id: 'cua-hang', name: 'Cửa hàng' });
    await addScreen(fixture.workspace, 'cua-hang', screen('trang-chu', 'Trang chủ', 0), 0);
    await addScreen(fixture.workspace, 'cua-hang', screen('chi-tiet', 'Chi tiết', 1), 1);
    const root = await getProjectRoot(fixture.workspace, 'cua-hang');
    await mkdir(join(root, 'snapshots', 'snap-1'), { recursive: true });
    await mkdir(join(root, 'prototypes', 'proto-1'), { recursive: true });
    return root;
  }

  it('báo cáo nội dung sẽ xoá mà không đụng vào đĩa khi dryRun', async () => {
    const root = await seeded();
    const before = (await readdir(root)).sort();

    const preview = await deleteProject(fixture.workspace, 'cua-hang', 2, { dryRun: true });

    expect(preview).toEqual({
      projectId: 'cua-hang',
      name: 'Cửa hàng',
      screens: ['trang-chu', 'chi-tiet'],
      snapshots: 1,
      prototypes: 1,
      deleted: false,
    });
    expect((await readdir(root)).sort()).toEqual(before);
    await expect(listProjects(fixture.workspace)).resolves.toHaveLength(1);
  });

  it('xoá project và để lại workspace rỗng', async () => {
    await seeded();

    const result = await deleteProject(fixture.workspace, 'cua-hang', 2);

    expect(result.deleted).toBe(true);
    await expect(listProjects(fixture.workspace)).resolves.toEqual([]);
    await expect(getProjectRoot(fixture.workspace, 'cua-hang')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('giữ nguyên project khi revision đã cũ', async () => {
    await seeded();

    await expect(deleteProject(fixture.workspace, 'cua-hang', 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(listProjects(fixture.workspace)).resolves.toHaveLength(1);
  });

  it('từ chối project không tồn tại', async () => {
    await expect(deleteProject(fixture.workspace, 'khong-co', 0)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('đếm 0 snapshot và prototype khi project chưa có', async () => {
    await createProject(fixture.workspace, { id: 'moi', name: 'Mới' });

    const preview = await deleteProject(fixture.workspace, 'moi', 0, { dryRun: true });

    expect(preview).toMatchObject({ snapshots: 0, prototypes: 0, screens: [] });
  });

  it('chỉ xoá project được chỉ định', async () => {
    await seeded();
    await createProject(fixture.workspace, { id: 'khac', name: 'Khác' });

    await deleteProject(fixture.workspace, 'cua-hang', 2);

    const remaining = await listProjects(fixture.workspace);
    expect(remaining.map((project) => project.id)).toEqual(['khac']);
  });

  it('không đi theo symlink ra ngoài project', async () => {
    await createProject(fixture.workspace, { id: 'cua-hang', name: 'Cửa hàng' });
    const outside = join(fixture.root, 'ngoai');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'giu-lai.txt'), 'giữ lại');
    const root = await getProjectRoot(fixture.workspace, 'cua-hang');
    await mkdir(join(root, 'screens'), { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(outside, join(root, 'screens', 'lien-ket'));

    await deleteProject(fixture.workspace, 'cua-hang', 0);

    // `rm` does not follow symlinks, so the target outside the project survives.
    await expect(readdir(outside)).resolves.toEqual(['giu-lai.txt']);
  });
});
