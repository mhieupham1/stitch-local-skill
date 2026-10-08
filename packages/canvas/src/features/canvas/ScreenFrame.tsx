import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Screen, ScreenLayoutPatch, SelectionContext } from '../../../../core/src/schema.js';
import { SelectionOverlay } from '../selection/SelectionOverlay.js';

export const TITLE_BAR_HEIGHT = 32;
const MAX_CONTENT_HEIGHT = 16384;

type DragOrigin = { id: string; x: number; y: number };

type Props = {
  projectId: string; screen: Screen; screens: Screen[]; selectedScreenIds: string[]; previewUrl: string; revision: number; zoom: number; selected: boolean;
  // Array position of this screen: the first entry paints at the back, so the
  // index doubles as the persisted layer order.
  layerIndex: number;
  bridgeNonce: string | null; selection: SelectionContext | null; selectionStale: boolean; editing: boolean; userEditing: boolean; editingMessage: string | null;
  onSelect: (additive: boolean) => void; onDraft: (patches: ScreenLayoutPatch[]) => void; onPersist: (patches: ScreenLayoutPatch[]) => void;
  onContentHeight: (screenId: string, height: number) => void;
};

export function ScreenFrame({ projectId, screen, screens, selectedScreenIds, previewUrl, revision, zoom, selected, layerIndex, bridgeNonce, selection, selectionStale, editing, userEditing, editingMessage, onSelect, onDraft, onPersist, onContentHeight }: Props) {
  const drag = useRef<{ x: number; y: number; moved: boolean; origins: DragOrigin[] } | null>(null);
  const resize = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const frameRef = useRef<HTMLElement>(null);
  const onContentHeightRef = useRef(onContentHeight);
  onContentHeightRef.current = onContentHeight;
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const viewportHeight = Math.max(screen.height, contentHeight ?? 0);
  const clampDimension = (value: number) => Math.min(4096, Math.max(240, Math.round(value)));
  const movePatches = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current) return null;
    const dx = (event.clientX - drag.current.x) / zoom;
    const dy = (event.clientY - drag.current.y) / zoom;
    if (dx || dy) drag.current.moved = true;
    return drag.current.origins.map((origin) => ({ id: origin.id, x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) }));
  };
  const sizePatch = (event: PointerEvent<HTMLDivElement>) => resize.current && ({
    id: screen.id,
    width: clampDimension(resize.current.width + (event.clientX - resize.current.x) / zoom),
    height: clampDimension(resize.current.height + (event.clientY - resize.current.y) / zoom),
  });

  const interactive = userEditing && bridgeNonce !== null;
  const selectActive = userEditing && selected && bridgeNonce !== null;
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

  return <article ref={frameRef} className={['screen-frame', selected ? 'selected' : '', editing ? 'editing' : ''].filter(Boolean).join(' ')} data-screen-id={screen.id} style={{ left: screen.x, top: screen.y, width: screen.width, height: viewportHeight + TITLE_BAR_HEIGHT, zIndex: layerIndex + 1, '--canvas-inverse-zoom': 1 / zoom } as CSSProperties} onPointerDown={(event) => {
    // The whole frame drags, like a prototype card, rather than only its title
    // bar: the body is the part users reach for. The preview iframe keeps
    // `pointer-events: none` unless editing, so a press on the body lands here.
    // Only the primary button moves a frame. Middle-click pans the canvas and
    // right-click opens the context menu; neither should disturb the selection.
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    // Controls inside the frame own their own clicks: the edit-lock overlay is
    // not draggable, and the resize handle runs its own gesture.
    if (target?.closest('.edit-lock, .resize-handle')) return;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    // Shift/Cmd+click only toggles selection — do not start a drag.
    if (additive) {
      event.stopPropagation();
      onSelect(true);
      return;
    }
    // A press on an already-selected frame keeps the group so the whole
    // selection moves together; otherwise this frame becomes the selection.
    if (!selectedScreenIds.includes(screen.id)) onSelect(false);
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const movingIds = selectedScreenIds.includes(screen.id) && selectedScreenIds.length > 0
      ? selectedScreenIds
      : [screen.id];
    const origins = movingIds.flatMap((id) => {
      const item = screens.find((candidate) => candidate.id === id);
      return item ? [{ id: item.id, x: item.x, y: item.y }] : [];
    });
    drag.current = { x: event.clientX, y: event.clientY, moved: false, origins: origins.length ? origins : [{ id: screen.id, x: screen.x, y: screen.y }] };
  }} onPointerMove={(event) => { const patches = movePatches(event); if (patches) onDraft(patches); }} onPointerUp={(event) => {
    const patches = movePatches(event);
    const moved = drag.current?.moved ?? false;
    drag.current = null;
    // A press without motion is a click: it selects, and the server is left alone.
    // Persisting a zero-delta patch on every click would write the layout for a
    // gesture the user never made, and every write bumps the revision other
    // clients and background refreshes race against.
    if (patches && moved) onPersist(patches);
  }} onPointerCancel={() => { drag.current = null; }}>
    <div className="screen-frame-bar" data-testid="drag-handle">
      <strong>{screen.name}</strong><span>{editing ? 'Đang chỉnh sửa' : `${screen.width} × ${viewportHeight}`}</span>
    </div>
    <iframe title={screen.name} src={src} sandbox="allow-scripts allow-same-origin" scrolling="no" referrerPolicy="no-referrer" style={{ pointerEvents: interactive && selected ? 'auto' : 'none' }} />
    {selected && userEditing && <SelectionOverlay selection={selection} stale={selectionStale} titleBarHeight={TITLE_BAR_HEIGHT} />}
    {editing && !userEditing && <div className="edit-lock" data-testid="edit-lock" aria-live="polite"><span className="edit-lock-badge">{editingMessage ?? 'Đang chỉnh sửa…'}</span><span className="edit-lock-hint">Tạm khóa tương tác</span></div>}
    {!editing && <div className="resize-handle" onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.stopPropagation(); onSelect(false); event.currentTarget.setPointerCapture(event.pointerId);
      resize.current = { x: event.clientX, y: event.clientY, width: screen.width, height: viewportHeight };
    }} onPointerMove={(event) => { const patch = sizePatch(event); if (patch) onDraft([patch]); }} onPointerUp={(event) => { const patch = sizePatch(event); resize.current = null; if (patch) onPersist([patch]); }} />}
  </article>;
}
