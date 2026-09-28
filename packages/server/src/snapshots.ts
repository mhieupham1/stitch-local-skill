import { createHash } from 'node:crypto';
import { access, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { addScreen, getProjectRoot, readProject } from '../../core/src/project-store.js';
import { resolveProjectFile } from '../../core/src/paths.js';
import { CanvasError, projectSchema, type Project, type Screen } from '../../core/src/schema.js';

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

async function copySource(root: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const name of ['project.json', 'design-system.css', 'screens', 'assets']) {
    const source = join(root, name);
    if (await exists(source)) await cp(source, join(target, name), { recursive: true, force: false, errorOnExist: true });
  }
}

function snapshotId(): string { return `snapshot-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`; }

class ProjectChangedDuringSnapshot extends Error {}

/**
 * A snapshot must describe one coherent source tree. Hash only editable project
 * inputs; runtime state, captures, and older snapshots deliberately stay out.
 */
async function sourceFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (relative: string): Promise<void> => {
    const path = join(root, relative);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        hash.update(`directory:${child}\n`);
        await visit(child);
      } else if (entry.isFile()) {
        hash.update(`file:${child}\n`);
        hash.update(await readFile(join(root, child)));
      } else {
        hash.update(`other:${child}\n`);
      }
    }
  };
  for (const name of ['project.json', 'design-system.css', 'screens', 'assets']) {
    const path = join(root, name);
    if (!(await exists(path))) continue;
    if (name === 'screens' || name === 'assets') {
      hash.update(`directory:${name}\n`);
      await visit(name);
    } else {
      hash.update(`file:${name}\n`);
      hash.update(await readFile(path));
    }
  }
  return hash.digest('hex');
}

export async function duplicateScreen(workspace: string, projectId: string, screenId: string, newId: string): Promise<Screen> {
  const project = await readProject(workspace, projectId);
  const original = project.screens.find((screen) => screen.id === screenId);
  if (!original) throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${screenId}”.`, 404);
  if (project.screens.some((screen) => screen.id === newId)) throw new CanvasError('SCREEN_EXISTS', `Màn hình “${newId}” đã tồn tại.`, 409);
  const root = await getProjectRoot(workspace, projectId);
  const source = dirname(await resolveProjectFile(root, original.entry));
  const entry = `screens/${newId}/index.html`;
  const destination = join(root, 'screens', newId);
  try {
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
    const updated = await addScreen(workspace, projectId, {
      ...original, id: newId, name: `${original.name} copy`, entry, x: original.x + original.width + 120,
    }, project.revision);
    return updated.screens.find((screen) => screen.id === newId)!;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function createSnapshot(workspace: string, projectId: string): Promise<{ snapshotId: string }> {
  const root = await getProjectRoot(workspace, projectId);
  await readProject(workspace, projectId);
  const snapshots = join(root, 'snapshots');
  const id = snapshotId();
  const staging = join(snapshots, `.${id}.staging`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const before = await sourceFingerprint(root);
      await copySource(root, staging);
      const after = await sourceFingerprint(root);
      if (before !== after) throw new ProjectChangedDuringSnapshot();
      await rename(staging, join(snapshots, id));
      return { snapshotId: id };
    } catch (error) {
      await rm(staging, { force: true, recursive: true });
      const sourceChanged = error instanceof ProjectChangedDuringSnapshot
        || (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code)));
      if (!sourceChanged) throw error;
    }
  }
  throw new CanvasError('PROJECT_BUSY', 'File thiết kế đang thay đổi. Hãy thử tạo snapshot lại sau ít giây.', 409);
}

export async function restoreSnapshot(workspace: string, projectId: string, id: string): Promise<{ backupSnapshotId: string }> {
  const root = await getProjectRoot(workspace, projectId);
  const snapshot = join(root, 'snapshots', id);
  let saved: Project;
  try { saved = projectSchema.parse(JSON.parse(await readFile(join(snapshot, 'project.json'), 'utf8'))); }
  catch { throw new CanvasError('SNAPSHOT_NOT_FOUND', `Snapshot “${id}” không hợp lệ hoặc không tồn tại.`, 404); }
  const current = await readProject(workspace, projectId);
  if (saved.id !== current.id) throw new CanvasError('INVALID_SNAPSHOT', 'Snapshot không thuộc project này.', 400);
  const backup = await createSnapshot(workspace, projectId);
  const staging = join(root, `.restore-${crypto.randomUUID()}`);
  const previous = join(root, `.previous-${crypto.randomUUID()}`);
  await copySource(snapshot, staging);
  const next = { ...saved, revision: current.revision + 1 };
  await writeFile(join(staging, 'project.json'), `${JSON.stringify(next, null, 2)}\n`);
  await mkdir(previous);
  const names = ['screens', 'assets', 'design-system.css', 'project.json'];
  try {
    for (const name of names) if (await exists(join(root, name))) await rename(join(root, name), join(previous, name));
    for (const name of names) if (await exists(join(staging, name))) await rename(join(staging, name), join(root, name));
  } catch (error) {
    for (const name of names) {
      if (!(await exists(join(previous, name)))) continue;
      await rm(join(root, name), { force: true, recursive: true });
      await rename(join(previous, name), join(root, name));
    }
    throw error;
  } finally {
    await rm(staging, { force: true, recursive: true });
    await rm(previous, { force: true, recursive: true });
  }
  return { backupSnapshotId: backup.snapshotId };
}
