import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, deleteScreens, listProjects, readProject, renameProject, reorderScreens, updateLayout } from '../../packages/core/src/project-store.js';

type Fixture = {
  root: string;
  workspace: string;
};

describe('project store', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'local canvas '));
    fixture = { root, workspace: join(root, 'không gian thiết kế') };
  });

  afterEach(async () => {
    await rm(fixture.root, { force: true, recursive: true });
  });

  it('lưu và mở lại project có tên Unicode trong workspace có dấu cách', async () => {
    const created = await createProject(fixture.workspace, {
      id: 'cua-hang',
      name: 'Cửa hàng bán lẻ',
    });

    expect(created).toMatchObject({
      id: 'cua-hang',
      name: 'Cửa hàng bán lẻ',
      revision: 0,
      schemaVersion: 1,
      screens: [],
    });

    await expect(readProject(fixture.workspace, 'cua-hang')).resolves.toEqual(created);
  });

  it('từ chối ID project trùng mà không ghi đè manifest hiện có', async () => {
    await createProject(fixture.workspace, { id: 'shop', name: 'Bản gốc' });

    await expect(
      createProject(fixture.workspace, { id: 'shop', name: 'Bản thay thế' }),
    ).rejects.toMatchObject({ code: 'PROJECT_EXISTS' });

    await expect(readProject(fixture.workspace, 'shop')).resolves.toMatchObject({ name: 'Bản gốc' });
  });

  it('không làm mất thay đổi khi client dùng revision cũ', async () => {
    const project = await createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' });
    const updated = await updateLayout(fixture.workspace, project.id, [], project.revision);

    await expect(updateLayout(fixture.workspace, project.id, [], project.revision)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(updated.revision).toBe(1);
  });

  it('giữ nguyên byte của manifest lỗi để người dùng có thể phục hồi', async () => {
    const project = await createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' });
    const manifest = join(fixture.workspace, 'projects', project.id, 'project.json');
    const invalid = '{ "schemaVersion": 1, broken';
    await writeFile(manifest, invalid, 'utf8');

    await expect(readProject(fixture.workspace, project.id)).rejects.toMatchObject({
      code: 'INVALID_PROJECT_MANIFEST',
    });
    await expect(readFile(manifest, 'utf8')).resolves.toBe(invalid);
  });

  it('không theo symlink projects ra ngoài workspace khi tạo project', async () => {
    const outside = join(fixture.root, 'outside');
    await mkdir(fixture.workspace, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(fixture.workspace, 'projects'));

    await expect(createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' })).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
    await expect(readFile(join(outside, 'shop', 'project.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bỏ qua manifest hỏng để project lành vẫn mở được', async () => {
    await createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' });
    const broken = join(fixture.workspace, 'projects', 'broken');
    await mkdir(broken);
    await writeFile(join(broken, 'project.json'), '{ broken', 'utf8');

    await expect(listProjects(fixture.workspace)).resolves.toMatchObject([{ id: 'shop' }]);
  });

  describe('thứ tự layer', () => {
    // Three screens, in the insertion order the sidebar renders.
    const seed = async () => {
      const project = await createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' });
      const screens = ['mot', 'hai', 'ba'];
      const manifest = join(fixture.workspace, 'projects', project.id, 'project.json');
      await writeFile(manifest, `${JSON.stringify({
        ...project,
        screens: screens.map((id, index) => ({
          id, name: id, entry: `screens/${id}/index.html`, x: index * 100, y: 0, width: 800, height: 600,
        })),
      }, null, 2)}\n`, 'utf8');
      return project.id;
    };

    it('lưu thứ tự mới và tăng revision', async () => {
      const id = await seed();
      const reordered = await reorderScreens(fixture.workspace, id, ['ba', 'mot', 'hai'], 0);

      expect(reordered.revision).toBe(1);
      expect(reordered.screens.map((screen) => screen.id)).toEqual(['ba', 'mot', 'hai']);
      // The new order must survive a re-read, not just live in memory.
      await expect(readProject(fixture.workspace, id)).resolves.toMatchObject({
        revision: 1,
        screens: [{ id: 'ba' }, { id: 'mot' }, { id: 'hai' }],
      });
    });

    it('giữ nguyên toạ độ của màn hình khi đổi thứ tự', async () => {
      const id = await seed();
      const before = await readProject(fixture.workspace, id);
      const reordered = await reorderScreens(fixture.workspace, id, ['ba', 'mot', 'hai'], before.revision);

      for (const screen of reordered.screens) {
        expect(screen).toEqual(before.screens.find((original) => original.id === screen.id));
      }
    });

    it.each([
      ['thiếu màn hình', ['mot', 'hai']],
      ['trùng màn hình', ['mot', 'mot', 'hai']],
      ['nhiều màn hình hơn thực tế', ['mot', 'hai', 'ba', 'bon']],
      ['rỗng', []],
    ])('từ chối thứ tự %s và không ghi gì', async (_label, order) => {
      const id = await seed();
      await expect(reorderScreens(fixture.workspace, id, order, 0)).rejects.toMatchObject({
        code: expect.stringMatching(/VALIDATION_ERROR|SCREEN_NOT_FOUND/),
      });
      await expect(readProject(fixture.workspace, id)).resolves.toMatchObject({
        revision: 0,
        screens: [{ id: 'mot' }, { id: 'hai' }, { id: 'ba' }],
      });
    });

    it('từ chối màn hình không tồn tại', async () => {
      const id = await seed();
      await expect(reorderScreens(fixture.workspace, id, ['mot', 'hai', 'khong-co'], 0)).rejects.toMatchObject({
        code: 'SCREEN_NOT_FOUND',
      });
    });

    it('không cho client cũ ghi đè bằng revision lỗi thời', async () => {
      const id = await seed();
      await reorderScreens(fixture.workspace, id, ['ba', 'mot', 'hai'], 0);

      await expect(reorderScreens(fixture.workspace, id, ['mot', 'hai', 'ba'], 0)).rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
      });
      await expect(readProject(fixture.workspace, id)).resolves.toMatchObject({
        screens: [{ id: 'ba' }, { id: 'mot' }, { id: 'hai' }],
      });
    });
  });

  describe('xóa màn hình', () => {
    const seed = async () => {
      const project = await createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' });
      const screens = ['mot', 'hai', 'ba'];
      const manifest = join(fixture.workspace, 'projects', project.id, 'project.json');
      await writeFile(manifest, `${JSON.stringify({
        ...project,
        screens: screens.map((id, index) => ({
          id, name: id, entry: `screens/${id}/index.html`, x: index * 100, y: 0, width: 800, height: 600,
        })),
      }, null, 2)}\n`, 'utf8');
      return project.id;
    };

    it('xóa màn hình và giữ nguyên thứ tự của phần còn lại', async () => {
      const id = await seed();
      const after = await deleteScreens(fixture.workspace, id, ['hai'], 0);

      expect(after.revision).toBe(1);
      expect(after.screens.map((screen) => screen.id)).toEqual(['mot', 'ba']);
      await expect(readProject(fixture.workspace, id)).resolves.toMatchObject({
        screens: [{ id: 'mot' }, { id: 'ba' }],
      });
    });

    it('xóa được nhiều màn hình cùng lúc', async () => {
      const id = await seed();
      const after = await deleteScreens(fixture.workspace, id, ['mot', 'ba'], 0);
      expect(after.screens.map((screen) => screen.id)).toEqual(['hai']);
    });

    it('giữ nguyên toạ độ của màn hình không bị xóa', async () => {
      const id = await seed();
      const before = await readProject(fixture.workspace, id);
      const after = await deleteScreens(fixture.workspace, id, ['mot'], 0);

      for (const screen of after.screens) {
        expect(screen).toEqual(before.screens.find((original) => original.id === screen.id));
      }
    });

    it('chặn xóa màn hình cuối cùng', async () => {
      const id = await seed();
      const afterFirst = await deleteScreens(fixture.workspace, id, ['mot', 'hai'], 0);

      await expect(deleteScreens(fixture.workspace, id, ['ba'], afterFirst.revision)).rejects.toMatchObject({
        code: 'LAST_SCREEN',
      });
      await expect(readProject(fixture.workspace, id)).resolves.toMatchObject({
        revision: 1,
        screens: [{ id: 'ba' }],
      });
    });

    it('chặn xóa vượt quá số màn hình còn lại', async () => {
      const id = await seed();
      await expect(deleteScreens(fixture.workspace, id, ['mot', 'hai', 'ba'], 0)).rejects.toMatchObject({
        code: 'LAST_SCREEN',
      });
      await expect(readProject(fixture.workspace, id)).resolves.toMatchObject({ revision: 0, screens: [{ id: 'mot' }, { id: 'hai' }, { id: 'ba' }] });
    });

    it.each([
      ['màn hình không tồn tại', ['mot', 'khong-co']],
      ['danh sách trùng lặp', ['mot', 'mot']],
      ['danh sách rỗng', []],
    ])('từ chối %s và không ghi gì', async (_label, screenIds) => {
      const id = await seed();
      await expect(deleteScreens(fixture.workspace, id, screenIds, 0)).rejects.toMatchObject({
        code: expect.stringMatching(/SCREEN_NOT_FOUND|VALIDATION_ERROR/),
      });
      await expect(readProject(fixture.workspace, id)).resolves.toMatchObject({
        revision: 0,
        screens: [{ id: 'mot' }, { id: 'hai' }, { id: 'ba' }],
      });
    });

    it('không cho client cũ xóa bằng revision lỗi thời', async () => {
      const id = await seed();
      await deleteScreens(fixture.workspace, id, ['mot'], 0);

      await expect(deleteScreens(fixture.workspace, id, ['hai'], 0)).rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
      });
      await expect(readProject(fixture.workspace, id)).resolves.toMatchObject({
        screens: [{ id: 'hai' }, { id: 'ba' }],
      });
    });

    it('xóa luôn thư mục nguồn để có thể dùng lại id', async () => {
      const id = await seed();
      const sourceDir = join(fixture.workspace, 'projects', id, 'screens', 'hai');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'index.html'), '<html></html>', 'utf8');

      await deleteScreens(fixture.workspace, id, ['hai'], 0);

      // The id must be reusable, so the directory cannot survive the delete.
      await expect(readFile(join(sourceDir, 'index.html'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('không đụng tới thư mục của màn hình không bị xóa', async () => {
      const id = await seed();
      const keepDir = join(fixture.workspace, 'projects', id, 'screens', 'ba');
      await mkdir(keepDir, { recursive: true });
      await writeFile(join(keepDir, 'index.html'), '<html>keep</html>', 'utf8');

      await deleteScreens(fixture.workspace, id, ['mot'], 0);

      await expect(readFile(join(keepDir, 'index.html'), 'utf8')).resolves.toBe('<html>keep</html>');
    });

    it('vẫn xóa được màn hình không có thư mục nguồn', async () => {
      const id = await seed();
      // `seed` writes a manifest only; no screens/<id>/ directory exists at all.
      const after = await deleteScreens(fixture.workspace, id, ['hai'], 0);
      expect(after.screens.map((screen) => screen.id)).toEqual(['mot', 'ba']);
    });
  });

  describe('đổi tên project', () => {
    it('đổi tên và tăng revision', async () => {
      const project = await createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' });
      const after = await renameProject(fixture.workspace, project.id, 'Bán vé CGV', project.revision);

      expect(after.name).toBe('Bán vé CGV');
      expect(after.revision).toBe(project.revision + 1);
      await expect(readProject(fixture.workspace, project.id)).resolves.toMatchObject({ name: 'Bán vé CGV' });
    });

    it('giữ nguyên id để đường dẫn cũ vẫn dùng được', async () => {
      const project = await createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' });
      const after = await renameProject(fixture.workspace, project.id, 'Tên khác', project.revision);
      expect(after.id).toBe('shop');
    });

    it('cắt khoảng trắng thừa ở hai đầu', async () => {
      const project = await createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' });
      const after = await renameProject(fixture.workspace, project.id, '  Bán vé CGV  ', project.revision);
      expect(after.name).toBe('Bán vé CGV');
    });

    it('đổi tên thành chính tên cũ là thao tác rỗng, không tăng revision', async () => {
      const project = await createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' });
      const after = await renameProject(fixture.workspace, project.id, 'Cửa hàng', project.revision);

      // Burning a revision here would wake every connected client for nothing.
      expect(after.revision).toBe(project.revision);
      await expect(readProject(fixture.workspace, project.id)).resolves.toMatchObject({ revision: project.revision });
    });

    it.each([['rỗng', ''], ['chỉ có khoảng trắng', '   ']])('từ chối tên %s', async (_label, name) => {
      const project = await createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' });
      await expect(renameProject(fixture.workspace, project.id, name, project.revision)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      await expect(readProject(fixture.workspace, project.id)).resolves.toMatchObject({ name: 'Cửa hàng' });
    });

    it('không cho client cũ đổi tên bằng revision lỗi thời', async () => {
      const project = await createProject(fixture.workspace, { id: 'shop', name: 'Cửa hàng' });
      await renameProject(fixture.workspace, project.id, 'Tên mới', project.revision);

      await expect(renameProject(fixture.workspace, project.id, 'Tên khác nữa', project.revision)).rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
      });
      await expect(readProject(fixture.workspace, project.id)).resolves.toMatchObject({ name: 'Tên mới' });
    });

    it('không được vượt id project không tồn tại', async () => {
      await expect(renameProject(fixture.workspace, 'khong-co', 'Tên mới', 0)).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
      });
    });
  });
});
