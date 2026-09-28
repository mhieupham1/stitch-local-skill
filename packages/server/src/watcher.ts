import { relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { readProject } from '../../core/src/project-store.js';
import { CanvasEvents } from './events.js';

type PendingChange = {
  screenIds: Set<string>;
  refreshAll: boolean;
  hasError: boolean;
  timer?: NodeJS.Timeout;
};

function ignored(path: string): boolean {
  return path.includes(`${sep}.local-canvas${sep}`)
    || path.includes(`${sep}artifacts${sep}`)
    || path.includes(`${sep}snapshots${sep}`)
    || path.endsWith(`${sep}project.json`);
}

export function watchWorkspace(workspace: string, events: CanvasEvents): FSWatcher {
  const pending = new Map<string, PendingChange>();
  const watcher = watch(workspace, {
    ignoreInitial: true,
    ignored,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });

  const flush = async (projectId: string) => {
    const change = pending.get(projectId);
    if (!change) return;
    pending.delete(projectId);
    try {
      const project = await readProject(workspace, projectId);
      if (change.hasError) {
        events.publish({ type: 'project.error', projectId, screenIds: [...change.screenIds], message: 'Một file thiết kế đã bị xóa hoặc không thể đọc.' });
        return;
      }
      const screenIds = change.refreshAll || !change.screenIds.size
        ? project.screens.map((screen) => screen.id).sort()
        : [...change.screenIds].sort();
      events.publish({ type: 'screen.changed', projectId, screenIds });
    } catch (error) {
      events.publish({
        type: 'project.error',
        projectId,
        screenIds: [...change.screenIds].sort(),
        message: error instanceof Error ? error.message : 'Không thể đọc project sau khi file thay đổi.',
      });
    }
  };

  watcher.on('all', (eventName, path) => {
    const segments = relative(workspace, path).split(sep);
    if (segments.length < 3 || segments[0] !== 'projects') return;
    const projectId = segments[1];
    const projectRelative = segments.slice(2);
    if (!projectId || projectRelative[0] === 'artifacts' || projectRelative[0] === 'snapshots' || projectRelative[0] === 'project.json') return;
    const change = pending.get(projectId) ?? { screenIds: new Set<string>(), refreshAll: false, hasError: false };
    if (projectRelative[0] === 'screens' && projectRelative[1]) change.screenIds.add(projectRelative[1]);
    else change.refreshAll = true;
    if (eventName === 'unlink' || eventName === 'unlinkDir') change.hasError = true;
    pending.set(projectId, change);
    if (change.timer) clearTimeout(change.timer);
    change.timer = setTimeout(() => void flush(projectId), 150);
  });
  watcher.on('error', (error) => {
    events.publish({
      type: 'project.error',
      projectId: 'unknown',
      screenIds: [],
      message: error instanceof Error ? error.message : 'File watcher gặp lỗi không xác định.',
    });
  });
  return watcher;
}
