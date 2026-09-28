import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getProjectRoot, readProject } from '../../core/src/project-store.js';
import { resolveProjectFile } from '../../core/src/paths.js';
import { CanvasError, selectionContextSchema, type SelectionContext } from '../../core/src/schema.js';

/**
 * A selection stays valid only while the screen source it points at is unchanged.
 * `sourceRevision` hashes the screen's own files plus the shared token file, which
 * is intentionally different from the project's metadata revision: editing HTML or
 * CSS never bumps `project.revision`, yet it must invalidate a stale selection.
 */
export async function sourceRevision(workspace: string, projectId: string, screenId: string): Promise<string> {
  const project = await readProject(workspace, projectId);
  const screen = project.screens.find((item) => item.id === screenId);
  if (!screen) throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${screenId}”.`, 404);
  const root = await getProjectRoot(workspace, projectId);
  const screenDirectory = dirname(await resolveProjectFile(root, screen.entry));
  const hash = createHash('sha256');

  const visit = async (directory: string, label: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(directory, entry.name);
      const childLabel = `${label}/${entry.name}`;
      if (entry.isDirectory()) {
        hash.update(`dir:${childLabel}\n`);
        await visit(child, childLabel);
      } else if (entry.isFile()) {
        hash.update(`file:${childLabel}\n`);
        hash.update(await readFile(child));
      }
    }
  };

  await visit(screenDirectory, 'screen');
  try {
    hash.update('file:design-system.css\n');
    hash.update(await readFile(join(root, 'design-system.css')));
  } catch {
    // A project without shared tokens still hashes its screen source.
  }
  return hash.digest('hex').slice(0, 16);
}

type StoredSelection = { context: SelectionContext; screenNonces: Map<string, string> };

/**
 * Holds the most recent element selection per project. The store lives only in the
 * running server; a restart clears it and the agent must ask the user to reselect.
 * Each screen frame gets a per-frame nonce so the canvas shell can reject a
 * `postMessage` that claims to come from a different frame or an opaque origin.
 */
export type ScreenFocus = { screenId: string; name: string; entry: string };
export type ScreenEditSession = {
  projectId: string;
  screenId: string;
  name: string;
  message: string;
  startedAt: string;
};

const EDIT_SESSION_TTL_MS = 5 * 60_000;

export class SelectionStore {
  private readonly selections = new Map<string, StoredSelection>();
  private readonly focusedScreen = new Map<string, string>();
  private readonly editSessions = new Map<string, ScreenEditSession>();

  issueNonce(projectId: string, screenId: string): string {
    const nonce = crypto.randomUUID();
    const stored = this.selections.get(projectId);
    if (stored) stored.screenNonces.set(screenId, nonce);
    else this.selections.set(projectId, { context: emptyContext(projectId, screenId), screenNonces: new Map([[screenId, nonce]]) });
    return nonce;
  }

  private nonceFor(projectId: string, screenId: string): string | undefined {
    return this.selections.get(projectId)?.screenNonces.get(screenId);
  }

  async record(workspace: string, input: { context: SelectionContext; nonce: string }): Promise<SelectionContext> {
    const context = selectionContextSchema.parse(input.context);
    const expected = this.nonceFor(context.projectId, context.screenId);
    if (!expected || expected !== input.nonce) {
      throw new CanvasError('SELECTION_REJECTED', 'Selection đến từ frame không hợp lệ.', 403);
    }
    const revision = await sourceRevision(workspace, context.projectId, context.screenId);
    const stored: StoredSelection = this.selections.get(context.projectId) ?? { context, screenNonces: new Map() };
    stored.context = { ...context, sourceRevision: revision };
    this.selections.set(context.projectId, stored);
    return stored.context;
  }

  /**
   * Remembers which screen the user highlighted on the canvas. This is separate
   * from an element click: the agent can ask which frame is active without Select mode.
   * The value lives only in the running server and is cleared on restart.
   */
  async setFocus(workspace: string, projectId: string, screenId: string): Promise<ScreenFocus> {
    const project = await readProject(workspace, projectId);
    const screen = project.screens.find((item) => item.id === screenId);
    if (!screen) throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${screenId}”.`, 404);
    this.focusedScreen.set(projectId, screenId);
    return { screenId: screen.id, name: screen.name, entry: screen.entry };
  }

  clearFocus(projectId: string): void {
    this.focusedScreen.delete(projectId);
  }

  async getFocus(workspace: string, projectId: string): Promise<ScreenFocus | null> {
    const screenId = this.focusedScreen.get(projectId);
    if (!screenId) return null;
    const project = await readProject(workspace, projectId);
    const screen = project.screens.find((item) => item.id === screenId);
    if (!screen) {
      this.focusedScreen.delete(projectId);
      return null;
    }
    return { screenId: screen.id, name: screen.name, entry: screen.entry };
  }

  /**
   * Marks a screen as being edited by an agent. The canvas shows a lock overlay and
   * blocks Interact/Select on that frame until `clearEdit` runs. Sessions expire after
   * five minutes so a crashed agent cannot leave the UI locked forever.
   */
  async beginEdit(workspace: string, projectId: string, screenId: string, message = 'Agent đang chỉnh sửa'): Promise<ScreenEditSession> {
    const project = await readProject(workspace, projectId);
    const screen = project.screens.find((item) => item.id === screenId);
    if (!screen) throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${screenId}”.`, 404);
    const session: ScreenEditSession = {
      projectId,
      screenId: screen.id,
      name: screen.name,
      message: message.trim() || 'Agent đang chỉnh sửa',
      startedAt: new Date().toISOString(),
    };
    this.editSessions.set(projectId, session);
    return session;
  }

  clearEdit(projectId: string): ScreenEditSession | null {
    const previous = this.editSessions.get(projectId) ?? null;
    this.editSessions.delete(projectId);
    return previous;
  }

  getEdit(projectId: string): ScreenEditSession | null {
    const session = this.editSessions.get(projectId);
    if (!session) return null;
    if (Date.now() - Date.parse(session.startedAt) > EDIT_SESSION_TTL_MS) {
      this.editSessions.delete(projectId);
      return null;
    }
    return session;
  }

  async get(workspace: string, projectId: string): Promise<{ context: SelectionContext; stale: boolean } | null> {
    const stored = this.selections.get(projectId);
    if (!stored || !stored.context.selector) return null;
    const current = await sourceRevision(workspace, projectId, stored.context.screenId).catch(() => null);
    const stale = current === null || current !== stored.context.sourceRevision;
    return { context: stored.context, stale };
  }
}

function emptyContext(projectId: string, screenId: string): SelectionContext {
  return { projectId, screenId, sourceRevision: '', elementId: null, selector: '', text: '', bounds: { x: 0, y: 0, width: 0, height: 0 } };
}
