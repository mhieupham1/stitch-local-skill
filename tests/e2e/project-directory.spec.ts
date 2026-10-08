import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'playwright/test';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-canvas-directory-'));
  workspace = join(root, 'workspace');
  process.env.LOCAL_CANVAS_STATIC_DIR = resolve('packages/canvas/dist');
  runtime = await ensureServer(workspace);
  for (const [id, name, width] of [['alpha', 'Alpha', 800], ['beta', 'Beta', 390]] as const) {
    const post = (path: string, body: unknown) => fetch(`${runtime.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/api/projects', { id, name })).ok).toBe(true);
    expect((await post(`/api/projects/${id}/screens`, { id: 'home', name: `${name} Home`, width, height: 600, expectedRevision: 0 })).ok).toBe(true);
  }
});

test.afterAll(async () => {
  if (workspace) await stopServer(workspace).catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true });
  delete process.env.LOCAL_CANVAS_STATIC_DIR;
});

test('chọn server → danh sách → từng canvas, giữ phiên preview và tách trạng thái dự án', async ({ page }) => {
  await page.goto(runtime.url);
  await page.getByRole('button', { name: 'Dùng preview này' }).click();
  await expect(page.getByRole('heading', { name: 'Dự án của bạn' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Mở dự án Alpha' })).toContainText('1 màn hình');
  await expect(page.getByRole('link', { name: 'Mở dự án Beta' })).toContainText('beta');
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dự án của bạn' })).toBeVisible();
  await page.getByRole('link', { name: 'Mở dự án Alpha' }).click();
  await expect(page).toHaveURL(`${runtime.url}/?project=alpha`);
  await expect(page.getByLabel('Width')).toHaveValue('800');
  await expect(page.locator('.project-sidebar .project-button')).toHaveCount(1);
  await expect(page.locator('.project-sidebar')).not.toContainText('Beta');
  await page.getByRole('button', { name: 'Chỉnh sửa', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Thoát chỉnh sửa' })).toBeVisible();

  await page.getByRole('link', { name: 'Danh sách dự án', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dự án của bạn' })).toBeVisible();
  await page.getByRole('link', { name: 'Mở dự án Beta' }).click();
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeVisible();
  await expect(page.getByLabel('Width')).toHaveValue('390');
  await expect(page.getByRole('button', { name: 'Chỉnh sửa', exact: true })).toBeVisible();
  await expect(page.locator('iframe')).toHaveAttribute('src', /\/projects\/beta\//);
  await expect(page.getByRole('heading', { name: 'Chọn preview' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Dự án của bạn' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Đổi preview', exact: true }).click();
  await page.getByRole('button', { name: 'Dùng preview này' }).click();
  await expect(page.getByRole('heading', { name: 'Dự án của bạn' })).toBeVisible();
});

test('link dự án không tồn tại có lối về danh sách, không tự mở dự án khác', async ({ page }) => {
  await page.goto(`${runtime.url}/?project=missing#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await expect(page.getByRole('heading', { name: 'Không mở được dự án' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('link', { name: 'Về danh sách dự án' }).click();
  await expect(page.getByRole('link', { name: 'Mở dự án Alpha' })).toBeVisible();
});

test('danh sách báo lỗi tải và cho thử lại', async ({ page }) => {
  let blocked = true;
  await page.route(`${runtime.url}/api/projects`, (route) => blocked
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'UNAVAILABLE', message: 'Chưa tải được danh sách.' } }) })
    : route.continue());
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await expect(page.getByRole('alert')).toContainText('Chưa tải được danh sách.');
  await expect(page.getByRole('heading', { name: 'Chưa có dự án' })).toHaveCount(0);
  blocked = false;
  await page.getByRole('button', { name: 'Thử lại' }).click();
  await expect(page.getByRole('link', { name: 'Mở dự án Beta' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('tạo dự án từ tên tiếng Việt, mở canvas trống và tự tránh ID trùng', async ({ page }) => {
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Tạo dự án' });
  await expect(dialog.getByLabel('Tên dự án')).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Tạo dự án', exact: true })).toBeDisabled();
  await dialog.getByLabel('Tên dự án').fill('   ');
  await expect(dialog.getByRole('button', { name: 'Tạo dự án', exact: true })).toBeDisabled();
  await dialog.getByLabel('Tên dự án').fill('  Quản lý Đơn hàng  ');
  await expect(dialog.locator('code')).toHaveText('quan-ly-don-hang');
  await dialog.getByLabel('Tên dự án').press('Enter');
  await expect(page).toHaveURL(`${runtime.url}/?project=quan-ly-don-hang`);
  await expect(page.getByRole('heading', { name: 'Quản lý Đơn hàng', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Chưa có màn hình' })).toBeVisible();
  await expect(page.locator('.canvas-empty')).toContainText('quan-ly-don-hang');
  const created = (await (await fetch(`${runtime.url}/api/projects/quan-ly-don-hang`)).json()).data;
  expect(created).toMatchObject({ name: 'Quản lý Đơn hàng', screens: [] });
  await page.getByRole('link', { name: 'Danh sách dự án', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Mở dự án Quản lý Đơn hàng', exact: true })).toContainText('0 màn hình');
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
  await dialog.getByLabel('Tên dự án').fill('Quản lý Đơn hàng');
  await expect(dialog.locator('code')).toHaveText('quan-ly-don-hang-2');
  await dialog.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
  await expect(page).toHaveURL(`${runtime.url}/?project=quan-ly-don-hang-2`);
  expect((await (await fetch(`${runtime.url}/api/projects/quan-ly-don-hang`)).json()).data).toEqual(created);
});

test('hủy không tạo dự án; lỗi server giữ tên để thử lại và chỉ gửi một request đang xử lý', async ({ page }) => {
  let posts = 0;
  let releaseRequest!: () => void;
  const gate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route(`${runtime.url}/api/projects`, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    posts++;
    if (posts === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'UNAVAILABLE', message: 'Không kết nối được server.' } }) });
    } else { await gate; await route.continue(); }
  });
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  const open = page.getByRole('button', { name: 'Tạo dự án', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên dự án').fill('Sẽ hủy');
  await dialog.getByRole('button', { name: 'Hủy' }).click();
  await expect(dialog).toHaveCount(0);
  await open.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(posts).toBe(0);
  await open.click();
  await dialog.getByLabel('Tên dự án').fill('Thử lại');
  await dialog.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Không kết nối được server.');
  await expect(dialog.getByLabel('Tên dự án')).toHaveValue('Thử lại');
  await dialog.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Đang tạo…' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Hủy' })).toBeDisabled();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  expect(posts).toBe(2);
  releaseRequest();
  await expect(page).toHaveURL(`${runtime.url}/?project=thu-lai`);
  expect(posts).toBe(2);
});

test('ID bị client khác lấy sau khi tải danh sách vẫn tạo được dự án với ID mới', async ({ page }) => {
  const submittedIds: string[] = [];
  await page.route(`${runtime.url}/api/projects`, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    submittedIds.push(route.request().postDataJSON().id);
    if (submittedIds.length === 1) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'PROJECT_EXISTS', message: 'ID đã tồn tại.' } }) });
    } else { await route.continue(); }
  });
  await page.goto(`${runtime.url}/#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên dự án').fill('Dự án đồng thời');
  await dialog.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
  await expect(page).toHaveURL(`${runtime.url}/?project=du-an-dong-thoi-2`);
  expect(submittedIds).toEqual(['du-an-dong-thoi', 'du-an-dong-thoi-2']);
  await expect(page.getByRole('heading', { name: 'Chưa có màn hình' })).toBeVisible();
});
