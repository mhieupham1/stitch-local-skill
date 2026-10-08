import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, PrototypeView, Screen, ScreenLayoutPatch, SelectionContext } from '../../core/src/schema.js';
import { ApiError, CanvasApi, clearPreviewUrl, connectEvents, readSession, savePreviewUrl } from './api.js';
import { CanvasViewport } from './features/canvas/CanvasViewport.js';
import { LayoutHistory } from './features/canvas/layout-history.js';
import type { SaveState } from './features/canvas/layout-state.js';
import type { Viewport } from './features/canvas/viewport-math.js';
import { PreviewSizeMenu } from './features/canvas/PreviewSizeMenu.js';
import { ProjectSidebar } from './features/projects/ProjectSidebar.js';
import { ProjectDirectory } from './features/projects/ProjectDirectory.js';
import { createPrototypePrompt, regeneratePrototypePrompt } from './features/prototypes/prompts.js';
import { PrototypePlayer } from './features/prototypes/PrototypePlayer.js';
import {
  IconAlert, IconCamera, IconCamera2, IconCheck, IconChevronLeft, IconCopy, IconFigma,
  IconLoader, IconMonitor, IconRedo, IconRotateCcw, IconTrash, IconUndo, IconX,
} from './icons.js';

const DEFAULT_VIEWPORT: Viewport = { x: 96, y: 96, zoom: 0.5 };
const viewportKey = (projectId: string) => `local-canvas-viewport:${projectId}`;
const readViewport = (projectId: string): Viewport => { try { return JSON.parse(localStorage.getItem(viewportKey(projectId)) ?? '') as Viewport; } catch { return DEFAULT_VIEWPORT; } };
const sidebarCollapsedKey = 'local-canvas-sidebar-collapsed';
const readSidebarCollapsed = (): boolean => {
  try { return localStorage.getItem(sidebarCollapsedKey) === '1'; } catch { return false; }
};
type PendingLayout = { projectId: string; patch: ScreenLayoutPatch };

// The four fields a drag, a resize or the inspector can change. Only these take
// part in undo; name and source are handled by their own flows.
const layoutOf = (screens: Screen[], ids: string[]): ScreenLayoutPatch[] =>
  ids.flatMap((id) => {
    const screen = screens.find((candidate) => candidate.id === id);
    return screen ? [{ id, x: screen.x, y: screen.y, width: screen.width, height: screen.height }] : [];
  });

// Compare two layouts field by field. A gesture that ends where it began — a drag
// out and back, or a width retyped to the same number — must not become an undo
// step, and reference equality would not catch that.
const sameLayout = (a: ScreenLayoutPatch[], b: ScreenLayoutPatch[]): boolean =>
  a.length === b.length && a.every((patch, index) => {
    const other = b[index];
    return patch.id === other.id && patch.x === other.x && patch.y === other.y && patch.width === other.width && patch.height === other.height;
  });

// A successful save confirms only the fields its patch carried. Keep any other
// local edit for that screen so one save cannot silently discard the rest.
const clearConfirmedFields = (draft: ScreenLayoutPatch | undefined, patch: ScreenLayoutPatch): ScreenLayoutPatch | undefined => {
  if (!draft) return undefined;
  const remaining = { ...draft };
  for (const key of Object.keys(patch) as (keyof ScreenLayoutPatch)[]) {
    if (key !== 'id' && remaining[key] === patch[key]) delete remaining[key];
  }
  return Object.keys(remaining).length > 1 ? remaining : undefined;
};

export function App() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('prototypeProject');
  const prototypeId = params.get('prototypeId');
  if (projectId && prototypeId) return <PrototypePlayer projectId={projectId} prototypeId={prototypeId} />;
  return <CanvasApp />;
}

function CanvasApp() {
  const requestedProjectId = useMemo(() => new URLSearchParams(window.location.search).get('project'), []);
  const session = useMemo(readSession, []);
  const api = useMemo(() => new CanvasApi(), []);
  // A URL from the fragment or storage is only a request: the management API
  // remains the authority for which companion preview belongs to this session.
  const previewCandidateUrl = useRef(session.previewUrl);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [availablePreviewUrl, setAvailablePreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(!session.previewUrl);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [project, setProject] = useState<Project | null>(null);
  const [prototypes, setPrototypes] = useState<PrototypeView[]>([]);
  const [prototypePrompt, setPrototypePrompt] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [selectedScreenIds, setSelectedScreenIds] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [bridgeNonce, setBridgeNonce] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  const [selectionStale, setSelectionStale] = useState(false);
  const [elementIdNotice, setElementIdNotice] = useState<{ id: string | null; status: 'pending' | 'copied' | 'failed' } | null>(null);
  const [editingScreenId, setEditingScreenId] = useState<string | null>(null);
  const [userEditingScreenId, setUserEditingScreenId] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<string | null>(null);
  const bridgeNonceRef = useRef<string | null>(null);
  const versionMenuRef = useRef<HTMLDivElement>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [figmaState, setFigmaState] = useState<'idle' | 'copying' | 'copied'>('idle');
  // Id of the screen whose id was just copied, so the header can confirm it.
  // `failed` keeps the id on screen after a refused clipboard write, which is
  // the only way the user can still copy it by hand. Distinct from
  // `elementIdNotice`, which is about a `data-design-id` inside a preview and
  // belongs to editing mode.
  const [screenIdNotice, setScreenIdNotice] = useState<{ id: string; status: 'copied' | 'failed' } | null>(null);
  const [pending, setPending] = useState<PendingLayout[]>([]);
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('reconnecting');
  const hasConnectedRef = useRef(false);
  const hadConnectionFailureRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [screenRevisions, setScreenRevisions] = useState<Record<string, number>>({});
  const projectRef = useRef<Project | null>(null);
  // Uncommitted local layout edits, keyed by screen id. A background refresh
  // must not overwrite what the user is still typing in the inspector.
  const draftRef = useRef<Record<string, ScreenLayoutPatch>>({});
  // Undo/redo for layout gestures. The stack lives in a ref because the pointer
  // handlers that record into it are not React state, but `canUndo`/`canRedo`
  // are mirrored into React state so the toolbar buttons can enable themselves.
  const historyRef = useRef(new LayoutHistory());
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  // The layout as it stood before the gesture now in progress, and which screens
  // it touched. Set on the first draft of a gesture, cleared when it is recorded.
  const gestureRef = useRef<{ before: ScreenLayoutPatch[]; projectId: string } | null>(null);
  // A history entry is recorded deep inside `persist`, which closes over the
  // state at the time it was created. Replaying a step must use the latest
  // project and save function, so the entry calls through these refs instead.
  const restoreLayoutRef = useRef<(snapshot: ScreenLayoutPatch[]) => void>(() => undefined);
  const undoLayoutRef = useRef<() => void>(() => undefined);
  const redoLayoutRef = useRef<() => void>(() => undefined);

  useEffect(() => { projectRef.current = project; }, [project]);

  const loadPrototypes = useCallback(async (projectId: string) => {
    const items = await api.listPrototypes(projectId);
    if (projectRef.current?.id === projectId) setPrototypes(items);
  }, [api]);

  useEffect(() => {
    setPrototypes([]);
    setPrototypePrompt(null);
    if (!project?.id) return;
    void loadPrototypes(project.id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Không tải được prototypes.'));
  }, [project?.id, loadPrototypes]);

  useEffect(() => {
    if (previewUrl) return;
    let active = true;
    setPreviewLoading(true);
    setPreviewError(null);
    void api.getPreview()
      .then(({ url }) => {
        if (!active) return;
        setAvailablePreviewUrl(url);
        setPreviewLoading(false);
        if (previewCandidateUrl.current === url) {
          setPreviewUrl(url);
          return;
        }
        if (previewCandidateUrl.current) {
          clearPreviewUrl();
          previewCandidateUrl.current = null;
        }
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setAvailablePreviewUrl(null);
        setPreviewError(cause instanceof Error ? cause.message : 'Không tải được preview của phiên canvas này.');
        setPreviewLoading(false);
      });
    return () => { active = false; };
  }, [api, previewRequest, previewUrl]);

  const loadProject = useCallback(async (projectId: string) => {
    if (!api) return;
    const fetched = await api.getProject(projectId);
    // SSE `project.updated` and reconnect both land here. Replay uncommitted local
    // drafts over the response so a background refresh cannot revert the value the
    // user is still typing in the inspector.
    const drafts = draftRef.current;
    const next = Object.keys(drafts).length
      ? { ...fetched, screens: fetched.screens.map((screen) => drafts[screen.id] ? { ...screen, ...drafts[screen.id] } : screen) }
      : fetched;
    setProject(next);
    setProjects((items) => items.some((item) => item.id === next.id)
      ? items.map((item) => item.id === next.id ? next : item)
      : [...items, next]);
    setSelectedScreenIds((current) => {
      const kept = current.filter((id) => next.screens.some((screen) => screen.id === id));
      if (kept.length) return kept;
      return next.screens[0] ? [next.screens[0].id] : [];
    });
    setViewport(readViewport(next.id));
    try {
      const editing = await api.getEditing(next.id);
      setEditingScreenId(editing.session?.screenId ?? null);
      setEditingMessage(editing.session?.message ?? null);
    } catch {
      setEditingScreenId(null);
      setEditingMessage(null);
    }
  }, [api]);

  const refreshProjects = useCallback(async () => {
    if (!api) return;
    try {
      const items = await api.listProjects();
      setProjects(items);
      if (requestedProjectId) await loadProject(requestedProjectId);
      if (!requestedProjectId) setError(null);
    } finally { setProjectsLoading(false); }
  }, [api, loadProject, requestedProjectId]);
  const refreshProjectsRef = useRef(refreshProjects);
  refreshProjectsRef.current = refreshProjects;

  useEffect(() => {
    if (!api) return;
    void refreshProjects().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Không tải được projects.'));
  }, [api, refreshProjects]);

  useEffect(() => {
    if (!api) return;
    return connectEvents(api, (event) => {
      const activeProject = projectRef.current;
      if (activeProject && event.projectId === activeProject.id && event.type === 'screen.changed') {
        setScreenRevisions((current) => {
          const next = { ...current };
          for (const screenId of event.screenIds) next[screenId] = (next[screenId] ?? activeProject.revision) + 1;
          return next;
        });
        // A source edit invalidates a stored selection for that screen: its selector
        // may no longer resolve, so mark it stale rather than presenting it as current.
        setSelection((current) => { if (current && event.screenIds.includes(current.screenId)) setSelectionStale(true); return current; });
      }
      if (activeProject && event.projectId === activeProject.id && (event.type === 'screen.changed' || event.type === 'prototype.updated')) {
        void loadPrototypes(activeProject.id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Không tải được prototypes.'));
      }
      if (activeProject && event.projectId === activeProject.id && event.type === 'screen.editing') {
        if (event.message === 'idle' || event.screenIds.length === 0) {
          setEditingScreenId(null);
          setEditingMessage(null);
        } else {
          setEditingScreenId(event.screenIds[0] ?? null);
          setEditingMessage(event.message ?? 'Agent đang chỉnh sửa');
        }
      }
      if (event.type === 'project.updated') void refreshProjectsRef.current().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Không tải được projects.'));
      if (activeProject && event.projectId === activeProject.id && event.type === 'project.error') setError(event.message ?? 'Không thể đọc thay đổi file thiết kế.');
    }, (state) => {
      setConnection(state);
      if (state === 'reconnecting') hadConnectionFailureRef.current = true;
      if (state === 'connected') {
        const activeProject = projectRef.current;
        // The first successful connection follows the initial fetch. Reload
        // every frame only if we previously missed events or reconnected.
        if (activeProject && (hasConnectedRef.current || hadConnectionFailureRef.current)) {
          void loadPrototypes(activeProject.id).catch(() => undefined);
          setScreenRevisions((current) => {
            const next = { ...current };
            for (const screen of activeProject.screens) next[screen.id] = (next[screen.id] ?? activeProject.revision) + 1;
            return next;
          });
        }
        hasConnectedRef.current = true;
        hadConnectionFailureRef.current = false;
        void refreshProjectsRef.current().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Không tải được projects.'));
      }
    });
  }, [api, loadPrototypes]);

  useEffect(() => {
    if (project) setSaveState(pending.some((item) => item.projectId === project.id) ? 'unsaved' : 'saved');
  }, [pending, project?.id]);

  // Project navigation creates a fresh document so editing state cannot leak
  // between projects with matching screen IDs. Protect unfinished layout saves.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (saveState !== 'saving' && !pending.length && !Object.keys(draftRef.current).length) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [saveState, pending.length]);

  const selectedScreenId = selectedScreenIds[selectedScreenIds.length - 1] ?? null;
  const selectedScreen = project?.screens.find((screen) => screen.id === selectedScreenId) ?? null;

  const selectScreens = useCallback((screenId: string | null, options?: { additive?: boolean }) => {
    if (screenId === null) {
      setSelectedScreenIds([]);
      return;
    }
    setSelectedScreenIds((current) => {
      if (options?.additive) {
        return current.includes(screenId)
          ? current.filter((id) => id !== screenId)
          : [...current, screenId];
      }
      return [screenId];
    });
  }, []);

  // Replace the whole selection in one update. The marquee band produces the
  // full id list, so it must not go through per-id toggling. An empty list means
  // the band caught nothing, which leaves the current selection alone.
  const selectScreenList = useCallback((ids: string[]) => {
    const next = [...new Set(ids)];
    if (next.length) setSelectedScreenIds(next);
  }, []);

  // Layer order is persisted as the array position of `project.screens`. Apply it
  // locally first so the sidebar and canvas z-order move together on release.
  const reorderScreens = useCallback(async (projectId: string, order: string[]) => {
    if (!api) { setError('Chưa kết nối API.'); return; }
    const before = projectRef.current;
    if (!before || before.id !== projectId) { setError(`Không khớp project: ${before?.id ?? 'null'} vs ${projectId}`); return; }
    const byId = new Map(before.screens.map((screen) => [screen.id, screen]));
    const reordered = order.flatMap((id) => { const screen = byId.get(id); return screen ? [screen] : []; });
    if (reordered.length !== before.screens.length) { setError(`Độ dài lệch: ${reordered.length} vs ${before.screens.length}`); return; }
    setProject((current) => current?.id === projectId ? { ...current, screens: reordered } : current);
    setProjects((items) => items.map((item) => item.id === projectId ? { ...item, screens: reordered } : item));
    try {
      const saved = await api.reorderScreens(projectId, order, before.revision);
      setProject((current) => current?.id === saved.id ? saved : current);
      setProjects((items) => items.map((item) => item.id === saved.id ? saved : item));
    } catch (cause) {
      // Put the previous order back; the server rejected the new one.
      setProject((current) => current?.id === projectId ? { ...current, screens: before.screens } : current);
      setProjects((items) => items.map((item) => item.id === projectId ? { ...item, screens: before.screens } : item));
      setError(cause instanceof Error ? cause.message : 'Không xếp lại được thứ tự layer.');
    }
  }, [api]);

  // Optimistic rename: the sidebar updates instantly and reverts if the server
  // rejects the change, which matches how layer reordering already behaves.
  const renameProject = useCallback(async (projectId: string, name: string) => {
    if (!api) return;
    const target = projects.find((item) => item.id === projectId);
    if (!target) return;
    const before = target;
    setProjects((items) => items.map((item) => item.id === projectId ? { ...item, name } : item));
    setProject((current) => current?.id === projectId ? { ...current, name } : current);
    try {
      const saved = await api.renameProject(projectId, name, before.revision);
      setProjects((items) => items.map((item) => item.id === saved.id ? saved : item));
      setProject((current) => current?.id === saved.id ? saved : current);
    } catch (cause) {
      setProjects((items) => items.map((item) => item.id === projectId ? before : item));
      setProject((current) => current?.id === projectId ? before : current);
      setError(cause instanceof Error ? cause.message : 'Không đổi được tên project.');
    }
  }, [api, projects]);

  // Deleting a screen removes it from the manifest and deletes its source
  // directory, so the id can be reused later.
  const deleteScreens = useCallback(async () => {
    if (!api || !project) return;
    const chosen = project.screens.filter((screen) => selectedScreenIds.includes(screen.id));
    if (!chosen.length) return;
    if (chosen.length === project.screens.length) {
      setError('Không thể xóa toàn bộ màn hình của project.');
      return;
    }
    const names = chosen.map((screen) => `“${screen.name}”`).join(', ');
    const confirmed = window.confirm(
      chosen.length === 1
        ? `Xóa màn hình ${names}?\n\nThư mục screens/${chosen[0].id}/ và toàn bộ file bên trong sẽ bị xóa vĩnh viễn.`
        : `Xóa ${chosen.length} màn hình ${names}?\n\nThư mục và toàn bộ file bên trong của ${chosen.length} màn hình này sẽ bị xóa vĩnh viễn.`,
    );
    if (!confirmed) return;
    const before = project;
    const removing = new Set(chosen.map((screen) => screen.id));
    const remaining = before.screens.filter((screen) => !removing.has(screen.id));
    // Drop the removed ids from any draft so a later refresh cannot resurrect them.
    for (const screenId of removing) delete draftRef.current[screenId];
    setProject((current) => current?.id === before.id ? { ...current, screens: remaining } : current);
    setProjects((items) => items.map((item) => item.id === before.id ? { ...item, screens: remaining } : item));
    setSelectedScreenIds((current) => current.filter((id) => !removing.has(id)));
    try {
      const saved = await api.deleteScreens(before.id, [...removing], before.revision);
      setProject((current) => current?.id === saved.id ? saved : current);
      setProjects((items) => items.map((item) => item.id === saved.id ? saved : item));
      setSelectedScreenIds((current) => {
        const kept = current.filter((id) => saved.screens.some((screen) => screen.id === id));
        if (kept.length) return kept;
        return saved.screens[0] ? [saved.screens[0].id] : [];
      });
    } catch (cause) {
      // Restore the pre-delete state; the server rejected the change.
      setProject((current) => current?.id === before.id ? before : current);
      setProjects((items) => items.map((item) => item.id === before.id ? before : item));
      setSelectedScreenIds(chosen.map((screen) => screen.id));
      setError(cause instanceof Error ? cause.message : 'Không xóa được màn hình.');
    }
  }, [api, project, selectedScreenIds]);

  // The highlighted screen is server state so an agent can read it. Element
  // selection stays separate and still requires Select mode. Clearing the
  // highlight also clears focus so "screen focus" returns NO_SCREEN_FOCUS.
  useEffect(() => {    if (!api || !project) return;
    if (!selectedScreenId) {
      void api.clearFocus(project.id).catch(() => undefined);
      return;
    }
    void api.focusScreen(project.id, selectedScreenId).catch(() => undefined);
  }, [api, project?.id, selectedScreenId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl/Cmd+B toggles the sidebar, matching the shortcut users expect from
      // editors. Checked before the Escape branch since it is a modified key.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setSidebarCollapsed((current) => {
          const next = !current;
          try { localStorage.setItem(sidebarCollapsedKey, next ? '1' : '0'); } catch { /* ignore */ }
          return next;
        });
        return;
      }
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      setSelectedScreenIds([]);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Cmd/Ctrl+Z undoes the last layout gesture, Shift+Cmd/Ctrl+Z redoes it. Kept in
  // its own listener because it must fire even while an inspector input has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      if (event.shiftKey) redoLayoutRef.current();
      else undoLayoutRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // History entries name screens by id, so they are meaningless once another
  // project is open. Clear only on an actual switch: a background refresh of the
  // same project keeps its id, and clearing there would drop the user's history.
  useEffect(() => {
    historyRef.current.clear();
    setHistoryState({ canUndo: false, canRedo: false });
  }, [project?.id]);

  useEffect(() => { bridgeNonceRef.current = bridgeNonce; }, [bridgeNonce]);

  // A per-frame nonce lets the shell reject a postMessage that claims to be a
  // different frame. Refresh it when the user starts editing another frame.
  useEffect(() => {
    if (userEditingScreenId !== selectedScreen?.id || !api || !project || !selectedScreen) { setBridgeNonce(null); return; }
    let active = true;
    void api.selectionNonce(project.id, selectedScreen.id)
      .then((result) => { if (active) setBridgeNonce(result.nonce); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Không lấy được phiên chọn phần tử.'); });
    return () => { active = false; };
  }, [userEditingScreenId, api, project?.id, selectedScreen?.id]);

  // A persisted canvas can be zoomed far out (for example 10%), which makes
  // iframe hit targets effectively impossible to use while editing. Bring the
  // selected preview back to a practical zoom while preserving its position.
  useEffect(() => {
    if (userEditingScreenId !== selectedScreen?.id || !project || !selectedScreen || viewport.zoom >= 0.35) return;
    const nextZoom = 0.5;
    const canvas = document.querySelector<HTMLElement>('.canvas-viewport')?.getBoundingClientRect();
    if (!canvas) return;
    const centerX = selectedScreen.x + selectedScreen.width / 2;
    const centerY = selectedScreen.y + selectedScreen.height / 2 + 32;
    setViewport((current) => {
      const x = canvas.width / 2 - centerX * nextZoom;
      const y = canvas.height / 2 - centerY * nextZoom;
      const next = { ...current, x, y, zoom: nextZoom };
      localStorage.setItem(viewportKey(project.id), JSON.stringify(next));
      return next;
    });
  }, [userEditingScreenId, project?.id, selectedScreen?.id, viewport.zoom]);

  useEffect(() => {
    if (userEditingScreenId !== selectedScreen?.id || !api || !project || !selectedScreen) return;
    const handler = (event: MessageEvent) => {
      // Validate the message: it must come from the exact selected iframe, carry the
      // current per-frame nonce, and target the selected screen. A sandboxed frame can
      // present an opaque origin, so we authenticate by source window + nonce, not origin.
      const iframe = document.querySelector<HTMLIFrameElement>(`[data-screen-id="${CSS.escape(selectedScreen.id)}"] iframe`);
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as Partial<SelectionContext> & { source?: string; kind?: string; nonce?: string; copied?: boolean };
      if (data.source !== 'local-design-canvas' || (data.kind !== 'selection' && data.kind !== 'hover' && data.kind !== 'clipboard')) return;
      if (data.nonce !== bridgeNonceRef.current) return;
      if (data.screenId !== selectedScreen.id || data.projectId !== project.id) return;
      if (data.kind === 'clipboard') {
        setElementIdNotice((current) => current?.id && current.id === data.elementId
          ? { id: current.id, status: data.copied ? 'copied' : 'failed' }
          : current);
        return;
      }
      const context: SelectionContext = {
        projectId: project.id,
        screenId: selectedScreen.id,
        sourceRevision: '',
        elementId: data.elementId ?? null,
        selector: data.selector ?? '',
        text: data.text ?? '',
        bounds: data.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      };
      if (data.kind === 'hover') {
        setSelection(context);
        setSelectionStale(false);
        return;
      }
      setElementIdNotice({ id: context.elementId, status: context.elementId ? 'pending' : 'failed' });
      void api.recordSelection(project.id, context, bridgeNonceRef.current ?? '')
        .then((saved) => {
          setSelection(saved);
          setSelectionStale(false);
        })
        .catch((cause: unknown) => { setElementIdNotice(null); setError(cause instanceof Error ? cause.message : 'Không ghi được lựa chọn.'); });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [userEditingScreenId, api, project?.id, selectedScreen?.id]);

  // A reselect or source edit can invalidate a stored selection. Drop the highlight
  // when the user switches away so a stale selector is never shown as current.
  useEffect(() => { setSelection(null); setSelectionStale(false); setElementIdNotice(null); }, [selectedScreenId, project?.id]);
  useEffect(() => { if (selection && selectedScreenId && selection.screenId !== selectedScreenId) setSelection(null); }, [selectedScreenId, selection]);

  const updateViewport = (next: Viewport) => { setViewport(next); if (project) localStorage.setItem(viewportKey(project.id), JSON.stringify(next)); };
  // Apply patches to the local project without touching the undo stack. Undo and
  // redo use this directly: replaying a recorded state is not itself a gesture,
  // so it must not open one.
  const applyProjectPatches = (patches: ScreenLayoutPatch[]) => {
    if (!patches.length) return;
    const nextDrafts = { ...draftRef.current };
    for (const patch of patches) nextDrafts[patch.id] = { ...nextDrafts[patch.id], ...patch };
    draftRef.current = nextDrafts;
    setProject((current) => {
      if (!current) return current;
      const byId = new Map(patches.map((patch) => [patch.id, patch]));
      return { ...current, screens: current.screens.map((screen) => byId.has(screen.id) ? { ...screen, ...byId.get(screen.id) } : screen) };
    });
  };
  const applyDraft = (patches: ScreenLayoutPatch[]) => {
    if (!patches.length) return;
    // The first change of a gesture remembers where it started, so the whole
    // drag undoes in one step rather than frame by frame.
    const current = projectRef.current;
    if (current && !gestureRef.current) {
      const before = layoutOf(current.screens, [...new Set(patches.map((patch) => patch.id))]);
      if (before.length) gestureRef.current = { before, projectId: current.id };
    }
    applyProjectPatches(patches);
  };
  const syncHistory = () => setHistoryState({ canUndo: historyRef.current.canUndo, canRedo: historyRef.current.canRedo });
  const persist = async (patches: ScreenLayoutPatch[], targetProject = project, options?: { record?: boolean }) => {
    if (!api || !targetProject || !patches.length) return;
    const before = targetProject;
    const record = options?.record !== false;
    const gesture = gestureRef.current;
    setSaveState('saving');
    const applySaved = (saved: Project) => {
      const kept = { ...draftRef.current };
      for (const patch of patches) {
        const remaining = clearConfirmedFields(kept[patch.id], patch);
        if (remaining) kept[patch.id] = remaining;
        else delete kept[patch.id];
      }
      draftRef.current = kept;
      if (project?.id === saved.id) setProject(saved);
      setProjects((items) => items.map((item) => item.id === saved.id ? saved : item));
      const patchIds = new Set(patches.map((patch) => patch.id));
      setPending((items) => items.filter((item) => item.projectId !== saved.id || !patchIds.has(item.patch.id)));
      if (project?.id === saved.id) setSaveState('saved');
      // One undo step for the gesture that just landed. A gesture that saved no
      // real change (a press that never moved) leaves no entry behind.
      if (record && gesture && gesture.projectId === saved.id) {
        const after = layoutOf(saved.screens, gesture.before.map((patch) => patch.id));
        if (after.length && !sameLayout(gesture.before, after)) {
          const start = gesture.before;
          historyRef.current.record({
            undo: () => restoreLayoutRef.current(start),
            redo: () => restoreLayoutRef.current(after),
          });
          syncHistory();
        }
      }
      // Clear only the gesture this save recorded. A save resolves asynchronously,
      // so an earlier one can land while the user has already started the next
      // drag; clearing unconditionally would drop that drag's starting layout and
      // make its undo jump back to a mid-drag position.
      if (gestureRef.current === gesture) gestureRef.current = null;
    };
    try { applySaved(await api.updateLayout(before.id, patches, before.revision)); }
    catch (cause) {
      if (cause instanceof ApiError && cause.code === 'REVISION_CONFLICT') {
        try { const latest = await api.getProject(before.id); applySaved(await api.updateLayout(latest.id, patches, latest.revision)); return; } catch { /* show retry below */ }
      }
      // The save is queued for retry; there is no confirmed new state to record.
      if (gestureRef.current === gesture) gestureRef.current = null;
      setPending((items) => {
        let next = items.filter((item) => item.projectId !== before.id || !patches.some((patch) => patch.id === item.patch.id));
        for (const patch of patches) {
          const previous = items.find((item) => item.projectId === before.id && item.patch.id === patch.id);
          next = [...next, { projectId: before.id, patch: { ...previous?.patch, ...patch } }];
        }
        return next;
      });
      if (project?.id === before.id) setSaveState('unsaved');
      setError('Bố cục chưa lưu được. Hãy thử lại khi server kết nối lại.');
    }
  };
  // Undo and redo replay a recorded layout through the same local-apply + save
  // path a gesture uses, then clear the bookmark so the replay is not itself
  // recorded as a new step.
  restoreLayoutRef.current = (snapshot: ScreenLayoutPatch[]) => {
    const current = projectRef.current;
    if (!current || !snapshot.length) return;
    applyProjectPatches(snapshot);
    void persist(snapshot, current, { record: false });
  };
  const undoLayout = () => { if (historyRef.current.undo()) syncHistory(); };
  const redoLayout = () => { if (historyRef.current.redo()) syncHistory(); };
  undoLayoutRef.current = undoLayout;
  redoLayoutRef.current = redoLayout;
  const captureScreen = async () => {
    if (!api || !project || !selectedScreen) return;
    try { const result = await api.captureScreen(project.id, selectedScreen.id); setError(`Đã lưu ảnh capture: ${result.imagePath}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể capture màn hình.'); }
  };
  /**
   * Copies the selected screen as rich HTML so it can be pasted straight into Figma.
   * The server does the DOM/CSS extraction (the preview runs on another origin, so
   * this window cannot read its document). Clipboard writes require a user gesture
   * and can still be refused — the plain-text fallback keeps the action useful.
   */
  const copyForFigma = async () => {
    if (!project || !selectedScreen || figmaState === 'copying') return;
    setFigmaState('copying');
    const requestId = crypto.randomUUID();
    const iframe = document.querySelector<HTMLIFrameElement>(`[data-screen-id="${CSS.escape(selectedScreen.id)}"] iframe`);
    if (!iframe) { setFigmaState('idle'); setError('Không tìm thấy preview để capture.'); return; }
    const previewWindow = iframe.contentWindow;
    if (!previewWindow) { setFigmaState('idle'); setError('Preview chưa sẵn sàng để capture.'); return; }
    try {
      const clipboard = navigator.clipboard as Clipboard & { write?: (items: ClipboardItem[]) => Promise<void> };
      if (!clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Trình duyệt không hỗ trợ rich clipboard. Hãy dùng Chrome hoặc Edge.');
      let resolvePayload!: (html: string) => void;
      let rejectPayload!: (error: Error) => void;
      const payload = new Promise<string>((resolve, reject) => { resolvePayload = resolve; rejectPayload = reject; });
      const timer = window.setTimeout(() => rejectPayload(new Error('Figma capture quá thời gian. Hãy thử lại.')), 35_000);
      const handler = (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow) return;
        const data = event.data as { source?: string; kind?: string; screenId?: string; requestId?: string; ok?: boolean; html?: string; message?: string };
        if (data.source !== 'local-design-canvas' || data.kind !== 'figma-capture' || data.screenId !== selectedScreen.id || data.requestId !== requestId) return;
        if (data.ok && typeof data.html === 'string') resolvePayload(data.html);
        else rejectPayload(new Error(data.message ?? 'Figma capture thất bại.'));
      };
      window.addEventListener('message', handler);
      const write = clipboard.write([new ClipboardItem({ 'text/html': payload.then((html) => new Blob([html], { type: 'text/html' })) })]);
      previewWindow.postMessage({ source: 'local-design-canvas', kind: 'figma-capture-start', requestId }, '*');
      try {
        // The preview resolves its intercepted clipboard.write only after the
        // shell confirms that the generated payload was received. Waiting for
        // `write` first would deadlock: write waits for payload, while the
        // preview waits for this confirmation before completing write.
        await payload;
        previewWindow.postMessage({ source: 'local-design-canvas', kind: 'figma-capture-result', requestId, ok: true }, '*');
        await write;
      } finally {
        window.clearTimeout(timer);
        window.removeEventListener('message', handler);
      }
      setFigmaState('copied');
      window.setTimeout(() => setFigmaState('idle'), 2500);
    } catch (cause) {
      previewWindow.postMessage({ source: 'local-design-canvas', kind: 'figma-capture-result', requestId, ok: false, message: cause instanceof Error ? cause.message : 'Clipboard bị từ chối.' }, '*');
      setFigmaState('idle');
      setError(cause instanceof Error ? cause.message : 'Không thể copy cho Figma.');
    }
  };
  const duplicateSelectedScreen = async () => {
    if (!api || !project || !selectedScreen) return;
    const newId = window.prompt('ID màn hình bản sao (slug)', `${selectedScreen.id}-copy`);
    if (!newId) return;
    try { await api.duplicateScreen(project.id, selectedScreen.id, newId); await loadProject(project.id); setSelectedScreenIds([newId]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể tạo bản sao màn hình.'); }
  };
  const createProjectSnapshot = async () => {
    if (!api || !project) return;
    try { const result = await api.createSnapshot(project.id); setError(`Đã lưu phiên bản: ${result.snapshotId}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể tạo snapshot.'); }
  };
  const restoreProjectSnapshot = async () => {
    if (!api || !project) return;
    const snapshotId = window.prompt('ID phiên bản cần khôi phục');
    if (!snapshotId) return;
    try { const result = await api.restoreSnapshot(project.id, snapshotId); await loadProject(project.id); setError(`Đã khôi phục snapshot. Backup hiện tại: ${result.backupSnapshotId}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể khôi phục snapshot.'); }
  };
  const pendingForProject = project ? pending.find((item) => item.projectId === project.id) : undefined;
  const updateDimension = (property: 'width' | 'height', value: string) => {
    if (!selectedScreen) return;
    const dimension = Number(value);
    if (!Number.isInteger(dimension) || dimension < 240 || dimension > 4096) return;
    applyDraft([{ id: selectedScreen.id, [property]: dimension }]);
  };
  const updateSidebarCollapsed = (next: boolean) => {
    setSidebarCollapsed(next);
    try { localStorage.setItem(sidebarCollapsedKey, next ? '1' : '0'); } catch { /* ignore */ }
  };
  const applyPreviewWidth = (width: number) => {
    if (!selectedScreen) return;
    const next = { id: selectedScreen.id, width };
    applyDraft([next]);
    void persist([next]);
  };

  const selectPreview = (url: string) => {
    savePreviewUrl(url);
    previewCandidateUrl.current = url;
    setPreviewUrl(url);
  };
  const changePreview = () => {
    clearPreviewUrl();
    previewCandidateUrl.current = null;
    window.location.assign('/');
  };
  const recopyElementId = async (id: string) => {
    const input = document.createElement('textarea');
    input.value = id;
    input.setAttribute('aria-hidden', 'true');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    try {
      input.select();
      if (document.execCommand('copy')) {
        setElementIdNotice({ id, status: 'copied' });
        return;
      }
    } catch { /* Try the async Clipboard API below. */ }
    finally { input.remove(); }
    try {
      await navigator.clipboard.writeText(id);
      setElementIdNotice({ id, status: 'copied' });
    } catch {
      setElementIdNotice({ id, status: 'failed' });
    }
  };
  const retryPreview = () => setPreviewRequest((current) => current + 1);

  const copyPrototypePrompt = async (prompt: string) => {
    setPrototypePrompt(prompt);
    setPromptCopied(false);
    try {
      await navigator.clipboard.writeText(prompt);
      setPromptCopied(true);
    } catch { /* The full prompt stays visible so it can be copied manually or retried. */ }
  };

  const copyPrototypeId = async (id: string) => {
    try { await navigator.clipboard.writeText(id); }
    catch { setError(`Không sao chép được ID “${id}”. Bạn có thể chọn ID đang hiển thị.`); }
  };

  /**
   * Copies the selected screen's id so it can be pasted into a prompt for the
   * agent. The id is the one the CLI addresses screens by, and it never appears
   * on screen — the frame shows the name, the sidebar shows the name — so this
   * is the only way to get it without opening DevTools. The confirmation is
   * inline rather than an error banner: a failure to copy is not an error state.
   */
  const copyScreenId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setScreenIdNotice({ id, status: 'copied' });
    } catch {
      setScreenIdNotice({ id, status: 'failed' });
    }
    window.setTimeout(() => setScreenIdNotice((current) => current?.id === id ? null : current), 4000);
  };

  const removePrototype = async (prototype: PrototypeView) => {
    if (!project) return;
    if (!window.confirm(`Xóa prototype “${prototype.name}” (${prototype.id})?\n\nChỉ prototype này bị xóa; các màn hình gốc vẫn được giữ nguyên.`)) return;
    const projectId = project.id;
    try {
      await api.deletePrototype(projectId, prototype.id, prototype.revision);
      if (projectRef.current?.id === projectId) setPrototypes((items) => items.filter((item) => item.id !== prototype.id));
    } catch (cause) {
      if (projectRef.current?.id !== projectId) return;
      setError(cause instanceof Error ? cause.message : 'Không xóa được prototype.');
      if (cause instanceof ApiError && cause.code === 'REVISION_CONFLICT') void loadPrototypes(projectId).catch(() => undefined);
    }
  };

  const persistPrototypePosition = async (id: string, x: number, y: number) => {
    if (!api || !project) return;
    const projectId = project.id;
    const before = prototypes.find((item) => item.id === id);
    if (!before) return;
    setSaveState('saving');
    try {
      let saved: PrototypeView;
      try { saved = await api.updatePrototypePosition(projectId, id, x, y, before.revision); }
      catch (cause) {
        if (!(cause instanceof ApiError && cause.code === 'REVISION_CONFLICT')) throw cause;
        const latest = await api.getPrototype(projectId, id);
        saved = await api.updatePrototypePosition(projectId, id, x, y, latest.revision);
      }
      if (projectRef.current?.id === projectId) {
        setPrototypes((items) => items.map((item) => item.id === id ? saved : item));
        setSaveState('saved');
      }
    } catch (cause) {
      if (projectRef.current?.id === projectId) {
        setPrototypes((items) => items.map((item) => item.id === id ? before : item));
        setSaveState('unsaved');
        setError(cause instanceof Error ? cause.message : 'Không lưu được vị trí prototype.');
      }
    }
  };

  if (!previewUrl) return <main className="app-message preview-picker" aria-live="polite">
    <h1>Chọn preview</h1>
    <p>Chọn preview do phiên Canvas hiện tại quản lý để tải giao diện.</p>
    {previewLoading && <p role="status">Đang tải preview…</p>}
    {availablePreviewUrl && <section className="preview-choice" aria-label="Preview khả dụng">
      <code>{availablePreviewUrl}</code>
      <button type="button" onClick={() => selectPreview(availablePreviewUrl)}>Dùng preview này</button>
    </section>}
    {previewError && <><p role="alert">{previewError}</p><button type="button" onClick={retryPreview}>Thử lại</button></>}
  </main>;
  if (!requestedProjectId) return <ProjectDirectory projects={projects} loading={projectsLoading} error={error} connection={connection} onChangePreview={changePreview} onCreate={async (input) => (await api.createProject(input)).project} onRetry={() => {
    setProjectsLoading(true);
    void refreshProjects().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Không tải được dự án.'));
  }} />;
  if (error && !project) return <div className="app-message"><h1>Không mở được dự án</h1><p role="alert">{error}</p><a className="header-btn" href="/">Về danh sách dự án</a></div>;
  return <div className={sidebarCollapsed ? 'app-shell sidebar-collapsed' : 'app-shell'}>
    <ProjectSidebar projects={project ? [project] : []} selectedProjectId={project?.id ?? null} selectedScreenIds={selectedScreenIds} onScreenSelect={selectScreens} onReorderScreens={(projectId, order) => void reorderScreens(projectId, order)} onRenameProject={(projectId, name) => void renameProject(projectId, name)} collapsed={sidebarCollapsed} onCollapsedChange={updateSidebarCollapsed} />
    <section className="canvas-shell">
      <header className="app-header">
        <a className="header-btn project-directory-back" href="/" title="Về danh sách dự án"><IconChevronLeft size={14} />Danh sách dự án</a>
        <div className="header-title">
          {project ? <h2>{project.name}</h2> : <span>Đang tải…</span>}
          <small className={`status-pill ${connection}`} data-testid="connection-status">
            {connection === 'connected' ? 'Đã kết nối' : 'Đang kết nối lại…'}
            {selectedScreenIds.length > 1 ? ` · ${selectedScreenIds.length} màn hình` : ''}
          </small>
        </div>

        <div className="header-actions">
          <button type="button" className="header-btn" onClick={changePreview}><IconMonitor size={14} />Đổi preview</button>
          {selectedScreen && !userEditingScreenId && <button className="header-btn screen-edit-button" type="button" onClick={() => { setBridgeNonce(null); setElementIdNotice(null); setUserEditingScreenId(selectedScreen.id); }}>Chỉnh sửa</button>}
          {userEditingScreenId && <button className="header-btn screen-edit-button active" type="button" onClick={() => { bridgeNonceRef.current = null; setBridgeNonce(null); setSelection(null); setSelectionStale(false); setElementIdNotice(null); setUserEditingScreenId(null); }}>{bridgeNonce ? 'Thoát chỉnh sửa' : 'Đang bật chọn…'}</button>}
          {selectedScreen && <PreviewSizeMenu width={selectedScreen.width} disabled={editingScreenId === selectedScreen.id} onPick={applyPreviewWidth} />}
          {selectedScreen && <div className="inspector">
            <label>W<input aria-label="Width" type="number" min="240" max="4096" value={selectedScreen.width} onChange={(event) => updateDimension('width', event.target.value)} onBlur={(event) => selectedScreen && void persist([{ id: selectedScreen.id, width: Number(event.target.value) }])} /></label>
            <label>H<input aria-label="Height" type="number" min="240" max="4096" value={selectedScreen.height} onChange={(event) => updateDimension('height', event.target.value)} onBlur={(event) => selectedScreen && void persist([{ id: selectedScreen.id, height: Number(event.target.value) }])} /></label>
            <button type="button" className="header-btn" data-testid="copy-screen-id" onClick={() => void copyScreenId(selectedScreen.id)} title={`Sao chép ID màn hình (${selectedScreen.id}) để dán vào prompt`}><IconCopy size={14} />{screenIdNotice?.id === selectedScreen.id ? 'Đã sao chép ID' : 'Sao chép ID'}</button>
          </div>}


          <span className={`save-state ${saveState}`} data-testid="save-state">
            {saveState === 'saving' ? <IconLoader size={13} /> : saveState === 'saved' ? <IconCheck size={13} /> : null}
            {saveState === 'saved' ? 'Đã lưu' : saveState === 'saving' ? 'Đang lưu…' : 'Chưa lưu'}
          </span>
          {pendingForProject && <button type="button" className="header-btn" onClick={() => void persist([pendingForProject.patch], project)}><IconRotateCcw size={14} />Thử lại</button>}

          <span className="header-sep" aria-hidden="true" />

          {project && selectedScreenIds.length >= 2 && <button type="button" className="header-btn prototype-create" onClick={() => void copyPrototypePrompt(createPrototypePrompt(project.id, selectedScreenIds))}>Tạo prototype</button>}
          {selectedScreen && <>
            <button type="button" className="header-btn" onClick={() => void captureScreen()}><IconCamera size={14} />Chụp ảnh</button>
            <button type="button" className="header-btn" data-testid="copy-figma" disabled={figmaState === 'copying'} onClick={() => void copyForFigma()} title="Copy màn hình dưới dạng HTML để paste thẳng vào Figma">
              {figmaState === 'copying' ? <IconLoader size={14} /> : figmaState === 'copied' ? <IconCheck size={14} /> : <IconFigma size={14} />}
              {figmaState === 'copying' ? 'Đang copy…' : figmaState === 'copied' ? 'Đã copy' : 'Copy cho Figma'}
            </button>
            <button type="button" className="header-btn" onClick={() => void duplicateSelectedScreen()}><IconCopy size={14} />Nhân bản</button>
            <button type="button" className="danger header-btn" data-testid="delete-screens" onClick={() => void deleteScreens()}><IconTrash size={14} />{selectedScreenIds.length > 1 ? `Xóa ${selectedScreenIds.length}` : 'Xóa'}</button>
          </>}

          <span className="header-sep" aria-hidden="true" />

          {project && <>
            <button type="button" className="header-btn" popoverTarget="version-actions" onClick={(event) => {
              const menu = versionMenuRef.current;
              if (!menu) return;
              const rect = event.currentTarget.getBoundingClientRect();
              menu.style.top = `${rect.bottom + 6}px`;
              menu.style.left = `${Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228))}px`;
            }}><IconCamera2 size={14} />Phiên bản <span aria-hidden="true">⌄</span></button>
            <div ref={versionMenuRef} id="version-actions" className="version-actions" popover="auto">
              <button type="button" onClick={() => { versionMenuRef.current?.hidePopover(); void createProjectSnapshot(); }}><IconCamera2 size={14} />Lưu phiên bản</button>
              <button type="button" onClick={() => { versionMenuRef.current?.hidePopover(); void restoreProjectSnapshot(); }}><IconRotateCcw size={14} />Khôi phục phiên bản…</button>
            </div>
          </>}

        </div>
      </header>
    <div className="canvas-body">
    {prototypePrompt && <section className="prototype-prompt" data-testid="prototype-prompt" aria-label="Prompt prototype">
      <div><span>{promptCopied ? 'Đã sao chép prompt. Dán vào Codex để tạo hoặc tạo lại prototype.' : 'Không sao chép được tự động. Hãy sao chép prompt bên dưới.'}</span><button type="button" onClick={() => void copyPrototypePrompt(prototypePrompt)}>Sao chép lại</button><button type="button" onClick={() => setPrototypePrompt(null)} aria-label="Đóng prompt">×</button></div>
      <textarea readOnly value={prototypePrompt} aria-label="Nội dung prompt prototype" onFocus={(event) => event.currentTarget.select()} />
    </section>}
    {error && <div className="error-banner" role="alert"><span><IconAlert size={14} /> {error}</span><button onClick={() => setError(null)}><IconX size={13} />Đóng</button></div>}
    {screenIdNotice && <div className={`screen-id-notice ${screenIdNotice.status}`} role="status" data-testid="screen-id-notice">
      {screenIdNotice.status === 'copied' ? <IconCheck size={14} /> : <IconAlert size={14} />}
      {screenIdNotice.status === 'copied' ? 'Đã sao chép ID màn hình: ' : 'Chưa sao chép được ID màn hình: '}
      <code>{screenIdNotice.id}</code>
    </div>}
    {editingScreenId && <div className="editing-banner" role="status">Đang chỉnh sửa: {editingMessage ?? editingScreenId}</div>}
    {userEditingScreenId && elementIdNotice && <div className="element-id-notice" role="status" data-testid="element-id-notice">
      {elementIdNotice.id ? <>
        <span>{elementIdNotice.status === 'copied' ? 'Đã sao chép ID:' : elementIdNotice.status === 'pending' ? 'Đang sao chép ID:' : 'Chưa sao chép được ID:'} <code>{elementIdNotice.id}</code></span>
        <button type="button" onClick={() => void recopyElementId(elementIdNotice.id!)}>Sao chép lại</button>
      </> : <span>Phần tử tạo động chưa có ID cố định. Hãy thêm <code>data-design-id</code> trong nguồn.</span>}
    </div>}
    {project ? <CanvasViewport projectId={project.id} screens={project.screens} prototypes={prototypes} previewUrl={previewUrl} revision={project.revision} screenRevisions={screenRevisions} viewport={viewport} selectedScreenIds={selectedScreenIds} bridgeNonce={bridgeNonce} selection={selection} selectionStale={selectionStale} editingScreenId={editingScreenId} userEditingScreenId={userEditingScreenId} editingMessage={editingMessage} canUndo={historyState.canUndo} canRedo={historyState.canRedo} onUndo={undoLayout} onRedo={redoLayout} onViewport={updateViewport} onSelect={selectScreens} onSelectMany={selectScreenList} onDraft={applyDraft} onPersist={(patches) => void persist(patches)} onPrototypeDraft={(id, x, y) => setPrototypes((items) => items.map((item) => item.id === id ? { ...item, x, y } : item))} onPrototypePersist={(id, x, y) => void persistPrototypePosition(id, x, y)} onRegeneratePrompt={(prototype) => void copyPrototypePrompt(regeneratePrototypePrompt(project.id, prototype.id, prototype.screenIds))} onCopyPrototypeId={(id) => void copyPrototypeId(id)} onDeletePrototype={(prototype) => void removePrototype(prototype)} /> : <div className="app-message">Đang tải project…</div>}
    </div></section>
  </div>;
}
