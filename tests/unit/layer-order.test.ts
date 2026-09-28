import { describe, expect, it } from 'vitest';
import { gapAtPoint, moveEntries } from '../../packages/canvas/src/features/projects/layer-order.js';

// The list is also the layer stack: index 0 paints at the back, the last entry
// paints on top. `slot` is the gap the entries are dropped into.
describe('xếp lại thứ tự layer', () => {
  const list = ['a', 'b', 'c', 'd'];

  it.each([
    // Drag a single row between gaps.
    [[3], 0, ['d', 'a', 'b', 'c']],
    [[0], 4, ['b', 'c', 'd', 'a']],
    [[1], 3, ['a', 'c', 'b', 'd']],
    [[3], 1, ['a', 'd', 'b', 'c']],
    // Dropping into the gap on either side of your own position is a no-op, so
    // a tiny wobble mid-click can never scramble the order.
    [[0], 1, ['a', 'b', 'c', 'd']],
    [[1], 1, ['a', 'b', 'c', 'd']],
    [[3], 3, ['a', 'b', 'c', 'd']],
    [[3], 4, ['a', 'b', 'c', 'd']],
    // A multi-row selection moves as one block.
    [[0, 1], 4, ['c', 'd', 'a', 'b']],
    [[2, 3], 0, ['c', 'd', 'a', 'b']],
    [[1, 2], 0, ['b', 'c', 'a', 'd']],
    [[0, 3], 2, ['b', 'a', 'd', 'c']],
  ])('chuyển %s tới khe %s', (from, slot, expected) => {
    expect(moveEntries(list, from, slot)).toEqual(expected);
  });

  it('giữ nguyên danh sách khi không có gì được kéo', () => {
    expect(moveEntries(list, [], 2)).toEqual(list);
  });

  it('không làm mất hay nhân đôi màn hình', () => {
    for (let slot = 0; slot <= list.length; slot += 1) {
      for (const from of [[0], [2], [0, 1], [1, 3]]) {
        const result = moveEntries(list, from, slot);
        expect(result).toHaveLength(list.length);
        expect([...result].sort()).toEqual([...list].sort());
      }
    }
  });

  it('không thay đổi danh sách gốc', () => {
    const original = [...list];
    moveEntries(list, [0], 4);
    expect(list).toEqual(original);
  });
});

describe('xác định khe theo vị trí con trỏ', () => {
  // Three 20px rows starting at y=100.
  const rows = [
    { top: 100, height: 20 },
    { top: 120, height: 20 },
    { top: 140, height: 20 },
  ];

  it.each([
    [95, 0],
    [109, 0],
    [110, 1],
    [129, 1],
    [130, 2],
    [149, 2],
    [150, 3],
    [400, 3],
  ])('con trỏ ở y=%s nằm tại khe %s', (pointerY, expected) => {
    expect(gapAtPoint(rows, pointerY)).toBe(expected);
  });

  it('trả về khe cuối khi danh sách rỗng', () => {
    expect(gapAtPoint([], 120)).toBe(0);
  });
});
