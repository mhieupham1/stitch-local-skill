import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Project } from '../../../../core/src/schema.js';
import { gapAtPoint, moveEntries } from './layer-order.js';
import { IconChevronLeft, IconChevronRight, IconLayers, IconMenu } from '../../icons.js';

type Props = {
  projects: Project[];
  selectedProjectId: string | null;
  selectedScreenIds: string[];
  onProjectSelect: (id: string) => void;
  onScreenSelect: (id: string | null, options?: { additive?: boolean }) => void;
  // Receives the full new layer order (back of the stack first).
  onReorderScreens: (projectId: string, order: string[]) => void;
  onRenameProject: (projectId: string, name: string) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
};

type DragState = {
  // The row the pointer grabbed, which is the one that follows the cursor.
  id: string;
  projectId: string;
  // Every row being moved, and the indices they occupied when the drag started.
  ids: string[];
  order: string[];
  from: number[];
  startY: number;
  // Distance the pointer must travel before this becomes a reorder instead of a click.
  threshold: number;
  // The gap the row would be dropped into, refreshed on every move.
  slot: number;
  active: boolean;
  // Whether the grabbed row was already the only selected one, which decides
  // whether releasing without a drag selects it or clears it.
  selected: boolean;
  soleSelected: boolean;
};

// Pointer travel before a press turns into a reorder. Small enough to feel
// immediate, large enough that a click to select never nudges the list.
const DRAG_THRESHOLD = 4;

export function ProjectSidebar({ projects, selectedProjectId, selectedScreenIds, onProjectSelect, onScreenSelect, onReorderScreens, onRenameProject, collapsed, onCollapsedChange }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<{ ids: string[]; fromIndex: number; toIndex: number; offsetY: number } | null>(null);
  // While a reorder is in flight the list must render the reordered array, not
  // the server's array, otherwise the row would snap back mid-gesture.
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  // Which project is currently being renamed from the sidebar, plus the draft
  // text. A null id means no rename is in progress.
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Mirror of `previewOrder` for the pointer-up handler: state is not readable
  // synchronously inside the same event that set it.
  const previewRef = useRef<string[] | null>(null);
  const setPreview = useCallback((next: string[] | null) => {
    previewRef.current = next;
    setPreviewOrder(next);
  }, []);

  const project = projects.find((item) => item.id === selectedProjectId) ?? null;
  const serverOrder = project ? project.screens.map((screen) => screen.id) : [];
  const order = previewOrder && previewOrder.length === serverOrder.length ? previewOrder : serverOrder;
  // The server order as a string, so effects can depend on its identity without
  // re-running on every render for an array that never changes.
  const serverKey = serverOrder.join(',');
  const previewKey = previewOrder?.join(',') ?? null;
  // A rejected reorder reverts `project.screens`; drop the preview so the list
  // follows the source of truth again.
  const serverScreens = project?.screens;
  const confirmedRef = useRef(serverScreens);
  confirmedRef.current = serverScreens;

  useEffect(() => {
    if (!previewOrder) return;
    // A background refresh that landed the reordered list clears the local preview.
    if (previewKey === serverKey) { setPreview(null); return; }
    // A screen disappeared (restore, another client) while a drag was pending.
    if (previewOrder.some((id) => !serverOrder.includes(id))) setPreview(null);
  }, [serverKey, previewKey, previewOrder, serverOrder, setPreview]);

  const cancel = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
    setPreview(null);
  }, [setPreview]);

  // Focus and select the rename field as soon as it appears, so the user can
  // type over the old name without clicking into it.
  useEffect(() => {
    if (!renameId) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [renameId]);

  const startRename = useCallback((item: Project) => {
    setRenameId(item.id);
    setRenameDraft(item.name);
  }, []);

  const commitRename = useCallback(() => {
    const id = renameId;
    if (!id) return;
    const current = projects.find((item) => item.id === id);
    setRenameId(null);
    const name = renameDraft.trim();
    // An empty name, or one that did not actually change, is not worth a request.
    if (!name || !current || name === current.name) return;
    onRenameProject(id, name);
  }, [onRenameProject, projects, renameDraft, renameId]);

  // Resolve a pointer position to the gap it falls into, using the list's own
  // untransformed rows. Returns 0..rows.length: 0 means "above the first row",
  // rows.length means "below the last row".
  const dropSlot = useCallback((clientY: number) => {
    const list = listRef.current;
    if (!list) return 0;
    const rows = [...list.querySelectorAll<HTMLElement>('[data-screen-row]')];
    // `offsetTop` is the static layout position, unaffected by the drag needle's
    // transform, and is measured from the row's offsetParent. Anchor it to that
    // parent's viewport position so the maths does not assume which element is
    // positioned.
    const boxes = rows.map((row) => {
      const parent = row.offsetParent as HTMLElement | null;
      const parentTop = parent ? parent.getBoundingClientRect().top : 0;
      return { top: parentTop + row.offsetTop, height: row.offsetHeight };
    });
    return gapAtPoint(boxes, clientY);
  }, []);

  // Committing the gesture lives on `window`, not on the row. Reordering remounts
  // the rows (the list is rendered in the new order), which costs the dragged row
  // its pointer capture mid-gesture — an onPointerUp bound to that row would then
  // never fire and the drop would be silently lost.
  useEffect(() => {
    const onMove = (event: globalThis.PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      const offsetY = event.clientY - state.startY;
      if (!state.active) {
        // Wait for the threshold so a plain click still selects.
        if (Math.abs(offsetY) < state.threshold) return;
        state.active = true;
        onScreenSelect(state.id, { additive: false });
      }
      const to = dropSlot(event.clientY);
      state.slot = to;
      setDrag({ ids: state.ids, fromIndex: state.from[0] ?? 0, toIndex: to, offsetY });
    };
    const onUp = () => {
      const state = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!state) return;
      if (!state.active) {
        // No drag happened: behave exactly like the old click handler.
        if (state.selected && state.soleSelected) onScreenSelect(null);
        else onScreenSelect(state.id, { additive: false });
        setPreview(null);
        return;
      }
      // Hold the reordered list until the server echoes it back, so the rows do
      // not flash back into the old order on release.
      const next = moveEntries(state.order, state.from, state.slot);
      if (!next) { setPreview(null); return; }
      setPreview(next);
      onReorderScreens(state.projectId, next);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [cancel, dropSlot, onReorderScreens, onScreenSelect, setPreview]);

  return <aside className={collapsed ? 'project-sidebar collapsed' : 'project-sidebar'} aria-label="Projects">
    <div className="sidebar-head">
      {/* The title doubles as the collapse toggle, so the control sits exactly
          where the user is already looking. */}
      <button
        className="sidebar-toggle"
        type="button"
        onClick={() => onCollapsedChange(!collapsed)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Hiện danh sách màn hình' : 'Ẩn danh sách màn hình'}
        title={collapsed ? 'Hiện danh sách (Ctrl/Cmd+B)' : 'Ẩn danh sách (Ctrl/Cmd+B)'}
      ><span className="toggle-icon" aria-hidden="true">{collapsed ? <IconChevronRight size={15} /> : <IconChevronLeft size={15} />}</span></button>
      {!collapsed && <h1>Local Design Canvas</h1>}
      {collapsed && <button className="sidebar-toggle" type="button" onClick={() => onCollapsedChange(false)} aria-label="Hiện danh sách màn hình" title="Hiện danh sách (Ctrl/Cmd+B)"><span className="toggle-icon" aria-hidden="true"><IconMenu size={15} /></span></button>}
    </div>

    {projects.map((item) => <section key={item.id}>
      {renameId === item.id
        ? <input
          ref={renameInputRef}
          className="project-rename"
          value={renameDraft}
          aria-label="Tên project"
          onChange={(event) => setRenameDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
            // Escape abandons the edit and leaves the stored name untouched.
            if (event.key === 'Escape') { event.preventDefault(); setRenameId(null); }
          }}
        />
        : <button
          className={item.id === selectedProjectId ? 'project-button selected' : 'project-button'}
          onClick={() => onProjectSelect(item.id)}
          // Double-click to rename keeps the single-click select behaviour intact.
          onDoubleClick={() => startRename(item)}
          title={`${item.name} — nhấp đôi để đổi tên`}
        >{item.name}</button>}
      {item.id === selectedProjectId && !collapsed && <div className="screen-list" ref={listRef}>
        {order.map((screenId, index) => {
          const screen = item.screens.find((candidate) => candidate.id === screenId);
          if (!screen) return null;
          const selected = selectedScreenIds.includes(screen.id);
          const dragging = drag?.ids.includes(screen.id) ?? false;
          return <div
            key={screen.id}
            data-screen-row={screen.id}
            className={['screen-row', selected ? 'selected' : '', dragging ? 'dragging' : '', drag && !dragging && drag.toIndex === index ? 'drop-before' : '', drag && !dragging && drag.toIndex === order.length && index === order.length - 1 ? 'drop-after' : ''].filter(Boolean).join(' ')}
            style={dragging ? { transform: `translateY(${drag?.offsetY ?? 0}px)` } : undefined}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const additive = event.shiftKey || event.metaKey || event.ctrlKey;
              // Modifier-clicks only extend the selection; they never reorder.
              if (additive) {
                onScreenSelect(screen.id, { additive: true });
                return;
              }
              const soleSelected = selectedScreenIds.length === 1 && selectedScreenIds[0] === screen.id;
              // Dragging any row of a multi-selection moves the whole selection.
              const ids = selectedScreenIds.includes(screen.id) && selectedScreenIds.length > 1
                ? order.filter((id) => selectedScreenIds.includes(id))
                : [screen.id];
              // Freeze the list as it looks right now. The rows are re-rendered in
              // the new order during the gesture, so recomputing these from state
              // later would drift.
              dragRef.current = {
                id: screen.id,
                projectId: item.id,
                ids,
                order: [...order],
                from: ids.map((id) => order.indexOf(id)),
                startY: event.clientY,
                threshold: DRAG_THRESHOLD,
                slot: index,
                active: false,
                selected,
                soleSelected,
              };
            }}
          >
            <button
              className={selected ? 'screen-button selected' : 'screen-button'}
              type="button"
              // The row owns the pointer gestures, so the inner button must not
              // swallow them; selection is driven by the row handlers above.
              // Keyboard activation has no pointer gesture, so handle it here.
              onClick={(event) => { if (event.detail === 0) onScreenSelect(screen.id, { additive: false }); }}
            >{screen.name}</button>
            <span className="screen-row-handle" aria-hidden="true"><IconLayers size={12} /></span>
          </div>;
        })}
      </div>}
    </section>)}
  </aside>;
}
