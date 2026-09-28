// Reordering maths for the sidebar layer list. Kept free of React so the slot
// arithmetic — which is easy to get subtly wrong when dragging up versus down —
// can be unit tested directly.

// Move the entries at `from` so they land in gap `slot`.
//
// `slot` is a gap in the list that still contains the dragged entries: 0 means
// "above the first row", `list.length` means "below the last row". Using a gap
// rather than a row index keeps the result independent of which direction the
// entries travel, which is what makes dragging up and dragging down behave the
// same way.
export function moveEntries(list: string[], from: number[], slot: number): string[] {
  const moving = from.map((index) => list[index]).filter((value): value is string => value !== undefined);
  if (!moving.length) return [...list];
  const rest = list.filter((_, index) => !from.includes(index));
  // Every dragged entry sitting before the gap disappears when the dragged
  // entries are lifted out, so the gap shifts left by that many positions.
  const target = Math.max(0, Math.min(rest.length, slot - from.filter((index) => index < slot).length));
  return [...rest.slice(0, target), ...moving, ...rest.slice(target)];
}

// Convert a pointer position into the gap it falls into, given each row's
// on-screen box. Rows are passed in list order.
export function gapAtPoint(rows: { top: number; height: number }[], pointerY: number): number {
  for (let index = 0; index < rows.length; index += 1) {
    if (pointerY < rows[index].top + rows[index].height / 2) return index;
  }
  return rows.length;
}
