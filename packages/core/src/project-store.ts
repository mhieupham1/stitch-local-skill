import { access, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalWorkspace, isInside, resolveProjectDirectory } from './paths.js';
import {
  CanvasError,
  type Project,
  projectIdSchema,
  projectSchema,
  type Screen,
  type ScreenLayoutPatch,
  type ScreenOrder,
  screenLayoutPatchSchema,
} from './schema.js';

const projectQueues = new Map<string, Promise<void>>();

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withProjectQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectQueues.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  projectQueues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (projectQueues.get(key) === queued) projectQueues.delete(key);
  }
}

function assertWorkspaceChild(workspace: string, candidate: string): void {
  if (!isInside(workspace, candidate)) {
    throw new CanvasError('PATH_OUTSIDE_WORKSPACE', 'Đường dẫn project nằm ngoài workspace đã chọn.', 403);
  }
}

async function projectsDirectory(workspace: string, create: boolean): Promise<string | null> {
  const candidate = join(workspace, 'projects');
  if (create) await mkdir(candidate, { recursive: true });
  try {
    const canonical = await realpath(candidate);
    assertWorkspaceChild(workspace, canonical);
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !create) return null;
    throw error;
  }
}

export async function getProjectRoot(workspace: string, projectId: string): Promise<string> {
  const id = projectIdSchema.parse(projectId);
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  const projects = await projectsDirectory(canonicalWorkspacePath, false);
  if (!projects) throw new CanvasError('PROJECT_NOT_FOUND', `Không tìm thấy project “${id}”.`, 404);
  try {
    const root = await realpath(join(projects, id));
    if (!isInside(projects, root)) {
      throw new CanvasError('PATH_OUTSIDE_WORKSPACE', 'Project nằm ngoài workspace đã chọn.', 403);
    }
    return root;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CanvasError('PROJECT_NOT_FOUND', `Không tìm thấy project “${id}”.`, 404);
    }
    throw error;
  }
}

async function readManifest(root: string, projectId: string): Promise<Project> {
  const file = join(root, 'project.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CanvasError('PROJECT_NOT_FOUND', `Không tìm thấy project “${projectId}”.`, 404);
    }
    throw new CanvasError('INVALID_PROJECT_MANIFEST', `Manifest của project “${projectId}” không phải JSON hợp lệ.`, 500);
  }

  const schemaVersion = typeof parsed === 'object' && parsed !== null ? (parsed as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (schemaVersion !== 1) {
    throw new CanvasError('UNSUPPORTED_SCHEMA_VERSION', 'Phiên bản manifest chưa được hỗ trợ.', 400);
  }
  const result = projectSchema.safeParse(parsed);
  if (!result.success) {
    throw new CanvasError('INVALID_PROJECT_MANIFEST', result.error.issues.map((issue) => issue.message).join('; '), 500);
  }
  return result.data;
}

export async function createProject(workspace: string, input: { id: string; name: string }): Promise<Project> {
  const id = projectIdSchema.parse(input.id);
  const name = input.name.trim();
  if (!name) throw new CanvasError('VALIDATION_ERROR', 'Tên project không được để trống.');
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  const key = `${canonicalWorkspacePath}:${id}`;

  return withProjectQueue(key, async () => {
    const projects = await projectsDirectory(canonicalWorkspacePath, true);
    if (!projects) throw new CanvasError('INTERNAL_ERROR', 'Không tạo được thư mục projects.', 500);
    const root = join(projects, id);
    if (await pathExists(root)) {
      throw new CanvasError('PROJECT_EXISTS', `Project “${id}” đã tồn tại.`, 409);
    }
    await mkdir(root);
    const canonicalRoot = await realpath(root);
    if (!isInside(projects, canonicalRoot)) {
      throw new CanvasError('PATH_OUTSIDE_WORKSPACE', 'Project nằm ngoài workspace đã chọn.', 403);
    }
    await mkdir(join(canonicalRoot, 'screens'), { recursive: true });
    await Promise.all(['assets', 'snapshots', 'artifacts'].map((directory) => mkdir(join(canonicalRoot, directory), { recursive: true })));
    const project: Project = { schemaVersion: 1, revision: 0, id, name, screens: [] };
    await writeAtomic(join(canonicalRoot, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    return project;
  });
}

export async function readProject(workspace: string, projectId: string): Promise<Project> {
  const id = projectIdSchema.parse(projectId);
  return readManifest(await getProjectRoot(workspace, id), id);
}

export async function listProjects(workspace: string): Promise<Project[]> {
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  const directory = await projectsDirectory(canonicalWorkspacePath, false);
  if (!directory) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const projects = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try {
      return await readManifest(await getProjectRoot(canonicalWorkspacePath, entry.name), entry.name);
    } catch {
      return null;
    }
  }));
  return projects.filter((project): project is Project => project !== null).sort((left, right) => left.name.localeCompare(right.name));
}

export async function addScreen(
  workspace: string,
  projectId: string,
  screen: Screen,
  expectedRevision: number,
): Promise<Project> {
  const id = projectIdSchema.parse(projectId);
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  return withProjectQueue(`${canonicalWorkspacePath}:${id}`, async () => {
    const root = await getProjectRoot(canonicalWorkspacePath, id);
    const project = await readManifest(root, id);
    if (project.revision !== expectedRevision) {
      throw new CanvasError('REVISION_CONFLICT', 'Project đã thay đổi; hãy tải lại rồi thử lại.', 409);
    }
    if (project.screens.some((existing) => existing.id === screen.id)) {
      throw new CanvasError('SCREEN_EXISTS', `Màn hình “${screen.id}” đã tồn tại.`, 409);
    }
    const next = { ...project, revision: project.revision + 1, screens: [...project.screens, screen] };
    await writeAtomic(join(root, 'project.json'), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export async function updateLayout(
  workspace: string,
  projectId: string,
  patches: ScreenLayoutPatch[],
  expectedRevision: number,
): Promise<Project> {
  const id = projectIdSchema.parse(projectId);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new CanvasError('VALIDATION_ERROR', 'expectedRevision phải là số nguyên không âm.');
  }
  const validatedPatches = patches.map((patch) => screenLayoutPatchSchema.parse(patch));
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  return withProjectQueue(`${canonicalWorkspacePath}:${id}`, async () => {
    const root = await getProjectRoot(canonicalWorkspacePath, id);
    const project = await readManifest(root, id);
    if (project.revision !== expectedRevision) {
      throw new CanvasError('REVISION_CONFLICT', 'Project đã thay đổi; hãy tải lại rồi thử lại.', 409);
    }
    const patchById = new Map(validatedPatches.map((patch) => [patch.id, patch]));
    for (const screenId of patchById.keys()) {
      if (!project.screens.some((screen) => screen.id === screenId)) {
        throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${screenId}”.`, 404);
      }
    }
    const screens = project.screens.map((screen) => ({ ...screen, ...patchById.get(screen.id) }));
    const next: Project = { ...project, revision: project.revision + 1, screens };
    await writeAtomic(join(root, 'project.json'), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

// Layer order is stored as the array position of `project.screens`: the first
// entry paints at the back, the last entry paints on top. Reordering therefore
// rewrites the array rather than a separate index field, which keeps the
// sidebar list and the canvas stacking order impossible to drift apart.
export async function reorderScreens(
  workspace: string,
  projectId: string,
  order: ScreenOrder,
  expectedRevision: number,
): Promise<Project> {
  const id = projectIdSchema.parse(projectId);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new CanvasError('VALIDATION_ERROR', 'expectedRevision phải là số nguyên không âm.');
  }
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  return withProjectQueue(`${canonicalWorkspacePath}:${id}`, async () => {
    const root = await getProjectRoot(canonicalWorkspacePath, id);
    const project = await readManifest(root, id);
    if (project.revision !== expectedRevision) {
      throw new CanvasError('REVISION_CONFLICT', 'Project đã thay đổi; hãy tải lại rồi thử lại.', 409);
    }
    // Require an exact permutation of the current screens. Rejecting anything
    // else stops a stale client from dropping a screen that another client just
    // added, and stops duplicates from making the order ambiguous.
    const known = new Set(project.screens.map((screen) => screen.id));
    const seen = new Set<string>();
    for (const screenId of order) {
      if (!known.has(screenId)) {
        throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${screenId}”.`, 404);
      }
      if (seen.has(screenId)) {
        throw new CanvasError('VALIDATION_ERROR', `Màn hình “${screenId}” xuất hiện nhiều lần trong thứ tự layer.`);
      }
      seen.add(screenId);
    }
    if (order.length !== project.screens.length) {
      throw new CanvasError('VALIDATION_ERROR', 'Thứ tự layer phải liệt kê đủ tất cả màn hình của project.');
    }
    const byId = new Map(project.screens.map((screen) => [screen.id, screen]));
    const screens = order.map((screenId) => byId.get(screenId) as Screen);
    const next: Project = { ...project, revision: project.revision + 1, screens };
    await writeAtomic(join(root, 'project.json'), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

// Renames a project. Only the display name changes; the id stays put so every
// existing path, snapshot and open client keeps working.
export async function renameProject(
  workspace: string,
  projectId: string,
  name: string,
  expectedRevision: number,
): Promise<Project> {
  const id = projectIdSchema.parse(projectId);
  const nextName = name.trim();
  if (!nextName) {
    throw new CanvasError('VALIDATION_ERROR', 'Tên project không được để trống.');
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new CanvasError('VALIDATION_ERROR', 'expectedRevision phải là số nguyên không âm.');
  }
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  return withProjectQueue(`${canonicalWorkspacePath}:${id}`, async () => {
    const root = await getProjectRoot(canonicalWorkspacePath, id);
    const project = await readManifest(root, id);
    if (project.revision !== expectedRevision) {
      throw new CanvasError('REVISION_CONFLICT', 'Project đã thay đổi; hãy tải lại rồi thử lại.', 409);
    }
    // Renaming to the same name would burn a revision and wake every connected
    // client for nothing, so treat it as a no-op.
    if (project.name === nextName) return project;
    const next: Project = { ...project, revision: project.revision + 1, name: nextName };
    await writeAtomic(join(root, 'project.json'), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

// Removes screens from the manifest and deletes their source directories under
// `screens/`. Deleting the files too is what makes the screen id reusable: the
// adder refuses an id whose directory already exists, so leaving the files
// behind would block ever recreating a screen with the same id.
export async function deleteScreens(
  workspace: string,
  projectId: string,
  screenIds: string[],
  expectedRevision: number,
): Promise<Project> {
  const id = projectIdSchema.parse(projectId);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new CanvasError('VALIDATION_ERROR', 'expectedRevision phải là số nguyên không âm.');
  }
  if (!screenIds.length) {
    throw new CanvasError('VALIDATION_ERROR', 'Cần chọn ít nhất một màn hình để xóa.');
  }
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  return withProjectQueue(`${canonicalWorkspacePath}:${id}`, async () => {
    const root = await getProjectRoot(canonicalWorkspacePath, id);
    const project = await readManifest(root, id);
    if (project.revision !== expectedRevision) {
      throw new CanvasError('REVISION_CONFLICT', 'Project đã thay đổi; hãy tải lại rồi thử lại.', 409);
    }
    const removing = new Set(screenIds);
    // A duplicate id would make the removal count wrong, so reject it up front.
    if (removing.size !== screenIds.length) {
      throw new CanvasError('VALIDATION_ERROR', 'Danh sách màn hình cần xóa có mục trùng lặp.');
    }
    for (const screenId of removing) {
      if (!project.screens.some((screen) => screen.id === screenId)) {
        throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${screenId}”.`, 404);
      }
    }
    // An empty project has no screen to focus and no canvas to show; refusing here
    // keeps the invariant that a project always has at least one screen.
    if (project.screens.length - removing.size < 1) {
      throw new CanvasError('LAST_SCREEN', 'Không thể xóa màn hình cuối cùng của project.', 409);
    }
    const screens = project.screens.filter((screen) => !removing.has(screen.id));
    const next: Project = { ...project, revision: project.revision + 1, screens };
    // Write the manifest first: a half-deleted directory tree with a manifest that
    // still lists the screen would leave the canvas pointing at missing files,
    // whereas the manifest shrinking first can only leave orphaned directories,
    // which are harmless and removable by hand.
    await writeAtomic(join(root, 'project.json'), `${JSON.stringify(next, null, 2)}\n`);
    const screensDirectory = await resolveProjectDirectory(root, 'screens');
    for (const screenId of removing) {
      // A screen may legitimately have no source directory (it can be added purely
      // as a manifest entry), so a missing directory is not an error.
      await rm(join(screensDirectory, screenId), { force: true, recursive: true });
    }
    return next;
  });
}
