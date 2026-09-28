import type { SelectionContext } from '../../../../core/src/schema.js';

type Props = { selection: SelectionContext | null; stale: boolean; titleBarHeight: number };

/**
 * Draws a highlight over the selected element and a small label. Bounds are in the
 * iframe's own CSS pixels (unzoomed); the parent `.canvas-world` transform scales
 * the overlay together with the frame, so we position it inside the frame without
 * re-applying zoom. The title bar offset accounts for the frame chrome above the
 * preview iframe.
 */
export function SelectionOverlay({ selection, stale, titleBarHeight }: Props) {
  if (!selection) return null;
  const { bounds } = selection;
  return (
    <div
      className={stale ? 'selection-overlay stale' : 'selection-overlay'}
      data-testid="selection-overlay"
      style={{ left: bounds.x, top: titleBarHeight + bounds.y, width: bounds.width, height: bounds.height }}
    >
      <span className="selection-tag">
        {selection.elementId ?? selection.selector}
        {stale ? ' · stale' : ''}
      </span>
    </div>
  );
}
