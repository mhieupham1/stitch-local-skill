import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CanvasError } from './schema.js';

export function isInside(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference));
}

function assertRelativePath(relativePath: string): void {
  if (!relativePath || isAbsolute(relativePath)) {
    throw new CanvasError('PATH_OUTSIDE_PROJECT', 'Đường dẫn phải tương đối với project.', 403);
  }
}

export async function canonicalWorkspace(workspace: string): Promise<string> {
  await mkdir(resolve(workspace), { recursive: true });
  return realpath(resolve(workspace));
}

export async function resolveProjectFile(projectRoot: string, relativePath: string): Promise<string> {
  assertRelativePath(relativePath);
  const canonicalRoot = await realpath(projectRoot);
  const candidate = resolve(canonicalRoot, relativePath);
  if (!isInside(canonicalRoot, candidate)) {
    throw new CanvasError('PATH_OUTSIDE_PROJECT', 'Đường dẫn nằm ngoài project.', 403);
  }

  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch {
    throw new CanvasError('FILE_NOT_FOUND', 'Không tìm thấy file trong project.', 404);
  }
  if (!isInside(canonicalRoot, canonicalCandidate)) {
    throw new CanvasError('PATH_OUTSIDE_PROJECT', 'Symlink trỏ ra ngoài project.', 403);
  }

  const metadata = await stat(canonicalCandidate);
  if (!metadata.isFile()) {
    throw new CanvasError('FILE_NOT_FOUND', 'Đường dẫn không trỏ tới file.', 404);
  }
  return canonicalCandidate;
}

export async function resolveProjectDirectory(projectRoot: string, relativePath: string): Promise<string> {
  assertRelativePath(relativePath);
  const canonicalRoot = await realpath(projectRoot);
  const candidate = resolve(canonicalRoot, relativePath);
  if (!isInside(canonicalRoot, candidate)) {
    throw new CanvasError('PATH_OUTSIDE_PROJECT', 'Đường dẫn nằm ngoài project.', 403);
  }
  let current = canonicalRoot;
  for (const segment of relativePath.split(/[\\/]/)) {
    if (!segment || segment === '.' || segment === '..') {
      throw new CanvasError('PATH_OUTSIDE_PROJECT', 'Đường dẫn thư mục không hợp lệ.', 403);
    }
    const next = resolve(current, segment);
    try {
      const canonicalNext = await realpath(next);
      if (!isInside(canonicalRoot, canonicalNext)) {
        throw new CanvasError('PATH_OUTSIDE_PROJECT', 'Symlink trỏ ra ngoài project.', 403);
      }
      if (!(await stat(canonicalNext)).isDirectory()) {
        throw new CanvasError('FILE_NOT_FOUND', 'Đường dẫn không trỏ tới thư mục.', 404);
      }
      current = canonicalNext;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(next);
      const canonicalNext = await realpath(next);
      if (!isInside(canonicalRoot, canonicalNext)) {
        throw new CanvasError('PATH_OUTSIDE_PROJECT', 'Symlink trỏ ra ngoài project.', 403);
      }
      current = canonicalNext;
    }
  }
  return current;
}
