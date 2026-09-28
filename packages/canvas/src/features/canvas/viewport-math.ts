export type Point = { x: number; y: number };
export type Viewport = { x: number; y: number; zoom: number };
export type Rect = { x: number; y: number; width: number; height: number };
export const screenToCanvas = (point: Point, viewport: Viewport): Point => ({ x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom });
export const canvasToScreen = (point: Point, viewport: Viewport): Point => ({ x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y });
export const clampZoom = (zoom: number): number => Math.max(0.1, Math.min(2, zoom));
// A drag can run right-to-left or bottom-to-top, so normalize before comparing.
export const rectFromPoints = (start: Point, end: Point): Rect => ({
  x: Math.min(start.x, end.x),
  y: Math.min(start.y, end.y),
  width: Math.abs(end.x - start.x),
  height: Math.abs(end.y - start.y),
});
// A screen counts as grabbed when its rect overlaps the drag band. Overlap
// instead of containment keeps a partial swipe over a frame selectable.
export const rectsOverlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
// Ignore sub-pixel pointer jitter so a plain click on empty canvas is not a drag.
export const isDragBand = (rect: Rect, threshold = 4): boolean => rect.width >= threshold || rect.height >= threshold;
export const rectContainsPoint = (rect: Rect, point: Point): boolean => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
