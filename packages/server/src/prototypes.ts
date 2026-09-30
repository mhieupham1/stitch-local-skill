import { readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectRoot, readProject } from '../../core/src/project-store.js';
import { isInside, resolveProjectDirectory, resolveProjectFile } from '../../core/src/paths.js';
import {
  CanvasError, projectIdSchema, prototypeCreateInputSchema, prototypePatchInputSchema,
  prototypeRegenerateInputSchema, prototypeSchema,
  type Prototype, type PrototypeCreateInput, type PrototypePatchInput, type PrototypeRegenerateInput, type PrototypeView,
} from '../../core/src/schema.js';
import { readPrototypeSources } from './prototype-sources.js';

const queues = new Map<string, Promise<void>>();

async function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  queues.set(key, queued);
  await previous;
  try { return await action(); } finally { release(); if (queues.get(key) === queued) queues.delete(key); }
}

async function directory(root: string, create: boolean): Promise<string | null> {
  const path = join(root, 'prototypes');
  if (create) return resolveProjectDirectory(root, 'prototypes');
  try {
    const canonical = await realpath(path);
    if (!isInside(root, canonical)) throw new CanvasError('PATH_OUTSIDE_PROJECT', 'Prototype nằm ngoài project.', 403);
    if (!(await stat(canonical)).isDirectory()) throw new CanvasError('INVALID_PROTOTYPE', 'Thư mục prototype không hợp lệ.', 500);
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function pathFor(dir: string, id: string): string { return join(dir, `${projectIdSchema.parse(id)}.json`); }

async function load(root: string, id: string): Promise<Prototype> {
  const dir = await directory(root, false);
  if (!dir) throw new CanvasError('PROTOTYPE_NOT_FOUND', `Không tìm thấy prototype “${id}”.`, 404);
  let raw: string;
  try {
    const safe = await resolveProjectFile(root, `prototypes/${id}.json`);
    if ((await stat(safe)).size > 1_000_000) throw new CanvasError('INVALID_PROTOTYPE', 'Prototype vượt quá giới hạn 1 MB.', 500);
    raw = await readFile(safe, 'utf8');
  } catch (error) {
    if (error instanceof CanvasError && error.code === 'FILE_NOT_FOUND') throw new CanvasError('PROTOTYPE_NOT_FOUND', `Không tìm thấy prototype “${id}”.`, 404);
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CanvasError('INVALID_PROTOTYPE', 'JSON prototype không hợp lệ.', 500); }
  const checked = prototypeSchema.safeParse(parsed);
  if (!checked.success || checked.data.id !== id) throw new CanvasError('INVALID_PROTOTYPE', 'Dữ liệu prototype không hợp lệ.', 500);
  return checked.data;
}

async function save(path: string, value: Prototype): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(text) > 1_000_000) throw new CanvasError('VALIDATION_ERROR', 'Prototype vượt quá giới hạn 1 MB.');
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function validateScreens(workspace: string, projectId: string, screenIds: string[]): Promise<void> {
  const project = await readProject(workspace, projectId);
  for (const id of screenIds) if (!project.screens.some((screen) => screen.id === id)) throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${id}”.`, 404);
}

async function assertSources(workspace: string, projectId: string, screenIds: string[], expected: Record<string, string>): Promise<Record<string, string>> {
  const actual = await readPrototypeSources(workspace, projectId, screenIds);
  if (Object.keys(actual).length !== Object.keys(expected).length || screenIds.some((id) => actual[id] !== expected[id])) {
    throw new CanvasError('SOURCE_CONFLICT', 'Nguồn giao diện đã đổi; hãy đọc lại trước khi lưu prototype.', 409);
  }
  return actual;
}

async function view(workspace: string, projectId: string, prototype: Prototype): Promise<PrototypeView> {
  const project = await readProject(workspace, projectId);
  const missingScreenIds = prototype.screenIds.filter((id) => !project.screens.some((screen) => screen.id === id));
  const present = prototype.screenIds.filter((id) => !missingScreenIds.includes(id));
  const current = await readPrototypeSources(workspace, projectId, present);
  const changedScreenIds = present.filter((id) => current[id] !== prototype.sourceBaseline[id]);
  return { ...prototype, stale: Boolean(prototype.requiresRegeneration) || changedScreenIds.length > 0 || missingScreenIds.length > 0, changedScreenIds, missingScreenIds };
}

export async function listPrototypes(workspace: string, projectId: string): Promise<PrototypeView[]> {
  const root = await getProjectRoot(workspace, projectId);
  const dir = await directory(root, false);
  if (!dir) return [];
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => view(workspace, projectId, await load(root, name.slice(0, -5)))));
}

export async function readPrototype(workspace: string, projectId: string, id: string): Promise<PrototypeView> {
  const root = await getProjectRoot(workspace, projectId);
  return view(workspace, projectId, await load(root, projectIdSchema.parse(id)));
}

export async function createPrototype(workspace: string, projectId: string, raw: PrototypeCreateInput): Promise<PrototypeView> {
  const input = prototypeCreateInputSchema.parse(raw);
  const root = await getProjectRoot(workspace, projectId);
  return serial(root, async () => {
    const dir = await directory(root, true);
    if (!dir) throw new CanvasError('INTERNAL_ERROR', 'Không tạo được thư mục prototype.', 500);
    const path = pathFor(dir, input.id);
    try { await stat(path); throw new CanvasError('PROTOTYPE_EXISTS', `Prototype “${input.id}” đã tồn tại.`, 409); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await validateScreens(workspace, projectId, input.screenIds);
    const sourceBaseline = await assertSources(workspace, projectId, input.screenIds, input.expectedSourceBaseline);
    const prototype = prototypeSchema.parse({ schemaVersion: 1, revision: 0, id: input.id, name: input.name, screenIds: input.screenIds, startScreenId: input.startScreenId, transitions: input.transitions, sourceBaseline });
    await save(path, prototype);
    return view(workspace, projectId, prototype);
  });
}

export async function updatePrototype(workspace: string, projectId: string, id: string, raw: PrototypePatchInput): Promise<PrototypeView> {
  const input = prototypePatchInputSchema.parse(raw);
  const root = await getProjectRoot(workspace, projectId);
  return serial(root, async () => {
    const previous = await load(root, id);
    if (previous.revision !== input.expectedRevision) throw new CanvasError('REVISION_CONFLICT', 'Prototype đã thay đổi; hãy tải lại.', 409);
    const { expectedRevision: _revision, ...patch } = input;
    const screenIds = patch.screenIds ?? previous.screenIds;
    const membershipChanged = screenIds.length !== previous.screenIds.length || screenIds.some((screenId) => !previous.screenIds.includes(screenId));
    const sourceBaseline = Object.fromEntries(screenIds.map((screenId) => [screenId, previous.sourceBaseline[screenId] ?? '0'.repeat(64)]));
    const previouslyStale = (await view(workspace, projectId, previous)).stale;
    const next = prototypeSchema.parse({
      ...previous, ...patch, sourceBaseline, revision: previous.revision + 1,
      requiresRegeneration: previouslyStale || membershipChanged,
    });
    await validateScreens(workspace, projectId, next.screenIds);
    await save(pathFor((await directory(root, false))!, id), next);
    return view(workspace, projectId, next);
  });
}

export async function regeneratePrototype(workspace: string, projectId: string, id: string, raw: PrototypeRegenerateInput): Promise<PrototypeView> {
  const input = prototypeRegenerateInputSchema.parse(raw);
  const root = await getProjectRoot(workspace, projectId);
  return serial(root, async () => {
    const previous = await load(root, id);
    if (previous.revision !== input.expectedRevision) throw new CanvasError('REVISION_CONFLICT', 'Prototype đã thay đổi; hãy tải lại.', 409);
    await validateScreens(workspace, projectId, input.screenIds);
    const sourceBaseline = await assertSources(workspace, projectId, input.screenIds, input.expectedSourceBaseline);
    const next = prototypeSchema.parse({ ...previous, screenIds: input.screenIds, startScreenId: input.startScreenId, transitions: input.transitions, sourceBaseline, requiresRegeneration: false, revision: previous.revision + 1 });
    await save(pathFor((await directory(root, false))!, id), next);
    return view(workspace, projectId, next);
  });
}

export async function deletePrototype(workspace: string, projectId: string, id: string, expectedRevision: number): Promise<void> {
  const root = await getProjectRoot(workspace, projectId);
  return serial(root, async () => {
    const previous = await load(root, id);
    if (previous.revision !== expectedRevision) throw new CanvasError('REVISION_CONFLICT', 'Prototype đã thay đổi; hãy tải lại.', 409);
    await rm(pathFor((await directory(root, false))!, id));
  });
}
