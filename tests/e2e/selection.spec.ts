import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'playwright/test';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

const execute = promisify(execFile);

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${runtime.url}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

test.beforeAll(async () => {
  await execute(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', resolve('packages/canvas/vite.config.ts')]);
  root = await mkdtemp(join(tmpdir(), 'local-canvas-selection-'));
  workspace = join(root, 'workspace');
  process.env.LOCAL_CANVAS_STATIC_DIR = resolve('packages/canvas/dist');
  const publicRuntime = await ensureServer(workspace);
  runtime = publicRuntime;
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
  await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'demo', name: 'Demo', width: 800, height: 600, expectedRevision: 0 }) });
  const fixture = await readFile(resolve('tests/fixtures/selection-fixture.html'), 'utf8');
  await writeFile(join(workspace, 'projects', 'shop', 'screens', 'demo', 'index.html'), fixture);
});

test.afterAll(async () => {
  if (workspace) await stopServer(workspace).catch(() => undefined);
  if (root) await rm(root, { force: true, recursive: true });
  delete process.env.LOCAL_CANVAS_STATIC_DIR;
});

async function openCanvas(page: import('playwright/test').Page): Promise<void> {
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
}

/**
 * Enter Select mode and wait until the frame is actually armed. The shell fetches
 * the per-frame nonce asynchronously and only then appends `?bridge=` to the frame
 * src, which reloads it with the selection bridge. A click issued before that
 * lands on a frame with no bridge and is silently dropped, so the overlay never
 * appears — wait for the armed frame instead of guessing with a fixed delay.
 */
async function enterSelectMode(page: import('playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Chọn', exact: true }).click();
  await expect(page.locator('[data-screen-id="demo"] iframe')).toHaveAttribute('src', /[?&]bridge=[^&]+/);
}

test('hiển thị border khi vào chỉnh sửa và hover phần tử con', async ({ page }) => {
  await openCanvas(page);
  await page.locator('[data-screen-id="demo"]').click();
  await expect(page.getByRole('button', { name: 'Chỉnh sửa', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chỉnh sửa', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Thoát chỉnh sửa', exact: true })).toBeVisible();
  const cta = page.frameLocator('[data-screen-id="demo"] iframe').getByRole('button', { name: 'Tạo đơn hàng' });
  await expect(cta).toBeVisible();
  await cta.hover();
  await expect(page.getByTestId('selection-overlay')).toBeVisible();
});

test('tự phục hồi zoom thấp để click phần tử con trong preview', async ({ page }) => {
  await openCanvas(page);
  await page.evaluate(() => {
    const key = [...Object.keys(localStorage)].find((item) => item.startsWith('local-canvas-viewport:'));
    if (key) localStorage.setItem(key, JSON.stringify({ x: -313.75, y: 173.6, zoom: 0.1 }));
  });
  await page.reload();
  await enterSelectMode(page);
  await expect.poll(async () => page.locator('.canvas-world').evaluate((element) => element.getAttribute('style'))).toContain('scale(0.5)');
  const cta = page.frameLocator('[data-screen-id="demo"] iframe').getByRole('button', { name: 'Tạo đơn hàng' });
  await expect(cta).toBeVisible();
  await cta.click();
  await expect(page.getByTestId('selection-overlay')).toBeVisible();
  await expect(page.getByTestId('selection-overlay')).toContainText('cta');
});

test('chọn phần tử khi canvas zoom 0.5 lưu đúng screen, text và elementId', async ({ page }) => {
  await openCanvas(page);
  // Default viewport zoom is 0.5; enter Select mode and click the CTA button.
  await enterSelectMode(page);
  const cta = page.frameLocator('[data-screen-id="demo"] iframe').getByRole('button', { name: 'Tạo đơn hàng' });
  await expect(cta).toBeVisible();
  await cta.click();

  await expect(page.getByTestId('selection-overlay')).toBeVisible();
  await expect.poll(async () => {
    const response = await api('/api/projects/shop/selection');
    if (!response.ok) return null;
    return (await response.json()) as { data: { context: { screenId: string; elementId: string | null; text: string }; stale: boolean } };
  }).toMatchObject({ data: { context: { screenId: 'demo', elementId: 'cta', text: 'Tạo đơn hàng' }, stale: false } });
});

test('bỏ qua message giả mạo từ frame khác', async ({ page }) => {
  await openCanvas(page);
  await enterSelectMode(page);
  // Wait for the real frame to be ready before forging a message.
  await expect(page.frameLocator('[data-screen-id="demo"] iframe').getByRole('button', { name: 'Tạo đơn hàng' })).toBeVisible();
  await page.evaluate(() => {
    window.postMessage({
      source: 'local-design-canvas', kind: 'selection', nonce: 'forged-nonce',
      projectId: 'shop', screenId: 'demo', elementId: 'forged', selector: '#forged', text: 'forged',
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    }, '*');
  });
  await page.waitForTimeout(400);
  // A forged nonce from window.postMessage (not the real iframe) must never be
  // accepted, so no selection with the forged element id can exist.
  const response = await api('/api/projects/shop/selection');
  if (response.ok) {
    const body = (await response.json()) as { data: { context: { elementId: string | null } } };
    expect(body.data.context.elementId).not.toBe('forged');
  } else {
    expect(response.status).toBe(404);
  }
});

test('sửa source làm selection hiện tại thành stale', async ({ page }) => {
  await openCanvas(page);
  await enterSelectMode(page);
  const cta = page.frameLocator('[data-screen-id="demo"] iframe').getByRole('button', { name: 'Tạo đơn hàng' });
  await expect(cta).toBeVisible();
  await cta.click();
  await expect(page.getByTestId('selection-overlay')).toBeVisible();

  await writeFile(join(workspace, 'projects', 'shop', 'screens', 'demo', 'styles.css'), 'body { background: rgb(9, 9, 9); }');
  await expect(page.getByTestId('selection-overlay')).toHaveClass(/stale/);
  await expect.poll(async () => {
    const response = await api('/api/projects/shop/selection');
    if (!response.ok) return null;
    return ((await response.json()) as { data: { stale: boolean } }).data.stale;
  }).toBe(true);
});
