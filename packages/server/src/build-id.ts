import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the server executes is the code; what it serves is not. Dependencies,
 * workspace state and built canvas assets all sit beside the code, and the
 * canvas bundle is read from disk on each request — rebuilding it leaves a
 * running server perfectly able to serve it, so it must not count as a new
 * build. Counting it would also make the id drift whenever a test run rebuilds
 * the bundle, restarting the server underneath the run.
 */
const IGNORED = new Set(['node_modules', '.git', '.local-canvas', 'dist']);

/**
 * The files that decide what a canvas server does. Both the launcher and the
 * running server resolve this the same way, so their answers can be compared —
 * that comparison is the whole point, and a mismatch would restart the server
 * on every call.
 *
 * Three shapes, in the order they are tried:
 *  - a release launched through `run.mjs`, which names the bundled server;
 *  - a bundled server started some other way, found next to this module;
 *  - a checkout, where the TypeScript sources are what is running.
 */
async function codeRoots(): Promise<string[]> {
  const bundled = process.env.LOCAL_CANVAS_SERVER_ENTRY;
  if (bundled) return [dirname(bundled)];
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  if (await exists(join(moduleDirectory, 'server.mjs'))) return [moduleDirectory];
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  return [join(repository, 'packages'), join(repository, 'templates')];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collect(root: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // A root that is not there contributes nothing.
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await collect(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

/**
 * Fingerprints the code a server is running, so a launcher can tell a server
 * built from the current sources from one an earlier build left behind. The
 * running process computes this once at startup and reports it; the launcher
 * recomputes it from disk. A server whose answer no longer matches is serving
 * routes the current build may not have, and has to be replaced.
 *
 * Size and modification time stand in for content: they cost one `stat` per
 * file instead of a full read, and any build or edit moves at least one of them.
 */
export async function computeBuildId(): Promise<string> {
  return fingerprint(await codeRoots());
}

/** The fingerprint of an explicit set of roots; `computeBuildId` picks the roots. */
export async function fingerprint(roots: string[]): Promise<string> {
  const files: string[] = [];
  for (const root of roots) await collect(root, files);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    const info = await stat(file);
    hash.update(`${file}\0${info.size}\0${info.mtimeMs}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}
