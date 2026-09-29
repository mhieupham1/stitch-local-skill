import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getProjectRoot, readProject } from '../../core/src/project-store.js';
import { isInside, resolveProjectFile } from '../../core/src/paths.js';
import { CanvasError, projectIdSchema } from '../../core/src/schema.js';

async function hashPath(hash: ReturnType<typeof createHash>, root: string, path: string, label: string): Promise<void> {
  let metadata;
  try { metadata = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update(`missing:${label}\n`); return; }
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new CanvasError('PATH_OUTSIDE_PROJECT', 'Symlink trong nguồn prototype không được hỗ trợ.', 403);
  if (metadata.isDirectory()) {
    if (!isInside(root, path)) throw new CanvasError('PATH_OUTSIDE_PROJECT', 'Nguồn prototype nằm ngoài project.', 403);
    hash.update(`dir:${label}\n`);
    for (const entry of (await readdir(path)).sort()) await hashPath(hash, root, join(path, entry), `${label}/${entry}`);
  } else if (metadata.isFile()) {
    hash.update(`file:${label}:${metadata.size}\n`);
    hash.update(await readFile(path));
  }
}

export async function readPrototypeSources(workspace: string, projectId: string, screenIds: string[]): Promise<Record<string, string>> {
  projectIdSchema.parse(projectId);
  const project = await readProject(workspace, projectId);
  const root = await getProjectRoot(workspace, projectId);
  const shared = createHash('sha256');
  await hashPath(shared, root, join(root, 'design-system.css'), 'design-system.css');
  await hashPath(shared, root, join(root, 'shared'), 'shared');
  await hashPath(shared, root, join(root, 'assets'), 'assets');
  const sharedDigest = shared.digest('hex');
  const result: Record<string, string> = {};
  for (const id of screenIds) {
    const screen = project.screens.find((item) => item.id === id);
    if (!screen) throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${id}”.`, 404);
    const entry = await resolveProjectFile(root, screen.entry);
    const hash = createHash('sha256');
    hash.update(`shared:${sharedDigest}\n`);
    await hashPath(hash, root, dirname(entry), `screen:${id}`);
    result[id] = hash.digest('hex');
  }
  return result;
}
