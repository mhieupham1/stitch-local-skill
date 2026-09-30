import { useRef, type PointerEvent } from 'react';
import type { PrototypeView } from '../../../../core/src/schema.js';
import { IconTrash } from '../../icons.js';

export const PROTOTYPE_CARD_WIDTH = 320;
export const PROTOTYPE_CARD_HEIGHT = 224;

type Props = {
  projectId: string;
  prototype: PrototypeView;
  x: number;
  y: number;
  zoom: number;
  layerIndex: number;
  onDraft: (id: string, x: number, y: number) => void;
  onPersist: (id: string, x: number, y: number) => void;
  onRegeneratePrompt: (prototype: PrototypeView) => void;
  onCopyId: (id: string) => void;
  onDelete: (prototype: PrototypeView) => void;
};

export function PrototypeCard({ projectId, prototype, x, y, zoom, layerIndex, onDraft, onPersist, onRegeneratePrompt, onCopyId, onDelete }: Props) {
  const drag = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const position = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current) return null;
    return {
      x: Math.round(drag.current.x + (event.clientX - drag.current.clientX) / zoom),
      y: Math.round(drag.current.y + (event.clientY - drag.current.clientY) / zoom),
    };
  };
  const playerUrl = `/?prototypeProject=${encodeURIComponent(projectId)}&prototypeId=${encodeURIComponent(prototype.id)}`;
  return <article className="prototype-card" data-testid={`prototype-${prototype.id}`} data-prototype-id={prototype.id} style={{ left: x, top: y, width: PROTOTYPE_CARD_WIDTH, height: PROTOTYPE_CARD_HEIGHT, zIndex: layerIndex }} onPointerDown={(event) => {
      if (event.button !== 0) return;
      if ((event.target as Element).closest('a, button')) return;
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { clientX: event.clientX, clientY: event.clientY, x, y };
    }} onPointerMove={(event) => {
      const next = position(event);
      if (next) onDraft(prototype.id, next.x, next.y);
    }} onPointerUp={(event) => {
      const next = position(event);
      const origin = drag.current;
      drag.current = null;
      if (next && origin && (next.x !== origin.x || next.y !== origin.y)) onPersist(prototype.id, next.x, next.y);
    }} onPointerCancel={() => { drag.current = null; }}>
    <div className="prototype-card-bar" data-testid="prototype-drag-handle">
      <strong>{prototype.name}</strong>
      <div className="prototype-card-actions"><span>Prototype</span><button type="button" className="prototype-card-delete" aria-label="Xóa prototype" title={`Xóa prototype ${prototype.id}`} onClick={() => onDelete(prototype)}><IconTrash size={13} />Xóa</button></div>
    </div>
    <div className="prototype-card-content">
      <a className="prototype-card-play" href={playerUrl} target="_blank" rel="noopener noreferrer" aria-label={`Play ${prototype.name}`}><span aria-hidden="true">▶</span> Play</a>
      <button type="button" className="prototype-card-id" onClick={() => onCopyId(prototype.id)} title={`Sao chép ID ${prototype.id}`}><code>{prototype.id}</code></button>
    </div>
    {prototype.stale && <div className="prototype-card-stale"><span>Cần tạo lại</span><button type="button" onClick={() => onRegeneratePrompt(prototype)}>Copy prompt tạo lại</button></div>}
  </article>;
}
