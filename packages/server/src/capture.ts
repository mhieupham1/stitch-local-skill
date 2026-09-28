import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { getProjectRoot, readProject } from '../../core/src/project-store.js';
import { resolveProjectDirectory } from '../../core/src/paths.js';
import { CanvasError } from '../../core/src/schema.js';
import { getServerStatus } from './lifecycle.js';

export type CaptureResult = {
  imagePath: string;
  width: number;
  height: number;
  errors: { type: 'console' | 'page' | 'resource'; message: string }[];
};

export async function captureScreen(workspace: string, projectId: string, screenId: string): Promise<CaptureResult> {
  const runtime = await getServerStatus(workspace);
  if (!runtime) throw new CanvasError('SERVER_NOT_RUNNING', 'Hãy chạy local-canvas start trước khi chụp preview.', 503);
  const project = await readProject(workspace, projectId);
  const screen = project.screens.find((item) => item.id === screenId);
  if (!screen) throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${screenId}”.`, 404);
  const errors: CaptureResult['errors'] = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new CanvasError('BROWSER_NOT_INSTALLED', 'Chưa cài Playwright Chromium. Chạy: npx playwright install chromium', 503);
  }
  try {
    const context = await browser.newContext({ viewport: { width: screen.width, height: screen.height } });
    const page = await context.newPage();
    page.on('console', (message) => { if (message.type() === 'error') errors.push({ type: 'console', message: message.text() }); });
    page.on('pageerror', (error) => errors.push({ type: 'page', message: error.message }));
    page.on('response', (response) => {
      if (response.url().startsWith(runtime.previewUrl) && response.status() >= 400) errors.push({ type: 'resource', message: `${response.status()} ${response.url()}` });
    });
    page.on('requestfailed', (request) => {
      if (request.url().startsWith(runtime.previewUrl)) errors.push({ type: 'resource', message: request.failure()?.errorText ?? request.url() });
    });
    const source = `${runtime.previewUrl}/projects/${encodeURIComponent(project.id)}/${screen.entry}`;
    await page.setContent(`<style>html,body{margin:0;overflow:hidden}iframe{display:block;width:${screen.width}px;height:${screen.height}px;border:0}</style><iframe sandbox="allow-scripts" src="${source}"></iframe>`);
    const iframe = page.locator('iframe');
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
        await iframe.waitFor({ state: 'visible', timeout: 10_000 });
        const previewFrame = await (await iframe.elementHandle())?.contentFrame();
        if (!previewFrame) return;
        await previewFrame.waitForLoadState('domcontentloaded').catch(() => undefined);
        await previewFrame.evaluate(async () => {
          await document.fonts?.ready;
          await Promise.all([...document.images].map((image) => image.complete
            ? undefined
            : new Promise<void>((resolve) => { image.addEventListener('load', () => resolve(), { once: true }); image.addEventListener('error', () => resolve(), { once: true }); })));
        });
        })(),
        new Promise<void>((resolve) => { readyTimer = setTimeout(resolve, 10_000); }),
      ]);
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
    }
    const root = await getProjectRoot(workspace, projectId);
    const artifacts = await resolveProjectDirectory(root, 'artifacts/captures');
    await mkdir(artifacts, { recursive: true });
    const captureId = `${screen.id}-${Date.now()}`;
    const imagePath = join(artifacts, `${captureId}.png`);
    await iframe.screenshot({ path: imagePath, timeout: 10_000 });
    await writeFile(join(artifacts, `${captureId}.json`), `${JSON.stringify({ width: screen.width, height: screen.height, errors }, null, 2)}\n`);
    await context.close();
    return { imagePath, width: screen.width, height: screen.height, errors };
  } finally {
    await browser.close();
  }
}
