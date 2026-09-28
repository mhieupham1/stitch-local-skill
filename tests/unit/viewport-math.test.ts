import { describe, expect, it } from 'vitest';
import { canvasToScreen, isDragBand, rectFromPoints, rectsOverlap, screenToCanvas } from '../../packages/canvas/src/features/canvas/viewport-math.js';

describe('viewport math', () => {
  it.each([
    [{ x: 300, y: 180 }, { x: 100, y: 80, zoom: 2 }, { x: 100, y: 50 }],
    [{ x: 300, y: 180 }, { x: 100, y: 80, zoom: 1 }, { x: 200, y: 100 }],
    [{ x: 300, y: 180 }, { x: 100, y: 80, zoom: 0.25 }, { x: 800, y: 400 }],
  ])('chuyển tọa độ screen sang canvas tại zoom %s', (point, viewport, expected) => {
    expect(screenToCanvas(point, viewport)).toEqual(expected);
  });

  it('đảo ngược chuyển đổi tọa độ', () => {
    const viewport = { x: -80, y: 120, zoom: 0.5 };
    expect(canvasToScreen(screenToCanvas({ x: 240, y: 160 }, viewport), viewport)).toEqual({ x: 240, y: 160 });
  });

  it('chuẩn hoá vùng kéo khi kéo ngược chiều', () => {
    expect(rectFromPoints({ x: 300, y: 220 }, { x: 100, y: 40 })).toEqual({ x: 100, y: 40, width: 200, height: 180 });
    expect(rectFromPoints({ x: 100, y: 40 }, { x: 300, y: 220 })).toEqual({ x: 100, y: 40, width: 200, height: 180 });
  });

  it('chọn màn hình khi vùng kéo chạm vào khung', () => {
    const screen = { x: 100, y: 100, width: 200, height: 200 };
    // Partial overlap still counts so a swipe across a frame selects it.
    expect(rectsOverlap(rectFromPoints({ x: 0, y: 0 }, { x: 150, y: 150 }), screen)).toBe(true);
    expect(rectsOverlap(rectFromPoints({ x: 0, y: 0 }, { x: 260, y: 260 }), screen)).toBe(true);
    expect(rectsOverlap(rectFromPoints({ x: 0, y: 0 }, { x: 90, y: 90 }), screen)).toBe(false);
    // Touching edges is not an overlap.
    expect(rectsOverlap(rectFromPoints({ x: 0, y: 0 }, { x: 100, y: 100 }), screen)).toBe(false);
  });

  it('phân biệt click với kéo để không xoá nhầm selection', () => {
    expect(isDragBand(rectFromPoints({ x: 10, y: 10 }, { x: 12, y: 13 }))).toBe(false);
    expect(isDragBand(rectFromPoints({ x: 10, y: 10 }, { x: 10, y: 60 }))).toBe(true);
    expect(isDragBand(rectFromPoints({ x: 10, y: 10 }, { x: 70, y: 10 }))).toBe(true);
  });
});
