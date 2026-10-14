import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { getProjectRoot } from '../../core/src/project-store.js';
import { isInside, resolveProjectDirectory, resolveProjectFile } from '../../core/src/paths.js';
import { CanvasError, projectIdSchema } from '../../core/src/schema.js';
import { captureScreen } from './capture.js';

/**
 * Quantitative visual diff between two rendered screens.
 *
 * The agent loop is `screenshot → edit → screenshot`; before this module the
 * effect of an edit could only be judged by eye. Here two PNGs are compared
 * pixel by pixel and the result is machine-checkable: the number and percent
 * of changed pixels plus the bounding boxes of the changed regions, so an
 * edit meant to touch only the header can be confirmed to have touched only
 * the header. A red-on-grey overlay PNG is written alongside the numbers for
 * the human (or model) to open.
 *
 * References accepted for either side:
 *  - a path to a PNG inside the project (relative to the project root, or an
 *    absolute path that stays inside it — the `imagePath` that `screenshot`
 *    returns works unchanged);
 *  - `live:<screen-id>`, which re-captures the current preview first. This is
 *    what closes the loop: keep the old capture path, then diff it against
 *    `live:` after each edit without a separate capture step.
 */

/** pixelmatch paints counted diffs with diffColor and AA pixels with aaColor. */
const DIFF_COLOR: [number, number, number] = [255, 0, 0];
const AA_COLOR: [number, number, number] = [255, 255, 0];

/** Hard pixel cap so a runaway capture cannot stall the server in decode. */
const MAX_PIXELS = 40_000_000;
/** Region bucket size; groups of adjacent buckets become reported bounds. */
const REGION_BUCKET = 64;
const MAX_REGIONS = 16;

export type DiffRegion = { x: number; y: number; width: number; height: number };

export type ImageDiffResult = {
  base: string;
  target: string;
  width: number;
  height: number;
  changedPixels: number;
  changedPercent: number;
  identical: boolean;
  regions: DiffRegion[];
  diffPath: string;
};

type Comparison = {
  width: number;
  height: number;
  changedPixels: number;
  identical: boolean;
  regions: DiffRegion[];
  overlay: PNG;
};

/**
 * Compare two decoded RGBA images. Pure over buffers so it is unit-testable
 * without a browser or a workspace on disk.
 */
export function comparePngs(base: PNG, target: PNG, threshold = 0.1): Comparison {
  if (base.width !== target.width || base.height !== target.height) {
    throw new CanvasError(
      'DIFF_SIZE_MISMATCH',
      `Hai ảnh khác kích thước: ${base.width}×${base.height} so với ${target.width}×${target.height}. Khung nhìn đã đổi giữa hai lần chụp — hãy so hai ảnh cùng kích thước.`,
      409,
    );
  }
  const { width, height } = base;
  if (width * height > MAX_PIXELS) {
    throw new CanvasError('DIFF_TOO_LARGE', `Ảnh ${width}×${height} vượt giới hạn ${MAX_PIXELS} pixel để so sánh.`, 413);
  }

  const overlay = new PNG({ width, height });
  // includeAA keeps anti-aliased pixels painted yellow but out of the count,
  // so text re-rasterisation noise does not read as a real change.
  const changedPixels = pixelmatch(base.data, target.data, overlay.data, width, height, {
    threshold,
    includeAA: false,
    diffColor: DIFF_COLOR,
    aaColor: AA_COLOR,
  });
  return {
    width,
    height,
    changedPixels,
    identical: changedPixels === 0,
    regions: regionsFromOverlay(overlay.data, width, height),
    overlay,
  };
}

/** Bounding boxes of contiguous changed areas, largest first. */
function regionsFromOverlay(data: Uint8Array, width: number, height: number): DiffRegion[] {
  const cols = Math.ceil(width / REGION_BUCKET);
  const rows = Math.ceil(height / REGION_BUCKET);
  const filled = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      // Unchanged background is a grey blend or the yellow AA marker, so an
      // opaque red triple can only be a counted diff pixel.
      if (data[i] === DIFF_COLOR[0] && data[i + 1] === DIFF_COLOR[1] && data[i + 2] === DIFF_COLOR[2] && data[i + 3] === 255) {
        filled[((y / REGION_BUCKET) | 0) * cols + ((x / REGION_BUCKET) | 0)] = 1;
      }
    }
  }

  const regions: DiffRegion[] = [];
  const seen = new Uint8Array(cols * rows);
  for (let start = 0; start < filled.length; start += 1) {
    if (!filled[start] || seen[start]) continue;
    seen[start] = 1;
    const queue = [start];
    let minCol = start % cols;
    let maxCol = minCol;
    let minRow = (start / cols) | 0;
    let maxRow = minRow;
    while (queue.length > 0) {
      const cell = queue.pop() as number;
      const col = cell % cols;
      const row = (cell / cols) | 0;
      minCol = Math.min(minCol, col);
      maxCol = Math.max(maxCol, col);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nc = col + dc;
        const nr = row + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const next = nr * cols + nc;
        if (!filled[next] || seen[next]) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    const x = minCol * REGION_BUCKET;
    const y = minRow * REGION_BUCKET;
    regions.push({
      x,
      y,
      width: Math.min((maxCol + 1) * REGION_BUCKET, width) - x,
      height: Math.min((maxRow + 1) * REGION_BUCKET, height) - y,
    });
  }
  regions.sort((a, b) => b.width * b.height - a.width * a.height);
  return regions.slice(0, MAX_REGIONS);
}

/**
 * Resolve one diff reference to an absolute PNG path inside the project.
 * `live:<screen-id>` captures the current preview; otherwise the reference
 * must be a project-contained path (relative to the project root or absolute
 * inside it), so a diff can never read files outside its own project.
 */
async function resolveImage(workspace: string, projectId: string, ref: string, label: string): Promise<string> {
  const liveMatch = /^live:(.+)$/.exec(ref);
  if (liveMatch) {
    const capture = await captureScreen(workspace, projectId, projectIdSchema.parse(liveMatch[1]));
    return capture.imagePath;
  }
  const root = await getProjectRoot(workspace, projectId);
  if (isAbsolute(ref)) {
    const canonicalRoot = await realpath(root);
    let canonical: string;
    try {
      canonical = await realpath(ref);
    } catch {
      throw new CanvasError('FILE_NOT_FOUND', `Không tìm thấy ảnh ${label}: “${ref}”.`, 404);
    }
    if (!isInside(canonicalRoot, canonical)) {
      throw new CanvasError('PATH_OUTSIDE_PROJECT', `Ảnh ${label} nằm ngoài project.`, 403);
    }
    return canonical;
  }
  return resolveProjectFile(root, ref);
}

async function readPng(path: string, label: string): Promise<PNG> {
  try {
    return PNG.sync.read(await readFile(path));
  } catch {
    throw new CanvasError('VALIDATION_ERROR', `Không đọc được ảnh PNG ${label}: “${path}”.`, 400);
  }
}

export async function diffProjectImages(
  workspace: string,
  projectId: string,
  input: { base: string; target: string; threshold?: number },
): Promise<ImageDiffResult> {
  const basePath = await resolveImage(workspace, projectId, input.base, 'base');
  const targetPath = await resolveImage(workspace, projectId, input.target, 'target');
  const comparison = comparePngs(await readPng(basePath, 'base'), await readPng(targetPath, 'target'), input.threshold);

  const root = await getProjectRoot(workspace, projectId);
  const diffs = await resolveProjectDirectory(root, 'artifacts/diffs');
  const diffPath = join(diffs, `diff-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`);
  await writeFile(diffPath, PNG.sync.write(comparison.overlay));

  const total = comparison.width * comparison.height;
  return {
    base: basePath,
    target: targetPath,
    width: comparison.width,
    height: comparison.height,
    changedPixels: comparison.changedPixels,
    changedPercent: Math.round((comparison.changedPixels / total) * 10_000) / 100,
    identical: comparison.identical,
    regions: comparison.regions,
    diffPath,
  };
}
