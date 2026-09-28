import { chromium } from 'playwright';
import { getProjectRoot, readProject } from '../../core/src/project-store.js';
import { CanvasError } from '../../core/src/schema.js';
import { getServerStatus } from './lifecycle.js';

/**
 * Turns a screen into the HTML/CSS shape Figma's "paste from clipboard" importer
 * understands. Figma reads `text/html` off the clipboard and rebuilds the tree as
 * frames, so the payload must carry:
 *
 *  - an explicit size per element, because Figma ignores the original cascade,
 *  - inline `style` attributes, because Figma does not apply `<style>` rules,
 *  - resolved values instead of `var(...)` references, which have no meaning there.
 *
 * Extraction runs in a real browser on the *preview* origin: the canvas shell sits on
 * the management origin, so it cannot read the preview iframe's DOM across origins.
 * Running it server-side also removes any dependency on iframe sandbox flags.
 */

/** Properties carried into the payload, in a stable order. */
export const EXPORT_BOX_PROPERTIES = [
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'background-color', 'background-image',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'opacity', 'box-shadow', 'overflow',
] as const;

export const EXPORT_TEXT_PROPERTIES = [
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-transform', 'vertical-align',
] as const;

/** Tags that never carry visual meaning and would only clutter the Figma layer list. */
export const EXPORT_SKIPPED_TAGS = ['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE'] as const;

/** Declarations where the browser's "nothing happens" default is worth dropping. */
const NOOP_VALUES = new Set([
  'none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'transparent',
  'medium', 'visible', 'static', 'row', 'nowrap',
]);

/**
 * Border longhands are only meaningful when that side actually has a border. The
 * browser always reports a colour (usually the current text colour), so without
 * this pairing Figma would draw outlines around every element.
 */
const BORDER_COLOR_PROPERTIES = new Set([
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
]);

export type ExtractedNode = {
  tag: string;
  style: Record<string, string>;
  text: string;
  /** Viewport-relative position, used to place the node absolutely in Figma. */
  x: number;
  y: number;
  children: ExtractedNode[];
};

export type ExtractOptions = {
  boxProperties: string[];
  textProperties: string[];
  skippedTags: string[];
  noopValues: string[];
  borderColorProperties: string[];
};

export type FigmaExport = {
  /** Paste-ready markup; the caller writes this to the clipboard. */
  html: string;
  /** Plain-text fallback for browsers that refuse a rich clipboard write. */
  text: string;
  screenId: string;
  screenName: string;
  nodeCount: number;
};

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Serialises the extracted tree into the markup Figma consumes.
 *
 * Figma does not implement flexbox or grid: it ignores those declarations and
 * collapses every child into a single flowing column, which is what turns the paste
 * into a wall of text. It does, however, place absolutely-positioned children exactly
 * where `left`/`top` say. So each node is emitted as an overlay at the coordinates
 * measured in the browser, and the parent's layout properties are dropped entirely.
 *
 * Coordinates are relative to the parent because a nested absolute element resolves
 * against its nearest positioned ancestor; anchoring everything to the root would
 * stack the whole page on top of itself.
 */
export function serializeForFigma(node: ExtractedNode, parentX = 0, parentY = 0): string {
  const offsets: Record<string, string> = {
    position: 'absolute',
    left: `${Math.round(node.x - parentX)}px`,
    top: `${Math.round(node.y - parentY)}px`,
  };
  const style = Object.entries({ ...offsets, ...node.style }).map(([property, value]) => `${property}:${value}`).join(';');
  const children = node.children.map((child) => serializeForFigma(child, node.x, node.y)).join('');
  const text = node.text ? escapeText(node.text) : '';
  return `<${node.tag} style="${escapeAttribute(style)}">${text}${children}</${node.tag}>`;
}

function countNodes(node: ExtractedNode): number {
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}

/**
 * Measures a screen in a headless browser and returns paste-ready markup.
 *
 * The page renders at the screen's declared viewport so layout matches the canvas.
 * Invisible elements and zero-box boxes are pruned: Figma would otherwise receive
 * empty frames that clutter the result without contributing anything.
 */
export async function exportScreenForFigma(workspace: string, projectId: string, screenId: string): Promise<FigmaExport> {
  const runtime = await getServerStatus(workspace);
  if (!runtime) throw new CanvasError('SERVER_NOT_RUNNING', 'Hãy chạy local-canvas start trước khi export.', 503);
  const project = await readProject(workspace, projectId);
  const screen = project.screens.find((item) => item.id === screenId);
  if (!screen) throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${screenId}”.`, 404);
  await getProjectRoot(workspace, projectId);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    throw new CanvasError('BROWSER_NOT_INSTALLED', 'Chưa cài Playwright Chromium. Chạy: npx playwright install chromium', 503);
  }
  try {
    const context = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(`${runtime.previewUrl}/projects/${encodeURIComponent(projectId)}/${screen.entry}`, { waitUntil: 'load', timeout: 20_000 });
    // Fonts change text metrics; measuring before they settle yields a stale layout.
    await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
    await page.waitForTimeout(250);

    const extracted = await page.evaluate<{ root: ExtractedNode; visibleText: string }, ExtractOptions>((options) => {
      const { boxProperties, textProperties, skippedTags, noopValues, borderColorProperties } = options;
      const skip = new Set<string>(skippedTags);
      const noop = new Set<string>(noopValues);
      const borderColors = new Set<string>(borderColorProperties);

      const walk = (element: Element): ExtractedNode | null => {
        const computed = getComputedStyle(element);
        if (computed.display === 'none' || computed.visibility === 'hidden' || Number.parseFloat(computed.opacity) === 0) return null;
        const rect = element.getBoundingClientRect();
        const ownText = Array.from(element.childNodes)
          .filter((node) => node.nodeType === 3)
          .map((node) => (node.textContent ?? '').trim())
          .filter(Boolean)
          .join(' ');
        // A box with no area paints nothing, unless it holds text — inline labels
        // and empty-state copy can legitimately report a zero rect.
        if ((rect.width < 1 || rect.height < 1) && !ownText) return null;

        const style: Record<string, string> = {};
        for (const property of boxProperties) {
          const value = computed.getPropertyValue(property);
          if (!value || noop.has(value)) continue;
          // Computed opacity reports a bare `1`; the literal string is the only
          // reliable way to drop it since the shared noop set holds property values.
          if (property === 'opacity' && value === '1') continue;
          // A colour on a side with no width would become a phantom outline in Figma.
          if (borderColors.has(property) && computed.getPropertyValue(property.replace('-color', '-width')) === '0px') continue;
          const numeric = /padding|radius|gap/.test(property);
          style[property] = numeric ? `${Math.round(Number.parseFloat(value) * 100) / 100}px` : value;
        }
        for (const property of textProperties) {
          const value = computed.getPropertyValue(property);
          if (!value || noop.has(value)) continue;
          style[property] = value;
        }
        // Measured box replaces percentage/auto values, which have no meaning once
        // the document's own cascade is gone. Written last so it is never overwritten.
        style['width'] = `${Math.round(rect.width)}px`;
        style['height'] = `${Math.round(rect.height)}px`;

        const children = Array.from(element.children)
          .filter((child) => !skip.has(child.tagName))
          .map(walk)
          .filter((node): node is ExtractedNode => node !== null);
        return { tag: element.tagName.toLowerCase(), style, text: ownText, x: rect.x, y: rect.y, children };
      };

      const body = document.body;
      const rect = body.getBoundingClientRect();
      const background = getComputedStyle(body).backgroundColor;
      return {
        root: {
          tag: 'div',
          style: { width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px`, ...(background && background !== 'rgba(0, 0, 0, 0)' ? { 'background-color': background } : {}) },
          text: '',
          x: rect.x,
          y: rect.y,
          children: Array.from(body.children).filter((child) => !skip.has(child.tagName)).map(walk).filter((node): node is ExtractedNode => node !== null),
        },
        visibleText: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim(),
      };
    }, {
      boxProperties: [...EXPORT_BOX_PROPERTIES],
      textProperties: [...EXPORT_TEXT_PROPERTIES],
      skippedTags: [...EXPORT_SKIPPED_TAGS],
      noopValues: [...NOOP_VALUES],
      borderColorProperties: [...BORDER_COLOR_PROPERTIES],
    });

    const root = extracted.root as ExtractedNode;
    return {
      html: serializeForFigma(root),
      text: extracted.visibleText.slice(0, 4000),
      screenId: screen.id,
      screenName: screen.name,
      nodeCount: countNodes(root),
    };
  } finally {
    await browser.close();
  }
}
