import { useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import type { PrototypeView, Screen, ScreenLayoutPatch, SelectionContext } from '../../../../core/src/schema.js';
import { clampZoom, isDragBand, rectFromPoints, rectsOverlap, screenToCanvas, type Point, type Rect, type Viewport } from './viewport-math.js';
import { ScreenFrame, TITLE_BAR_HEIGHT } from './ScreenFrame.js';
import { IconMaximize, IconMinus, IconPlus } from '../../icons.js';
import { PrototypeCard, PROTOTYPE_CARD_HEIGHT, PROTOTYPE_CARD_WIDTH } from '../prototypes/PrototypeCard.js';

type Props = {
  projectId: string; screens: Screen[]; prototypes: PrototypeView[]; previewUrl: string; revision: number; screenRevisions: Record<string, number>; viewport: Viewport;
  selectedScreenIds: string[]; bridgeNonce: string | null; selection: SelectionContext | null; selectionStale: boolean;
  editingScreenId: string | null; userEditingScreenId: string | null; editingMessage: string | null;
  onViewport: (viewport: Viewport) => void;
  onSelect: (screenId: string | null, options?: { additive?: boolean }) => void;
  // `ids` replaces the whole selection; used by the marquee band.
  onSelectMany: (ids: string[]) => void;
  onDraft: (patches: ScreenLayoutPatch[]) => void;
  onPersist: (patches: ScreenLayoutPatch[]) => void;
  onPrototypeDraft: (id: string, x: number, y: number) => void;
  onPrototypePersist: (id: string, x: number, y: number) => void;
  onRegeneratePrompt: (prototype: PrototypeView) => void;
  onCopyPrototypeId: (id: string) => void;
  onDeletePrototype: (prototype: PrototypeView) => void;
};

export function CanvasViewport(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; viewport: Viewport } | null>(null);
  const marquee = useRef<{ start: Point; additive: boolean; base: string[] } | null>(null);
  const [contentHeights, setContentHeights] = useState<Record<string, number>>({});
  const [band, setBand] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const frameHeight = (screen: Screen) => Math.max(screen.height, contentHeights[screen.id] ?? 0) + TITLE_BAR_HEIGHT;
  const defaultPrototypeX = Math.max(0, ...props.screens.map((screen) => screen.x + screen.width)) + 80;
  const defaultPrototypeY = Math.min(0, ...props.screens.map((screen) => screen.y));
  const prototypePosition = (prototype: PrototypeView, index: number) => ({
    x: prototype.x ?? defaultPrototypeX,
    y: prototype.y ?? defaultPrototypeY + index * (PROTOTYPE_CARD_HEIGHT + 32),
  });
  const reportContentHeight = (screenId: string, height: number) => {
    setContentHeights((current) => current[screenId] === height ? current : { ...current, [screenId]: height });
  };
  const updateZoom = (next: number) => {
    const rect = ref.current?.getBoundingClientRect(); const zoom = clampZoom(next);
    if (!rect) { props.onViewport({ ...props.viewport, zoom }); return; }
    const pivotX = rect.width / 2; const pivotY = rect.height / 2;
    props.onViewport({ zoom, x: pivotX - ((pivotX - props.viewport.x) / props.viewport.zoom) * zoom, y: pivotY - ((pivotY - props.viewport.y) / props.viewport.zoom) * zoom });
  };
  const fitAll = () => {
    const rect = ref.current?.getBoundingClientRect(); if (!rect || (!props.screens.length && !props.prototypes.length)) return;
    const bounds = [
      ...props.screens.map((screen) => ({ x: screen.x, y: screen.y, width: screen.width, height: frameHeight(screen) })),
      ...props.prototypes.map((prototype, index) => ({ ...prototypePosition(prototype, index), width: PROTOTYPE_CARD_WIDTH, height: PROTOTYPE_CARD_HEIGHT })),
    ];
    const minX = Math.min(...bounds.map((item) => item.x)), minY = Math.min(...bounds.map((item) => item.y));
    const maxX = Math.max(...bounds.map((item) => item.x + item.width)), maxY = Math.max(...bounds.map((item) => item.y + item.height));
    const zoom = clampZoom(Math.min((rect.width - 96) / (maxX - minX), (rect.height - 96) / (maxY - minY)));
    props.onViewport({ zoom, x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom });
  };
  // The world's translate is relative to .canvas-viewport, but pointer events
  // report coordinates relative to the page. Without this offset the band draws
  // shifted by wherever the canvas sits on screen (sidebar width + header).
  const toViewportPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return { x: event.clientX, y: event.clientY };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  // Band coordinates live in canvas space; render them in viewport space so the
  // outline tracks the pointer at any zoom level.
  const bandRect = (start: Point, end: Point) => {
    const rect = rectFromPoints(start, end);
    return { left: rect.x * props.viewport.zoom + props.viewport.x, top: rect.y * props.viewport.zoom + props.viewport.y, width: rect.width * props.viewport.zoom, height: rect.height * props.viewport.zoom };
  };
  const startPan = (event: PointerEvent<HTMLElement>) => {
    // Middle-click always pans. Shift+drag on empty canvas pans; Shift+click on a
    // frame is handled by ScreenFrame for multi-select and never reaches here.
    if (event.button === 1 || (event.shiftKey && event.button === 0)) {
      const target = event.target as HTMLElement | null;
      if (event.button === 0 && target?.closest('.screen-frame, .prototype-card')) return;
      // Middle-button panning must work over frames too, so claim the pointer from
      // the frame that the press landed on before any drag handler can react.
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      pan.current = { x: event.clientX, y: event.clientY, viewport: props.viewport };
      return;
    }
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('.screen-frame, .prototype-card') || target.closest('.canvas-toolbar')) return;
    const additive = event.metaKey || event.ctrlKey;
    event.currentTarget.setPointerCapture(event.pointerId);
    // A drag on empty canvas sweeps a selection band; without a modifier it
    // replaces the selection, with Cmd/Ctrl it extends what is already selected.
    marquee.current = { start: screenToCanvas(toViewportPoint(event), props.viewport), additive, base: props.selectedScreenIds };
    setBand(bandRect(marquee.current.start, marquee.current.start));
  };
  const movePointer = (event: PointerEvent<HTMLElement>) => {
    if (pan.current) { props.onViewport({ ...pan.current.viewport, x: pan.current.viewport.x + event.clientX - pan.current.x, y: pan.current.viewport.y + event.clientY - pan.current.y }); return; }
    if (!marquee.current) return;
    const cursor = screenToCanvas(toViewportPoint(event), props.viewport);
    setBand(bandRect(marquee.current.start, cursor));
  };
  const endPointer = (event: PointerEvent<HTMLElement>) => {
    pan.current = null;
    const active = marquee.current;
    marquee.current = null;
    setBand(null);
    if (!active) return;
    const end = screenToCanvas(toViewportPoint(event), props.viewport);
    const rect = rectFromPoints(active.start, end);
    // A click, not a drag: keep the existing click-to-clear behaviour.
    if (!isDragBand(rect)) { if (!active.additive) props.onSelect(null); return; }
    const grabbed = props.screens.filter((screen) => rectsOverlap(rect, { x: screen.x, y: screen.y, width: screen.width, height: frameHeight(screen) })).map((screen) => screen.id);
    const next = active.additive ? [...new Set([...active.base, ...grabbed])] : grabbed;
    if (next.length) props.onSelectMany(next);
  };
  const wheel = (event: WheelEvent<HTMLElement>) => { event.preventDefault(); if (event.ctrlKey || event.metaKey) updateZoom(props.viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1)); else props.onViewport({ ...props.viewport, x: props.viewport.x - event.deltaX, y: props.viewport.y - event.deltaY }); };
  return <main ref={ref} className="canvas-viewport" onWheel={wheel} onPointerDown={startPan} onPointerMove={movePointer} onPointerUp={endPointer}>
    <div className="canvas-toolbar">
      <button aria-label="Thu nhỏ" title="Thu nhỏ" onClick={() => updateZoom(props.viewport.zoom / 1.2)}><IconMinus size={14} /></button>
      <output>{Math.round(props.viewport.zoom * 100)}%</output>
      <button aria-label="Phóng to" title="Phóng to" onClick={() => updateZoom(props.viewport.zoom * 1.2)}><IconPlus size={14} /></button>
      <button className="toolbar-fit" title="Vừa khung hình" aria-label="Vừa khung hình" onClick={fitAll}><IconMaximize size={13} /></button>
    </div>
    {band && <div className="canvas-marquee" data-testid="selection-band" style={band} />}
    <div className="canvas-world" style={{ transform: `translate(${props.viewport.x}px, ${props.viewport.y}px) scale(${props.viewport.zoom})` }}>
      {props.screens.map((screen, index) => {
        const selected = props.selectedScreenIds.includes(screen.id);
        const primary = props.selectedScreenIds[props.selectedScreenIds.length - 1] === screen.id;
        const editing = screen.id === props.editingScreenId;
        return <ScreenFrame key={screen.id} projectId={props.projectId} screen={screen} screens={props.screens} selectedScreenIds={props.selectedScreenIds} previewUrl={props.previewUrl} revision={props.screenRevisions[screen.id] ?? props.revision} zoom={props.viewport.zoom} selected={selected} layerIndex={index} bridgeNonce={primary ? props.bridgeNonce : null} selection={primary ? props.selection : null} selectionStale={props.selectionStale} editing={editing || props.userEditingScreenId === screen.id} userEditing={props.userEditingScreenId === screen.id} editingMessage={editing ? props.editingMessage : null} onSelect={(additive) => props.onSelect(screen.id, { additive })} onDraft={props.onDraft} onPersist={props.onPersist} onContentHeight={reportContentHeight} />;
      })}
      {props.prototypes.map((prototype, index) => {
        const point = prototypePosition(prototype, index);
        return <PrototypeCard key={prototype.id} projectId={props.projectId} prototype={prototype} x={point.x} y={point.y} zoom={props.viewport.zoom} layerIndex={props.screens.length + index + 1} onDraft={props.onPrototypeDraft} onPersist={props.onPrototypePersist} onRegeneratePrompt={props.onRegeneratePrompt} onCopyId={props.onCopyPrototypeId} onDelete={props.onDeletePrototype} />;
      })}
    </div>
  </main>;
}
