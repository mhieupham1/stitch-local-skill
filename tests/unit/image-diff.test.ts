import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { comparePngs } from '../../packages/server/src/image-diff.js';
import { CanvasError } from '../../packages/core/src/schema.js';

function solid(width: number, height: number, color: [number, number, number]): PNG {
  const image = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    image.data[i * 4] = color[0];
    image.data[i * 4 + 1] = color[1];
    image.data[i * 4 + 2] = color[2];
    image.data[i * 4 + 3] = 255;
  }
  return image;
}

function paint(image: PNG, x: number, y: number, color: [number, number, number]): void {
  const i = (y * image.width + x) * 4;
  image.data[i] = color[0];
  image.data[i + 1] = color[1];
  image.data[i + 2] = color[2];
}

describe('comparePngs', () => {
  it('hai ảnh giống hệt: không đổi, không vùng, overlay vẫn đúng cỡ', () => {
    const a = solid(320, 200, [10, 20, 30]);
    const b = solid(320, 200, [10, 20, 30]);
    const result = comparePngs(a, b);
    expect(result.identical).toBe(true);
    expect(result.changedPixels).toBe(0);
    expect(result.regions).toEqual([]);
    expect(result.overlay.width).toBe(320);
    expect(result.overlay.height).toBe(200);
  });

  it('đếm pixel đổi và khoanh đúng vùng đổi thành bbox kế cạnh bucket', () => {
    const a = solid(400, 300, [255, 255, 255]);
    const b = solid(400, 300, [255, 255, 255]);
    // Block 1: x 10..50, y 20..60 → bucket col 0 (0..63), row 0 (0..63) → region 0..63 × 0..63.
    for (let y = 20; y < 60; y += 1) for (let x = 10; x < 50; x += 1) paint(b, x, y, [0, 0, 0]);
    // Block 2: x 200..300, y 150..200 → bucket cols 3..4, rows 2..3 → region 192..319 × 128..255.
    for (let y = 150; y < 200; y += 1) for (let x = 200; x < 300; x += 1) paint(b, x, y, [0, 0, 0]);

    const result = comparePngs(a, b);
    expect(result.changedPixels).toBe(40 * 40 + 100 * 50);
    expect(result.identical).toBe(false);
    expect(result.regions).toHaveLength(2);
    // Largest area first.
    expect(result.regions[0]).toEqual({ x: 192, y: 128, width: 128, height: 128 });
    expect(result.regions[1]).toEqual({ x: 0, y: 0, width: 64, height: 64 });
  });

  it('hai ô rời xa nhau cho hai vùng riêng; ô sát nhau nhập một vùng', () => {
    const a = solid(640, 200, [250, 250, 250]);
    const b = solid(640, 200, [250, 250, 250]);
    for (let y = 10; y < 30; y += 1) for (let x = 10; x < 30; x += 1) paint(b, x, y, [0, 0, 0]);
    for (let y = 10; y < 30; y += 1) for (let x = 400; x < 420; x += 1) paint(b, x, y, [0, 0, 0]);
    expect(comparePngs(a, b).regions).toHaveLength(2);

    const c = solid(640, 200, [250, 250, 250]);
    // 60px apart horizontally: bucket 0 (0..63) and bucket 1 (64..127) touch.
    for (let y = 10; y < 30; y += 1) for (let x = 100; x < 160; x += 1) paint(c, x, y, [0, 0, 0]);
    expect(comparePngs(a, c).regions).toHaveLength(1);
  });

  it('từ chối ảnh khác kích thước bằng DIFF_SIZE_MISMATCH 409', () => {
    const a = solid(100, 100, [0, 0, 0]);
    const b = solid(100, 99, [0, 0, 0]);
    try {
      comparePngs(a, b);
      expect.unreachable('phải ném DIFF_SIZE_MISMATCH');
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasError);
      expect((error as CanvasError).code).toBe('DIFF_SIZE_MISMATCH');
      expect((error as CanvasError).statusCode).toBe(409);
    }
  });

  it('threshold thấp hơn bắt đổi tinh vi hơn, threshold cao bỏ qua nó', () => {
    const a = solid(200, 100, [128, 128, 128]);
    const b = solid(200, 100, [128, 128, 128]);
    for (let y = 0; y < 100; y += 1) for (let x = 0; x < 200; x += 1) paint(b, x, y, [131, 131, 131]);
    // Δ3/255 ≈ nhỏ: chỉ thành "đổi" khi threshold đủ nhạy.
    expect(comparePngs(a, b, 0.5).changedPixels).toBe(0);
    expect(comparePngs(a, b, 0.01).changedPixels).toBeGreaterThan(0);
  });
});
