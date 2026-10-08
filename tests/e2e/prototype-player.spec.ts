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

async function api(path: string, init: RequestInit = {}) {
  return fetch(`${runtime.url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
}

async function cli(...args: string[]) {
  const result = await execute(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('packages/cli/src/index.ts'), ...args, '--workspace', workspace, '--json']);
  return JSON.parse(result.stdout) as { ok: boolean; data?: { id: string }; error?: { code: string } };
}

const home = (id = 'home-open') => `<!doctype html><html><body><h1>Home</h1><button data-design-id="${id}"><span>Open detail</span></button><a href="/elsewhere">Other link</a></body></html>`;
const detail = '<!doctype html><html><body><h1>Detail</h1><button data-design-id="detail-seat"><span>Choose seat</span></button></body></html>';
const seat = '<!doctype html><html><body><h1>Seat</h1></body></html>';

test.beforeAll(async () => {
  await execute(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', resolve('packages/canvas/vite.config.ts')]);
  root = await mkdtemp(join(tmpdir(), 'local-prototype-e2e-'));
  workspace = join(root, 'workspace');
  process.env.LOCAL_CANVAS_STATIC_DIR = resolve('packages/canvas/dist');
  runtime = await ensureServer(workspace);
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
  for (const [index, id] of ['home', 'detail', 'seat'].entries()) {
    const response = await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id, name: id, width: id === 'home' ? 390 : 800, height: 600, expectedRevision: index }) });
    expect(response.ok).toBe(true);
    await writeFile(join(workspace, 'projects', 'shop', 'screens', id, 'index.html'), id === 'home' ? home() : id === 'detail' ? detail : seat);
  }
  const sources = (await (await api('/api/projects/shop/prototype-sources?screenIds=home,detail,seat')).json()).data;
  const projectBefore = await readFile(join(workspace, 'projects', 'shop', 'project.json'), 'utf8');
  const inputPath = join(root, 'prototype-create.json');
  await writeFile(inputPath, JSON.stringify({
    id: 'booking', name: 'Booking', screenIds: ['home', 'detail', 'seat'], startScreenId: 'home',
    transitions: [
      { fromScreenId: 'home', elementId: 'home-open', toScreenId: 'detail' },
      { fromScreenId: 'detail', elementId: 'detail-seat', toScreenId: 'seat' },
    ], expectedSourceBaseline: sources,
  }));
  expect(await cli('prototype', 'create', 'booking', '--project', 'shop', '--input', inputPath)).toMatchObject({ ok: true, data: { id: 'booking' } });
  expect(await readFile(join(workspace, 'projects', 'shop', 'project.json'), 'utf8')).toBe(projectBefore);
});

test.afterAll(async () => {
  if (workspace) await stopServer(workspace).catch(() => undefined);
  if (root) await rm(root, { force: true, recursive: true });
  delete process.env.LOCAL_CANVAS_STATIC_DIR;
});

test('Play chuyển màn qua phần tử con, giữ lịch sử và tạo lại có chủ đích', async ({ page }) => {
  await page.goto(`${runtime.url}/?prototypeProject=shop&prototypeId=booking`);
  await expect(page.getByRole('heading', { name: 'Booking' })).toBeVisible();
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveAttribute('data-ready', 'true');
  await expect(frame.locator('[data-design-id="home-open"]')).toHaveCSS('outline-style', 'solid');
  await expect(frame.getByRole('link', { name: 'Other link' })).toHaveCSS('outline-style', 'none');
  expect(Math.round((await page.locator('iframe').boundingBox())?.width ?? 0)).toBe(390);
  await frame.getByRole('link', { name: 'Other link' }).click();
  await expect(frame.getByRole('heading', { name: 'Home' })).toBeVisible();
  await frame.getByText('Open detail').click();
  await expect(frame.getByRole('heading', { name: 'Detail' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveAttribute('data-ready', 'true');
  await expect(frame.locator('[data-design-id="detail-seat"]')).toHaveCSS('outline-style', 'solid');
  await frame.getByText('Choose seat').click();
  await expect(frame.getByRole('heading', { name: 'Seat' })).toBeVisible();
  await page.getByRole('button', { name: 'Quay lại' }).click();
  await expect(frame.getByRole('heading', { name: 'Detail' })).toBeVisible();
  await page.getByRole('button', { name: 'Chạy lại' }).click();
  await expect(frame.getByRole('heading', { name: 'Home' })).toBeVisible();
  await page.evaluate(() => window.postMessage({ source: 'local-design-canvas', kind: 'prototype.click', projectId: 'shop', screenId: 'home', elementId: 'home-open' }, '*'));
  await expect(frame.getByRole('heading', { name: 'Home' })).toBeVisible();

  await writeFile(join(workspace, 'projects', 'shop', 'screens', 'home', 'index.html'), home('home-new'));
  await expect(page.getByText('Cần tạo lại')).toBeVisible();
  await expect(page.getByText('Không tìm thấy điểm bấm: home-open', { exact: false })).toBeVisible();
  await frame.getByText('Open detail').click();
  await expect(frame.getByRole('heading', { name: 'Home' })).toBeVisible();

  const prior = (await (await api('/api/projects/shop/prototypes/booking')).json()).data;
  const sources = (await (await api('/api/projects/shop/prototype-sources?screenIds=home,detail,seat')).json()).data;
  const inputPath = join(root, 'prototype-regenerate.json');
  await writeFile(inputPath, JSON.stringify({
    expectedRevision: prior.revision, screenIds: prior.screenIds, startScreenId: 'home',
    transitions: [{ fromScreenId: 'home', elementId: 'home-new', toScreenId: 'detail' }, { fromScreenId: 'detail', elementId: 'detail-seat', toScreenId: 'seat' }],
    expectedSourceBaseline: sources,
  }));
  expect(await cli('prototype', 'regenerate', 'booking', '--project', 'shop', '--input', inputPath)).toMatchObject({ ok: true, data: { id: 'booking' } });
  await expect(page.getByText('Cần tạo lại')).toHaveCount(0);
  await frame.getByText('Open detail').click();
  await expect(frame.getByRole('heading', { name: 'Detail' })).toBeVisible();
  await page.reload();
  await expect(frame.getByRole('heading', { name: 'Home' })).toBeVisible();
  await frame.getByText('Open detail').click();
  await expect(frame.getByRole('heading', { name: 'Detail' })).toBeVisible();
  const project = (await (await api('/api/projects/shop')).json()).data;
  const removed = await api('/api/projects/shop/screens', { method: 'DELETE', body: JSON.stringify({ screenIds: ['seat'], expectedRevision: project.revision }) });
  expect(removed.ok).toBe(true);
  await expect(page.getByText('Cần tạo lại')).toBeVisible();
  await frame.getByText('Choose seat').click();
  await expect(page.getByRole('alert')).toContainText('không còn tồn tại');
  await expect(frame.getByRole('heading', { name: 'Detail' })).toBeVisible();
});

test('Play báo lỗi preview không bắt tay và cho tải lại iframe', async ({ page }) => {
  await page.route(`${runtime.previewUrl}/projects/shop/screens/home/index.html?*`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Preview tạm hỏng</h1>' }));
  await page.goto(`${runtime.url}/?prototypeProject=shop&prototypeId=booking`);
  await expect(page.getByRole('alert')).toContainText('Preview không phản hồi', { timeout: 12_000 });
  await page.unroute(`${runtime.previewUrl}/projects/shop/screens/home/index.html?*`);
  await page.getByRole('button', { name: 'Tải lại' }).click();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveAttribute('data-ready', 'true');
});

test('Về Canvas từ tab Play giữ preview đang chạy mà không cần chọn lại', async ({ page }) => {
  await page.goto(`${runtime.url}/?prototypeProject=shop&prototypeId=booking`);
  await expect(page.getByRole('heading', { name: 'Booking' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('local-canvas-preview-url'))).toBeNull();

  await page.getByRole('link', { name: 'Về Canvas' }).click();

  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Chọn preview' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('local-canvas-preview-url'))).toBe(runtime.previewUrl);
  expect(page.url()).toBe(`${runtime.url}/?project=shop`);
});
