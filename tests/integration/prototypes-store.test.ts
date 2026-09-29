import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addScreen, createProject, readProject } from '../../packages/core/src/project-store.js';
import {
  createPrototype, deletePrototype, listPrototypes, readPrototype,
  regeneratePrototype, updatePrototype,
} from '../../packages/server/src/prototypes.js';
import { readPrototypeSources } from '../../packages/server/src/prototype-sources.js';

let workspace: string;
let root: string;

async function add(projectId: string, id: string): Promise<void> {
  const project = await readProject(workspace, projectId);
  await addScreen(workspace, projectId, { id, name: id, entry: `screens/${id}/index.html`, x: 0, y: 0, width: 800, height: 600 }, project.revision);
  const directory = join(workspace, 'projects', projectId, 'screens', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'index.html'), `<button data-design-id="${id}-button">Go</button>`);
}

async function input(projectId = 'shop') {
  return {
    id: 'booking', name: 'Đặt vé', screenIds: ['home', 'detail'], startScreenId: 'home',
    transitions: [{ fromScreenId: 'home', elementId: 'home-button', toScreenId: 'detail' }],
    expectedSourceBaseline: await readPrototypeSources(workspace, projectId, ['home', 'detail']),
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prototype-store-'));
  workspace = join(root, 'workspace');
  await createProject(workspace, { id: 'shop', name: 'Shop' });
  await add('shop', 'home');
  await add('shop', 'detail');
  await add('shop', 'other');
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('prototype store', () => {
  it('stores distinct prototypes per project without changing source screens', async () => {
    const projectBefore = await readFile(join(workspace, 'projects', 'shop', 'project.json'), 'utf8');
    const sourceBefore = await readFile(join(workspace, 'projects', 'shop', 'screens', 'home', 'index.html'), 'utf8');
    const first = await createPrototype(workspace, 'shop', await input());
    expect(first.id).toBe('booking');
    expect(first.stale).toBe(false);
    expect((await listPrototypes(workspace, 'shop')).map((item) => item.id)).toEqual(['booking']);
    await expect(createPrototype(workspace, 'shop', await input())).rejects.toMatchObject({ code: 'PROTOTYPE_EXISTS', statusCode: 409 });
    await createProject(workspace, { id: 'second', name: 'Second' });
    await add('second', 'home');
    await add('second', 'detail');
    expect((await createPrototype(workspace, 'second', await input('second'))).id).toBe('booking');
    expect(await readFile(join(workspace, 'projects', 'shop', 'project.json'), 'utf8')).toBe(projectBefore);
    expect(await readFile(join(workspace, 'projects', 'shop', 'screens', 'home', 'index.html'), 'utf8')).toBe(sourceBefore);
  });

  it('marks only relevant source changes stale and preserves baseline on ordinary update', async () => {
    await createPrototype(workspace, 'shop', await input());
    await writeFile(join(workspace, 'projects', 'shop', 'screens', 'other', 'index.html'), 'changed');
    expect((await readPrototype(workspace, 'shop', 'booking')).stale).toBe(false);
    await writeFile(join(workspace, 'projects', 'shop', 'screens', 'home', 'index.html'), 'changed');
    const stale = await readPrototype(workspace, 'shop', 'booking');
    expect(stale.changedScreenIds).toEqual(['home']);
    const patched = await updatePrototype(workspace, 'shop', 'booking', { expectedRevision: stale.revision, name: 'Đổi tên' });
    expect(patched.stale).toBe(true);
    await expect(updatePrototype(workspace, 'shop', 'booking', { expectedRevision: stale.revision, name: 'Old edit' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const regenerated = await regeneratePrototype(workspace, 'shop', 'booking', {
      expectedRevision: patched.revision, screenIds: patched.screenIds, startScreenId: patched.startScreenId,
      transitions: patched.transitions, expectedSourceBaseline: await readPrototypeSources(workspace, 'shop', patched.screenIds),
    });
    expect(regenerated.stale).toBe(false);
    expect(regenerated.id).toBe('booking');
  });

  it('marks a shared source edit stale and refuses source races', async () => {
    const original = await input();
    await writeFile(join(workspace, 'projects', 'shop', 'shared.css'), 'untracked root file');
    await mkdir(join(workspace, 'projects', 'shop', 'shared'));
    await writeFile(join(workspace, 'projects', 'shop', 'shared', 'menu.css'), 'old');
    await expect(createPrototype(workspace, 'shop', original)).rejects.toMatchObject({ code: 'SOURCE_CONFLICT', statusCode: 409 });
    await createPrototype(workspace, 'shop', await input());
    await writeFile(join(workspace, 'projects', 'shop', 'shared', 'menu.css'), 'new');
    expect((await readPrototype(workspace, 'shop', 'booking')).stale).toBe(true);
  });

  it('reports a deleted source screen on read and rejects unsafe prototype directories', async () => {
    await createPrototype(workspace, 'shop', await input());
    const project = await readProject(workspace, 'shop');
    const manifest = join(workspace, 'projects', 'shop', 'project.json');
    await writeFile(manifest, JSON.stringify({ ...project, revision: project.revision + 1, screens: project.screens.filter((screen) => screen.id !== 'detail') }));
    expect((await readPrototype(workspace, 'shop', 'booking')).missingScreenIds).toEqual(['detail']);
    await createProject(workspace, { id: 'unsafe', name: 'Unsafe' });
    await add('unsafe', 'home');
    await add('unsafe', 'detail');
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(workspace, 'projects', 'unsafe', 'prototypes'));
    await expect(createPrototype(workspace, 'unsafe', await input('unsafe'))).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
  });

  it('deletes only with the current revision and rejects corrupt JSON', async () => {
    const created = await createPrototype(workspace, 'shop', await input());
    await expect(deletePrototype(workspace, 'shop', 'booking', created.revision + 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await deletePrototype(workspace, 'shop', 'booking', created.revision);
    await expect(readPrototype(workspace, 'shop', 'booking')).rejects.toMatchObject({ code: 'PROTOTYPE_NOT_FOUND' });
    const directory = join(workspace, 'projects', 'shop', 'prototypes');
    await writeFile(join(directory, 'booking.json'), '{');
    await expect(readPrototype(workspace, 'shop', 'booking')).rejects.toMatchObject({ code: 'INVALID_PROTOTYPE' });
  });
});
