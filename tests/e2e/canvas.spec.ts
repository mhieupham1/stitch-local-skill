import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'playwright/test';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

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

test('prototype: chọn nhiều màn chỉ sao chép prompt, rồi hiện ID và trạng thái cần tạo lại', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
  await page.locator('[data-screen-row="orders"]').click();
  await page.locator('[data-screen-row="overview"]').click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: 'Tạo prototype' }).click();
  await expect(page.getByTestId('prototype-prompt')).toContainText('projectId: shop');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('orders, overview');
  expect((await (await api('/api/projects/shop/prototypes')).json()).data).toEqual([]);

  const baseline = (await (await api('/api/projects/shop/prototype-sources?screenIds=overview,orders')).json()).data;
  const created = await api('/api/projects/shop/prototypes', { method: 'POST', body: JSON.stringify({
    id: 'shop-flow', name: 'Shop Flow', screenIds: ['overview', 'orders'], startScreenId: 'overview',
    transitions: [], expectedSourceBaseline: baseline,
  }) });
  expect(created.ok).toBe(true);
  await expect(page.getByTestId('prototype-shop-flow')).toContainText('shop-flow');
  await expect(page.getByTestId('prototype-shop-flow').getByRole('link', { name: 'Play' })).toBeVisible();
  await expect(page.locator('.prototype-list')).toHaveCount(0);
  await expect(page.getByTestId('prototype-shop-flow').locator('..')).toHaveClass(/canvas-world/);
  await expect(page.locator('[data-screen-id="shop-flow"]')).toHaveCount(0);
  await writeFile(join(workspace, 'projects', 'shop', 'screens', 'orders', 'styles.css'), 'body { color: rgb(4, 5, 6); }');
  await expect(page.getByTestId('prototype-shop-flow')).toContainText('Cần tạo lại');
  await page.getByTestId('prototype-shop-flow').getByRole('button', { name: 'Copy prompt tạo lại' }).click();
  await expect(page.getByTestId('prototype-prompt')).toContainText('prototypeId: shop-flow');
});

test('prototype: kéo từ thân thẻ trong canvas, lưu vị trí và Play mở đúng luồng', async ({ page }) => {
  const baseline = (await (await api('/api/projects/shop/prototype-sources?screenIds=overview,orders')).json()).data;
  const created = await api('/api/projects/shop/prototypes', { method: 'POST', body: JSON.stringify({
    id: 'movable-flow', name: 'Movable Flow', screenIds: ['overview', 'orders'], startScreenId: 'overview',
    transitions: [], expectedSourceBaseline: baseline,
  }) });
  expect(created.ok).toBe(true);
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  const card = page.getByTestId('prototype-movable-flow');
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Vừa khung hình' }).click();
  await expect(card).toBeInViewport();
  const body = card.locator('.prototype-card-content');
  const before = await card.boundingBox();
  const bodyBox = await body.boundingBox();
  if (!before || !bodyBox) throw new Error('Không đo được thẻ prototype.');
  const startX = bodyBox.x + Math.min(12, bodyBox.width / 10);
  const startY = bodyBox.y + bodyBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 80, startY + 50);
  await page.mouse.up();
  const after = await card.boundingBox();
  if (!after) throw new Error('Thẻ prototype biến mất sau khi kéo.');
  expect(after.x).toBeGreaterThan(before.x + 40);
  await expect.poll(async () => (await (await api('/api/projects/shop/prototypes/movable-flow')).json()).data.x).toBeGreaterThan(0);
  await page.reload();
  await expect(card).toBeVisible();
  const reloaded = await card.boundingBox();
  if (!reloaded) throw new Error('Thẻ prototype không hiện sau reload.');
  expect(reloaded.x).toBeGreaterThan(before.x + 40);
  const current = (await (await api('/api/projects/shop/prototypes/movable-flow')).json()).data;
  const overlapping = await api('/api/projects/shop/prototypes/movable-flow', { method: 'PATCH', body: JSON.stringify({ expectedRevision: current.revision, x: 100, y: 100 }) });
  expect(overlapping.ok).toBe(true);
  await expect(card).toHaveAttribute('style', /left: 100px/);
  const popup = page.waitForEvent('popup');
  await card.getByRole('link', { name: 'Play' }).click();
  const player = await popup;
  await expect(player.getByRole('heading', { name: 'Movable Flow' })).toBeVisible();
  await player.close();
});

test('prototype: chỉ xóa thẻ sau khi người dùng xác nhận và giữ màn hình gốc', async ({ page }) => {
  const baseline = (await (await api('/api/projects/shop/prototype-sources?screenIds=overview,orders')).json()).data;
  const created = await api('/api/projects/shop/prototypes', { method: 'POST', body: JSON.stringify({
    id: 'delete-me', name: 'Delete Me', screenIds: ['overview', 'orders'], startScreenId: 'overview',
    transitions: [], expectedSourceBaseline: baseline,
  }) });
  expect(created.ok).toBe(true);
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  const card = page.getByTestId('prototype-delete-me');
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Vừa khung hình' }).click();

  page.once('dialog', (dialog) => void dialog.dismiss());
  await card.getByRole('button', { name: 'Xóa prototype' }).click();
  await expect(card).toBeVisible();
  expect((await (await api('/api/projects/shop/prototypes/delete-me')).json()).data.id).toBe('delete-me');

  page.once('dialog', (dialog) => void dialog.accept());
  await card.getByRole('button', { name: 'Xóa prototype' }).click();
  await expect(card).toHaveCount(0);
  expect((await api('/api/projects/shop/prototypes/delete-me')).status).toBe(404);
  await expect(page.locator('[data-screen-id="overview"]')).toBeVisible();
  await expect(page.locator('[data-screen-id="orders"]')).toBeVisible();
});

test('prototype: clipboard từ chối vẫn hiện prompt và cho thử lại', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
  });
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await page.locator('[data-screen-row="orders"]').click();
  await page.locator('[data-screen-row="overview"]').click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: 'Tạo prototype' }).click();
  await expect(page.getByTestId('prototype-prompt')).toContainText('projectId: shop');
  await expect(page.getByTestId('prototype-prompt').getByRole('button', { name: 'Sao chép lại' })).toBeVisible();
});

test('mở Canvas trực tiếp cho chọn preview của phiên hiện tại', async ({ page }) => {
  await page.goto(`${runtime.url}/`);

  await expect(page.getByRole('heading', { name: 'Chọn preview' })).toBeVisible();
  await expect(page.getByText(runtime.previewUrl, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dùng preview này', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dự án của bạn' })).toBeVisible();
  await expect(page.locator('.canvas-viewport')).toHaveCount(0);
  await page.getByRole('link', { name: 'Mở dự án Shop', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
  await page.getByRole('button', { name: 'Đổi preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chọn preview' })).toBeVisible();
});

test('không tự dùng preview URL không thuộc phiên hiện tại', async ({ page }) => {
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent('https://untrusted.example')}`);

  await expect(page.getByRole('heading', { name: 'Chọn preview' })).toBeVisible();
  await expect(page.getByText(runtime.previewUrl, { exact: true })).toBeVisible();
  await expect(page.locator('[data-screen-id]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('local-canvas-preview-url'))).toBeNull();
});

test('có thể tải lại preview khi API tạm thời chưa sẵn sàng', async ({ page }) => {
  let requests = 0;
  await page.route(`${runtime.url}/api/preview`, async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'PREVIEW_UNAVAILABLE', message: 'Preview chưa sẵn sàng.' } }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`${runtime.url}/`);
  await expect(page.getByRole('alert')).toContainText('Preview chưa sẵn sàng.');
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(page.getByText(runtime.previewUrl, { exact: true })).toBeVisible();
  expect(requests).toBe(2);
});

test('kéo khung khi zoom rồi reload để xác nhận vị trí được lưu', async ({ page }) => {
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
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
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
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
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
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

test('header chứa dropdown kích thước và không che canvas', async ({ page }) => {
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await page.locator('[data-screen-id="overview"]').click();
  const menu = page.locator('.app-header').getByRole('combobox', { name: 'Kích thước xem trước' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('option:not([disabled])')).toHaveCount(3);
  await menu.selectOption('390');
  await expect(page.getByRole('spinbutton', { name: 'Width' })).toHaveValue('390');
  await menu.selectOption('768');
  await expect(page.getByRole('spinbutton', { name: 'Width' })).toHaveValue('768');
  await menu.selectOption('1280');
  await expect(page.getByRole('spinbutton', { name: 'Width' })).toHaveValue('1280');
  expect(await page.locator('.canvas-body').evaluate((body) => {
    const canvas = body.querySelector('.canvas-viewport');
    return canvas?.getBoundingClientRect().top === body.getBoundingClientRect().top;
  })).toBe(true);
});

test('Canvas không hiển thị nút thêm màn hình', async ({ page }) => {
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
  await expect(page.locator('[data-screen-id="overview"]')).toBeVisible();
  await expect(page.locator('.app-header').getByRole('button', { name: 'Thêm màn hình' })).toHaveCount(0);
});

test('menu Phiên bản giữ thao tác lưu project ngoài header chính', async ({ page }) => {
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
  const header = page.locator('.app-header');
  await expect(header.getByRole('button', { name: 'Lưu ảnh chụp' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Khôi phục', exact: true })).toHaveCount(0);

  await header.getByRole('button', { name: 'Phiên bản' }).click();
  await page.getByRole('button', { name: 'Lưu phiên bản', exact: true }).click();
  const message = await page.getByRole('alert').textContent();
  const id = message?.match(/Đã lưu phiên bản: (snapshot-[\w-]+)/)?.[1];
  expect(id).toBeTruthy();
  expect(JSON.parse(await readFile(join(workspace, 'projects', 'shop', 'snapshots', id!, 'project.json'), 'utf8'))).toMatchObject({ id: 'shop' });
  await expect(page.getByRole('button', { name: 'Lưu phiên bản', exact: true })).toBeHidden();
});

test('bỏ chọn màn hình bằng click nền canvas hoặc Escape', async ({ page }) => {
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await page.locator('[data-screen-id="overview"]').click();
  await expect(page.locator('.app-header').getByRole('combobox', { name: 'Kích thước xem trước' })).toBeVisible();
  await page.locator('.canvas-viewport').click({ position: { x: 20, y: 40 } });
  await expect(page.getByRole('combobox', { name: 'Kích thước xem trước' })).toHaveCount(0);
  await page.locator('[data-screen-id="overview"]').click();
  await expect(page.getByRole('combobox', { name: 'Kích thước xem trước' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox', { name: 'Kích thước xem trước' })).toHaveCount(0);
});

test('mỗi màn hình được chọn chỉ có viền rõ mà không đổi màu preview', async ({ page }) => {
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  const overview = page.locator('[data-screen-id="overview"]');
  const orders = page.locator('[data-screen-id="orders"]');
  await expect(overview).toBeVisible();
  await overview.click();
  await expect(overview.getByText('Đã chọn', { exact: true })).toHaveCount(0);
  await expect(orders.getByText('Đã chọn', { exact: true })).toHaveCount(0);

  await orders.click({ modifiers: ['Control'] });
  for (const frame of [overview, orders]) {
    await expect(frame.getByText('Đã chọn', { exact: true })).toHaveCount(0);
    const visual = await frame.evaluate((element) => {
      const world = element.closest('.canvas-world');
      if (!world) throw new Error('Thiếu khung Canvas.');
      const zoom = new DOMMatrixReadOnly(getComputedStyle(world).transform).a;
      return {
        outlineWidth: Number.parseFloat(getComputedStyle(element).outlineWidth) * zoom,
      };
    });
    expect(visual.outlineWidth).toBeGreaterThanOrEqual(3);
    await expect(frame.locator('iframe')).toHaveCSS('filter', 'none');
    await expect(frame.locator('iframe')).toHaveCSS('opacity', '1');
  }
});

test('kéo từ nội dung màn hình không làm trình duyệt tô màu preview', async ({ page }) => {
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await page.getByRole('button', { name: 'Vừa khung hình' }).click();
  const overview = page.locator('[data-screen-id="overview"]');
  const orders = page.locator('[data-screen-id="orders"]');
  await expect(overview).toBeVisible();
  await expect(orders).toBeVisible();
  await page.frameLocator('[data-screen-id="overview"] iframe').locator('body').waitFor();
  const start = await overview.boundingBox();
  const end = await orders.boundingBox();
  if (!start || !end) throw new Error('Không đo được khung màn hình.');
  const clip = { x: Math.round(start.x + 12), y: Math.round(start.y + 60), width: 4, height: 4 };
  const before = await page.screenshot({ clip });
  await page.mouse.move(start.x + start.width / 2, start.y + 100);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + 100, { steps: 12 });
  const during = await page.screenshot({ clip });
  await page.mouse.up();
  const after = await page.screenshot({ clip });
  expect(during.equals(before)).toBe(true);
  expect(after.equals(before)).toBe(true);
});

test('kéo vùng trên nền canvas chọn nhiều màn hình rồi di chuyển cùng nhau', async ({ page }) => {
  await page.goto(`${runtime.url}/?project=shop#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
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
  await expect(band).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(band).toHaveCSS('border-top-style', 'dashed');
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
