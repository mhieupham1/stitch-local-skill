import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Screen, ScreenLayoutPatch, SelectionContext } from '../../../../core/src/schema.js';
import { SelectionOverlay } from '../selection/SelectionOverlay.js';

export type CanvasMode = 'arrange' | 'interact' | 'select';
export const TITLE_BAR_HEIGHT = 32;
const MAX_CONTENT_HEIGHT = 16384;

type DragOrigin = { id: string; x: number; y: number };

type Props = {
  projectId: string; screen: Screen; screens: Screen[]; selectedScreenIds: string[]; previewUrl: string; revision: number; zoom: number; selected: boolean; mode: CanvasMode;
  // Array position of this screen: the first entry paints at the back, so the
  // index doubles as the persisted layer order.
  layerIndex: number;
  bridgeNonce: string | null; selection: SelectionContext | null; selectionStale: boolean; editing: boolean; userEditing: boolean; editingMessage: string | null;
  onSelect: (additive: boolean) => void; onDraft: (patches: ScreenLayoutPatch[]) => void; onPersist: (patches: ScreenLayoutPatch[]) => void;
  onContentHeight: (screenId: string, height: number) => void;
};

export function ScreenFrame({ projectId, screen, screens, selectedScreenIds, previewUrl, revision, zoom, selected, mode, layerIndex, bridgeNonce, selection, selectionStale, editing, userEditing, editingMessage, onSelect, onDraft, onPersist, onContentHeight }: Props) {
  const drag = useRef<{ x: number; y: number; origins: DragOrigin[] } | null>(null);
  const resize = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const frameRef = useRef<HTMLElement>(null);
  const onContentHeightRef = useRef(onContentHeight);
  onContentHeightRef.current = onContentHeight;
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const viewportHeight = Math.max(screen.height, contentHeight ?? 0);
  const clampDimension = (value: number) => Math.min(4096, Math.max(240, Math.round(value)));
  const movePatches = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return null;
    const dx = (event.clientX - drag.current.x) / zoom;
    const dy = (event.clientY - drag.current.y) / zoom;
    return drag.current.origins.map((origin) => ({ id: origin.id, x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) }));
  };
  const sizePatch = (event: PointerEvent<HTMLDivElement>) => resize.current && ({
    id: screen.id,
    width: clampDimension(resize.current.width + (event.clientX - resize.current.x) / zoom),
    height: clampDimension(resize.current.height + (event.clientY - resize.current.y) / zoom),
  });

  const interactive = (mode !== 'arrange' && !editing) || userEditing;
  const selectActive = (mode === 'select' || userEditing) && selected && bridgeNonce !== null && (!editing || userEditing);
  const params = new URLSearchParams({ revision: String(revision), screen: screen.id, figma: '1' });
  if (selectActive && bridgeNonce) params.set('bridge', bridgeNonce);
  const src = `${previewUrl}/projects/${encodeURIComponent(projectId)}/${screen.entry}?${params}`;

  useEffect(() => { setContentHeight(null); }, [revision, screen.id]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const iframe = frameRef.current?.querySelector('iframe');
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as { source?: string; kind?: string; screenId?: string; height?: number };
      if (data.source !== 'local-design-canvas' || data.kind !== 'content-size' || data.screenId !== screen.id) return;
      const height = data.height;
      if (typeof height !== 'number' || !Number.isFinite(height) || height < 1 || height > MAX_CONTENT_HEIGHT) return;
      setContentHeight((current) => current === height ? current : height);
      onContentHeightRef.current(screen.id, height);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [screen.id]);

  return <article ref={frameRef} className={['screen-frame', selected ? 'selected' : '', editing ? 'editing' : ''].filter(Boolean).join(' ')} data-screen-id={screen.id} style={{ left: screen.x, top: screen.y, width: screen.width, height: viewportHeight + TITLE_BAR_HEIGHT, zIndex: layerIndex + 1 }} onPointerDown={(event) => {
    // Only the primary button selects. Middle-click pans the canvas and
    // right-click opens the context menu; neither should disturb the selection.
    if (event.button !== 0) return;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    // Keep an existing multi-selection when clicking a selected frame without modifiers.
    if (!additive && selectedScreenIds.includes(screen.id)) return;
    onSelect(additive);
  }}>
    <div className="screen-frame-bar" data-testid="drag-handle" onPointerDown={(event) => {
      if (interactive || editing) return;
      // Dragging a frame is a primary-button gesture. Letting middle-click through
      // means it still pans the canvas, which is what users expect everywhere.
      if (event.button !== 0) return;
      event.stopPropagation();
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      // Shift/Cmd+click only toggles selection — do not start a drag.
      if (additive) {
        onSelect(true);
        return;
      }
      // Clicking an already-selected screen keeps the group; otherwise select just this one.
      if (!selectedScreenIds.includes(screen.id)) onSelect(false);
      event.currentTarget.setPointerCapture(event.pointerId);
      const movingIds = selectedScreenIds.includes(screen.id) && selectedScreenIds.length > 0
        ? selectedScreenIds
        : [screen.id];
      const origins = movingIds.flatMap((id) => {
        const item = screens.find((candidate) => candidate.id === id);
        return item ? [{ id: item.id, x: item.x, y: item.y }] : [];
      });
      drag.current = { x: event.clientX, y: event.clientY, origins: origins.length ? origins : [{ id: screen.id, x: screen.x, y: screen.y }] };
    }} onPointerMove={(event) => { const patches = movePatches(event); if (patches) onDraft(patches); }} onPointerUp={(event) => { const patches = movePatches(event); drag.current = null; if (patches) onPersist(patches); }}>
      <strong>{screen.name}</strong><span>{editing ? 'Đang chỉnh sửa' : `${screen.width} × ${viewportHeight}`}</span>
    </div>
    <iframe title={screen.name} src={src} sandbox="allow-scripts allow-same-origin" scrolling="no" referrerPolicy="no-referrer" style={{ pointerEvents: interactive && selected ? 'auto' : 'none' }} />
    {selected && (!editing || userEditing) && <SelectionOverlay selection={selection} stale={selectionStale} titleBarHeight={TITLE_BAR_HEIGHT} />}
    {editing && !userEditing && <div className="edit-lock" data-testid="edit-lock" aria-live="polite"><span className="edit-lock-badge">{editingMessage ?? 'Đang chỉnh sửa…'}</span><span className="edit-lock-hint">Tạm khóa tương tác</span></div>}
    {mode === 'arrange' && !editing && <div className="resize-handle" onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.stopPropagation(); onSelect(false); event.currentTarget.setPointerCapture(event.pointerId);
      resize.current = { x: event.clientX, y: event.clientY, width: screen.width, height: viewportHeight };
    }} onPointerMove={(event) => { const patch = sizePatch(event); if (patch) onDraft([patch]); }} onPointerUp={(event) => { const patch = sizePatch(event); resize.current = null; if (patch) onPersist([patch]); }} />}
  </article>;
}
