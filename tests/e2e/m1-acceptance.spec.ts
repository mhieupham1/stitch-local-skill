import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'playwright/test';
import { ensureServer, getServerStatus, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${runtime.url}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
}

async function createScreen(id: string, name: string, expectedRevision: number): Promise<void> {
  await api('/api/projects/sales-dashboard/screens', {
    method: 'POST',
    body: JSON.stringify({ id, name, width: 800, height: 600, expectedRevision }),
  });
}

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-canvas-m1-'));
  workspace = join(root, 'design workspace');
  process.env.LOCAL_CANVAS_STATIC_DIR = resolve('packages/canvas/dist');
  runtime = await ensureServer(workspace);
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'sales-dashboard', name: 'Bán hàng' }) });
  await createScreen('overview', 'Tổng quan', 0);
  await createScreen('orders', 'Đơn hàng', 1);
  await createScreen('order-detail', 'Chi tiết đơn hàng', 2);
  await writeFile(join(workspace, 'projects', 'sales-dashboard', 'screens', 'overview', 'index.html'), `<!doctype html><button type="button" id="toggle">Mở sidebar</button><output>Đóng</output><script>document.querySelector('#toggle').onclick=()=>document.querySelector('output').textContent='Mở';</script>`);
});

test.afterAll(async () => {
  if (workspace) await stopServer(workspace).catch(() => undefined);
  if (root) await rm(root, { force: true, recursive: true });
  delete process.env.LOCAL_CANVAS_STATIC_DIR;
});

test('M1: ba màn hình, cập nhật source đúng frame, thao tác canvas và khôi phục sau restart', async ({ page }) => {
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await expect(page.getByRole('heading', { name: 'Bán hàng' })).toBeVisible();
  await expect(page.locator('[data-screen-id]')).toHaveCount(3);

  const overview = page.locator('[data-screen-id="overview"]');
  const orders = page.locator('[data-screen-id="orders"] iframe');
  const overviewFrame = overview.locator('iframe');
  const oldOverviewSource = await overviewFrame.getAttribute('src');
  const oldOrdersSource = await orders.getAttribute('src');
  await writeFile(join(workspace, 'projects', 'sales-dashboard', 'screens', 'overview', 'styles.css'), 'body { background: rgb(12, 34, 56); }');
  await expect(overviewFrame).not.toHaveAttribute('src', oldOverviewSource ?? '');
  await expect(orders).toHaveAttribute('src', oldOrdersSource ?? '');

  await page.getByRole('button', { name: 'Tương tác' }).click();
  const frame = page.frameLocator('[data-screen-id="overview"] iframe');
  await frame.getByRole('button', { name: 'Mở sidebar' }).click();
  await expect(frame.getByText('Mở', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sắp xếp' }).click();

  await page.getByRole('button', { name: 'Phóng to' }).click();
  const dragHandle = overview.getByTestId('drag-handle');
  const box = await dragHandle.boundingBox();
  if (!box) throw new Error('Không thể lấy drag handle.');
  await page.mouse.move(box.x + 20, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + 48);
  await page.mouse.up();
  await expect(page.getByText('Đã lưu')).toBeVisible();
  await page.getByLabel('Width').fill('900');
  await page.getByLabel('Width').press('Tab');
  await expect(page.getByLabel('Width')).toHaveValue('900');

  await stopServer(workspace);
  await expect(page.getByText('Đang kết nối lại…')).toBeVisible({ timeout: 10_000 });
  runtime = await ensureServer(workspace);
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await expect(page.getByRole('heading', { name: 'Bán hàng' })).toBeVisible();
  await expect(page.getByLabel('Width')).toHaveValue('900');
  await expect(page.locator('[data-screen-id]')).toHaveCount(3);
});

test('canvas đang mở workspace trống nhận project được CLI hoặc API tạo sau đó', async ({ page }) => {
  const emptyRoot = await mkdtemp(join(tmpdir(), 'local-canvas-empty-'));
  const emptyWorkspace = join(emptyRoot, 'workspace');
  try {
    const publicRuntime = await ensureServer(emptyWorkspace);
    await page.goto(`${publicRuntime.url}/#previewUrl=${encodeURIComponent(publicRuntime.previewUrl)}`);
    await expect(page.getByText('Đang tải project…')).toBeVisible();
    // The canvas learns about a later project over the SSE stream. Creating it
    // before the subscription is live drops the event, leaving an empty canvas
    // that never refreshes — wait for the connection indicator instead of
    // racing the handshake.
    await expect(page.getByText('Đã kết nối', { exact: true })).toBeVisible();

    const created = await fetch(`${publicRuntime.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'late-project', name: 'Project tạo sau' }),
    });
    expect(created.status).toBe(201);
    await expect(page.getByRole('heading', { name: 'Project tạo sau' })).toBeVisible();
  } finally {
    await stopServer(emptyWorkspace).catch(() => undefined);
    await rm(emptyRoot, { force: true, recursive: true });
  }
});

test('retry layout chỉ hiện cho project có thay đổi chưa lưu', async ({ page }) => {
  const retryRoot = await mkdtemp(join(tmpdir(), 'local-canvas-retry-'));
  const retryWorkspace = join(retryRoot, 'workspace');
  try {
    const publicRuntime = await ensureServer(retryWorkspace);
    const request = (path: string, body: unknown) => fetch(`${publicRuntime.url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    await request('/api/projects', { id: 'alpha', name: 'Alpha' });
    await request('/api/projects', { id: 'beta', name: 'Beta' });
    await request('/api/projects/alpha/screens', { id: 'overview', name: 'Overview', width: 800, height: 600, expectedRevision: 0 });
    await request('/api/projects/beta/screens', { id: 'overview', name: 'Overview', width: 800, height: 600, expectedRevision: 0 });

    await page.goto(`${publicRuntime.url}/#previewUrl=${encodeURIComponent(publicRuntime.previewUrl)}`);
    await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible();
    await page.route(`${publicRuntime.url}/api/projects/alpha/layout`, (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'SERVER_UNAVAILABLE', message: 'Tạm thời không lưu được.' } }),
    }));
    const handle = page.locator('[data-screen-id="overview"]').getByTestId('drag-handle');
    const box = await handle.boundingBox();
    if (!box) throw new Error('Không thể lấy drag handle.');
    await page.mouse.move(box.x + 20, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 40);
    await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Thử lại' })).toBeVisible();

    await page.getByRole('button', { name: 'Beta' }).click();
    await expect(page.getByRole('heading', { name: 'Beta' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thử lại' })).toHaveCount(0);
  } finally {
    await stopServer(retryWorkspace).catch(() => undefined);
    await rm(retryRoot, { force: true, recursive: true });
  }
});

test('kết nối lại làm mới preview đã bỏ lỡ thay đổi source', async ({ page }) => {
  let blockEvents = true;
  await page.route(`${runtime.url}/api/events`, (route) => blockEvents ? route.abort('failed') : route.continue());
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await expect(page.getByRole('heading', { name: 'Bán hàng' })).toBeVisible();
  const overview = page.locator('[data-screen-id="overview"] iframe');
  const oldSource = await overview.getAttribute('src');
  await writeFile(join(workspace, 'projects', 'sales-dashboard', 'screens', 'overview', 'styles.css'), 'body { background: rgb(65, 12, 90); }');
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  blockEvents = false;
  await expect(overview).not.toHaveAttribute('src', oldSource ?? '', { timeout: 10_000 });
});
