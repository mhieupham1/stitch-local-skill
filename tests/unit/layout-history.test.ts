import { describe, expect, it } from 'vitest';
import { LayoutHistory } from '../../packages/canvas/src/features/canvas/layout-history.js';

// The stack holds opaque restore closures, so the tests use a value in a box to
// stand in for a screen's layout: `undo`/`redo` write the recorded value back.
const box = (initial: string) => {
  const state = { value: initial };
  return {
    state,
    entry: (before: string, after: string) => ({
      undo: () => { state.value = before; },
      redo: () => { state.value = after; },
    }),
  };
};

describe('undo/redo layout', () => {
  it('bắt đầu với cả hai hướng đều rỗng', () => {
    const history = new LayoutHistory();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('undo trả về trạng thái trước cử chỉ, redo đưa tới trạng thái sau', () => {
    const history = new LayoutHistory();
    const { state, entry } = box('gốc');
    history.record(entry('gốc', 'sau khi kéo'));

    expect(state.value).toBe('gốc');
    expect(history.undo()).toBe(true);
    expect(state.value).toBe('gốc');
    expect(history.redo()).toBe(true);
    expect(state.value).toBe('sau khi kéo');
  });

  it('đi lùi qua nhiều cử chỉ theo thứ tự ngược', () => {
    const history = new LayoutHistory();
    const { state, entry } = box('A');
    history.record(entry('A', 'B'));
    history.record(entry('B', 'C'));

    history.undo();
    expect(state.value).toBe('B');
    history.undo();
    expect(state.value).toBe('A');
    expect(history.canUndo).toBe(false);
  });

  it('ghi cử chỉ mới thì bỏ nhánh redo cũ', () => {
    const history = new LayoutHistory();
    const { state, entry } = box('A');
    history.record(entry('A', 'B'));
    history.undo();
    expect(history.canRedo).toBe(true);

    history.record(entry('A', 'C'));
    expect(history.canRedo).toBe(false);
    history.redo();
    expect(state.value).toBe('A');
  });

  it('undo và redo khi rỗng là vô hại', () => {
    const history = new LayoutHistory();
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(false);
  });

  it('giới hạn số cử chỉ nhớ được, bỏ cái cũ nhất', () => {
    const history = new LayoutHistory();
    const { state, entry } = box('0');
    for (let step = 0; step < 60; step += 1) history.record(entry(String(step), String(step + 1)));

    let undone = 0;
    while (history.undo()) undone += 1;
    // Fifty entries are kept, so fifty undos walk back to the newest entry's
    // start value; the earliest ten gestures have been dropped.
    expect(undone).toBe(50);
    expect(state.value).toBe('10');
  });

  it('clear xóa cả hai hướng', () => {
    const history = new LayoutHistory();
    const { entry } = box('A');
    history.record(entry('A', 'B'));
    history.undo();

    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
