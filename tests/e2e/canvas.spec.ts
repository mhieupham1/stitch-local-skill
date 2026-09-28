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
  await execute(process.execPath, [
    resolve('node_modules/vite/bin/vite.js'),
    'build',
    '--config',
    resolve('packages/canvas/vite.config.ts'),
  ]);
  root = await mkdtemp(join(tmpdir(), 'local-canvas-e2e-'));
  workspace = join(root, 'workspace');
  process.env.LOCAL_CANVAS_STATIC_DIR = resolve('packages/canvas/dist');
  const publicRuntime = await ensureServer(workspace);
  runtime = publicRuntime;
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
  await api('/api/projects/shop/screens', {
    method: 'POST', body: JSON.stringify({ id: 'overview', name: 'Overview', width: 800, height: 600, expectedRevision: 0 }),
  });
  await api('/api/projects/shop/screens', {
    method: 'POST', body: JSON.stringify({ id: 'orders', name: 'Orders', width: 800, height: 600, expectedRevision: 1 }),
  });
});

test.afterAll(async () => {
  if (workspace) await stopServer(workspace).catch(() => undefined);
  if (root) await rm(root, { force: true, recursive: true });
  delete process.env.LOCAL_CANVAS_STATIC_DIR;
});

test('kéo khung khi zoom rồi reload để xác nhận vị trí được lưu', async ({ page }) => {
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
  const shell = await page.locator('.app-shell').boundingBox();
  const viewportBox = await page.locator('.canvas-viewport').boundingBox();
  const viewport = page.viewportSize();
  if (!shell || !viewport || !viewportBox) throw new Error('Không đo được chiều cao canvas.');
  expect(shell.height).toBeGreaterThan(viewport.height * 0.9);
  expect(viewportBox.height).toBeGreaterThan(200);
  const frame = page.locator('[data-screen-id="overview"]');
  const handle = frame.getByTestId('drag-handle');
  await expect(handle).toBeVisible();
  await page.getByRole('button', { name: 'Phóng to' }).click();
  const before = await frame.boundingBox();
  const handleBox = await handle.boundingBox();
  if (!before || !handleBox) throw new Error('Không lấy được vị trí khung màn hình.');
  await page.mouse.move(handleBox.x + 20, handleBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 120, handleBox.y + 62);
  await page.mouse.up();
  await expect(page.getByText('Đã lưu')).toBeVisible();
  const after = await frame.boundingBox();
  if (!after) throw new Error('Khung màn hình biến mất sau khi kéo.');
  expect(after.x).toBeGreaterThan(before.x + 40);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
  const reloaded = await page.locator('[data-screen-id="overview"]').boundingBox();
  if (!reloaded) throw new Error('Khung màn hình không còn sau reload.');
  expect(reloaded.x).toBeGreaterThan(before.x + 40);

  await page.getByLabel('Width').fill('900');
  await page.getByLabel('Width').press('Tab');
  await expect(page.getByText('Đã lưu')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Width')).toHaveValue('900');
});

test('thay đổi source chỉ reload iframe của màn hình liên quan', async ({ page }) => {
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  const overview = page.locator('[data-screen-id="overview"] iframe');
  const orders = page.locator('[data-screen-id="orders"] iframe');
  await expect(overview).toBeVisible();
  await expect(orders).toBeVisible();
  const oldOverviewSource = await overview.getAttribute('src');
  const oldOrdersSource = await orders.getAttribute('src');
  await writeFile(join(workspace, 'projects', 'shop', 'screens', 'overview', 'styles.css'), 'body { background: rgb(1, 2, 3); }');
  await expect(overview).not.toHaveAttribute('src', oldOverviewSource ?? '');
  await expect(orders).toHaveAttribute('src', oldOrdersSource ?? '');
});

test('trang dài hiện trọn trong khung và canvas không cuộn cả trang', async ({ page }) => {
  const listed = await api('/api/projects/shop');
  const project = (await listed.json()) as { data: { revision: number } };
  const created = await api('/api/projects/shop/screens', {
    method: 'POST',
    body: JSON.stringify({ id: 'tall', name: 'Tall', width: 800, height: 600, expectedRevision: project.data.revision }),
  });
  expect(created.ok).toBe(true);
  await writeFile(join(workspace, 'projects', 'shop', 'screens', 'tall', 'index.html'), '<!doctype html><html><head><style>body{margin:0}.page{height:1800px;background:#eee}</style></head><body><div class="page">Tall page</div></body></html>');
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  const frame = page.locator('[data-screen-id="tall"]');
  await expect.poll(async () => {
    try {
      return await frame.evaluate((element) => Number.parseFloat((element as HTMLElement).style.height));
    } catch {
      return 0;
    }
  }).toBeGreaterThanOrEqual(1830);
  await expect.poll(async () => {
    try {
      return await page.frameLocator('[data-screen-id="tall"] iframe').locator('.page').evaluate((element) => {
        const doc = element.ownerDocument.documentElement;
        return doc.scrollHeight <= doc.clientHeight + 2;
      });
    } catch {
      // expect.poll retries a failed assertion but rethrows an error from the
      // callback. The watcher reloads the frame while it catches up, which
      // destroys the execution context mid-evaluate; report "not settled yet"
      // so the poll retries instead of failing the test.
      return false;
    }
  }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1)).toBe(true);
});

test('menu preview trên header đổi chiều ngang theo Mobile / Tablet / Máy tính', async ({ page }) => {
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await page.locator('[data-screen-id="overview"]').click();
  const previewToggle = page.getByRole('button', { name: 'Preview', exact: true });
  await expect(previewToggle).toBeVisible();
  if (!(await page.getByTestId('preview-size-menu').isVisible())) await previewToggle.click();
  const menu = page.getByTestId('preview-size-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: /Mobile/i }).click();
  await expect(page.getByText('Hiện tại:').locator('..')).toContainText('390');
  await menu.getByRole('button', { name: /Tablet/i }).click();
  await expect(page.getByText('Hiện tại:').locator('..')).toContainText('768');
  await menu.getByRole('button', { name: /Máy tính/i }).click();
  await expect(page.getByText('Hiện tại:').locator('..')).toContainText('1280');
  await previewToggle.click();
  await expect(menu).toHaveCount(0);
});

test('bỏ chọn màn hình bằng click nền canvas hoặc Escape', async ({ page }) => {
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await page.locator('[data-screen-id="overview"]').click();
  await expect(page.getByTestId('preview-size-menu')).toBeVisible();
  await page.locator('.canvas-viewport').click({ position: { x: 20, y: 40 } });
  await expect(page.getByTestId('preview-size-menu')).toHaveCount(0);
  await page.locator('[data-screen-id="overview"]').click();
  await expect(page.getByTestId('preview-size-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('preview-size-menu')).toHaveCount(0);
});

test('kéo vùng trên nền canvas chọn nhiều màn hình rồi di chuyển cùng nhau', async ({ page }) => {
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await page.getByRole('button', { name: 'Shop', exact: true }).click();
  await page.getByRole('button', { name: 'Vừa khung hình' }).click();
  // Only assert the two frames the band is aimed at, so another test adding a
  // screen to this shared project cannot fail this assertion.
  const overview = page.locator('[data-screen-id="overview"]');
  const orders = page.locator('[data-screen-id="orders"]');
  await expect(overview).toBeVisible();
  await expect(orders).toBeVisible();
  const overviewBox = await overview.boundingBox();
  const ordersBox = await orders.boundingBox();
  const viewportBox = await page.locator('.canvas-viewport').boundingBox();
  if (!overviewBox || !ordersBox || !viewportBox) throw new Error('Không đo được vị trí khung màn hình.');

  // Start the band above-left of both frames and sweep past both of them.
  const startX = Math.min(overviewBox.x, ordersBox.x) - 24;
  const startY = Math.min(overviewBox.y, ordersBox.y) - 24;
  const endX = Math.max(overviewBox.x + overviewBox.width, ordersBox.x + ordersBox.width) + 24;
  const endY = Math.max(overviewBox.y + overviewBox.height, ordersBox.y + ordersBox.height) + 24;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Mid-drag the band must be visible so the gesture reads as a selection.
  await page.mouse.move(endX, endY, { steps: 8 });
  const band = page.getByTestId('selection-band');
  await expect(band).toBeVisible();
  // The band is positioned inside .canvas-viewport while pointer events report
  // page coordinates, so it used to render shifted by the sidebar/header offset.
  // Its edges must sit on the real pointer path instead.
  const bandBox = await band.boundingBox();
  if (!bandBox) throw new Error('Không đo được vùng kéo.');
  expect(Math.abs(bandBox.x - startX)).toBeLessThan(2);
  expect(Math.abs(bandBox.y - startY)).toBeLessThan(2);
  expect(Math.abs(bandBox.x + bandBox.width - endX)).toBeLessThan(2);
  expect(Math.abs(bandBox.y + bandBox.height - endY)).toBeLessThan(2);
  await page.mouse.up();
  await expect(overview).toHaveClass(/selected/);
  await expect(orders).toHaveClass(/selected/);
  await expect(page.getByTestId('connection-status')).toContainText('màn hình');

  // A group drag must move every selected frame by the same delta.
  const beforeOverview = (await overview.boundingBox()) ?? { x: 0, y: 0 };
  const beforeOrders = (await orders.boundingBox()) ?? { x: 0, y: 0 };
  const handleBox = await overview.getByTestId('drag-handle').boundingBox();
  if (!handleBox) throw new Error('Không lấy được thanh kéo của khung.');
  // Aim at the bar's own center: at low zoom a fixed pixel offset can land below
  // the 30px title bar and miss the handle entirely.
  const grabX = handleBox.x + handleBox.width / 2;
  const grabY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 120, grabY + 72, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText('Đã lưu')).toBeVisible();
  const afterOverview = await overview.boundingBox();
  const afterOrders = await orders.boundingBox();
  if (!afterOverview || !afterOrders) throw new Error('Khung màn hình biến mất sau khi kéo nhóm.');
  expect(afterOverview.x - beforeOverview.x).toBeGreaterThan(40);
  expect(afterOrders.x - beforeOrders.x).toBeCloseTo(afterOverview.x - beforeOverview.x, 0);
  expect(afterOrders.y - beforeOrders.y).toBeCloseTo(afterOverview.y - beforeOverview.y, 0);

  // Only the layout persists across reload; the selection is client state.
  await page.reload();
  await expect(page.locator('[data-screen-id="overview"]')).toBeVisible();
  const reloadedOverview = await page.locator('[data-screen-id="overview"]').boundingBox();
  const reloadedOrders = await page.locator('[data-screen-id="orders"]').boundingBox();
  if (!reloadedOverview || !reloadedOrders) throw new Error('Khung màn hình không còn sau reload.');
  expect(reloadedOverview.x).toBeCloseTo(afterOverview.x, 0);
  expect(reloadedOrders.x).toBeCloseTo(afterOrders.x, 0);
});
