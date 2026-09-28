import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { getProjectRoot, readProject } from '../../core/src/project-store.js';
import { resolveProjectDirectory } from '../../core/src/paths.js';
import { CanvasError } from '../../core/src/schema.js';

export type ReferenceResult = {
  url: string;
  title: string;
  headings: { level: number; text: string }[];
  sections: string[];
  links: { text: string; href: string }[];
  imagePath: string;
  dataPath: string;
};

/**
 * Opens a real URL with a headless browser and extracts structured content — title,
 * headings, section text, and links — plus a full-page screenshot. The result is a
 * design *reference* only: it is written to the project's `artifacts/references`, never
 * to `screens`, and the agent is expected to build its own static HTML/CSS from it
 * rather than copy the source. This runs a browser on the user's machine and will
 * fetch whatever URL it is given, so callers should confirm the URL with the user.
 */
export async function fetchReference(workspace: string, projectId: string, url: string): Promise<ReferenceResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CanvasError('INVALID_URL', 'URL tham chiếu không hợp lệ.', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CanvasError('INVALID_URL', 'Chỉ hỗ trợ URL http hoặc https.', 400);
  }
  await readProject(workspace, projectId);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    throw new CanvasError('BROWSER_NOT_INSTALLED', 'Chưa cài Playwright Chromium. Chạy: npx playwright install chromium', 503);
  }
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (error) {
      throw new CanvasError('REFERENCE_FETCH_FAILED', `Không mở được URL tham chiếu: ${error instanceof Error ? error.message : 'lỗi không xác định'}.`, 502);
    }
    // Give client-rendered pages a bounded window to settle instead of waiting on
    // network idle forever; a page with long-polling would otherwise hang.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);

    const extracted = await page.evaluate(() => {
      const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map((node) => ({ level: Number(node.tagName.slice(1)), text: clean(node.textContent) }))
        .filter((heading) => heading.text.length > 0)
        .slice(0, 80);
      const sections = Array.from(document.querySelectorAll('main, section, article'))
        .map((node) => clean(node.textContent))
        .filter((text) => text.length > 40)
        .slice(0, 40)
        .map((text) => text.slice(0, 600));
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map((node) => ({ text: clean(node.textContent), href: (node as HTMLAnchorElement).href }))
        .filter((link) => link.text.length > 0)
        .slice(0, 120);
      return { title: clean(document.title), headings, sections, links };
    });

    const root = await getProjectRoot(workspace, projectId);
    const references = await resolveProjectDirectory(root, 'artifacts/references');
    await mkdir(references, { recursive: true });
    const slug = (parsed.hostname + parsed.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'reference';
    const id = `${slug}-${Date.now()}`;
    const imagePath = join(references, `${id}.png`);
    const dataPath = join(references, `${id}.json`);
    await page.screenshot({ path: imagePath, fullPage: true, timeout: 15_000 }).catch(() => undefined);

    const result: ReferenceResult = { url: parsed.toString(), ...extracted, imagePath, dataPath };
    await writeFile(dataPath, `${JSON.stringify(result, null, 2)}\n`);
    await context.close();
    return result;
  } finally {
    await browser.close();
  }
}
