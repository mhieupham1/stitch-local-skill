import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'playwright/test';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

async function api(path: string, init: RequestInit = {}) {
  return fetch(`${runtime.url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
}

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-canvas-isolation-'));
  workspace = join(root, 'workspace');
  process.env.LOCAL_CANVAS_STATIC_DIR = resolve('packages/canvas/dist');
  const publicRuntime = await ensureServer(workspace);
  runtime = publicRuntime;
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'isolation', name: 'Isolation' }) });
  await api('/api/projects/isolation/screens', {
    method: 'POST', body: JSON.stringify({ id: 'demo', name: 'Demo', width: 800, height: 600, expectedRevision: 0 }),
  });
  const fixture = (await readFile(resolve('tests/fixtures/preview-isolation.html'), 'utf8')).replaceAll('__MANAGEMENT_ORIGIN__', runtime.url);
  await writeFile(join(workspace, 'projects', 'isolation', 'screens', 'demo', 'index.html'), fixture);
});

test.afterAll(async () => {
  if (workspace) await stopServer(workspace).catch(() => undefined);
  if (root) await rm(root, { force: true, recursive: true });
  delete process.env.LOCAL_CANVAS_STATIC_DIR;
});

test('preview sandbox cô lập app shell và chặn ghi API, nhưng vẫn cho thử nội dung riêng', async ({ page }) => {
  const previewResponse = await page.request.get(`${runtime.previewUrl}/projects/isolation/screens/demo/index.html`);
  expect(previewResponse.headers()['content-security-policy']).toContain('sandbox allow-scripts');

  await page.goto(`${runtime.url}/?project=isolation#previewUrl=${encodeURIComponent(runtime.previewUrl)}`);
  await expect(page.locator('[data-screen-id="demo"] iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
  await expect(page.locator('[data-screen-id="demo"] iframe')).toHaveCSS('pointer-events', 'none');

  const previewHost = await page.context().newPage();
  await previewHost.setContent(`<iframe title="Preview test" sandbox="allow-scripts allow-same-origin" src="${runtime.previewUrl}/projects/isolation/screens/demo/index.html" style="width:800px;height:600px"></iframe>`);
  const frame = previewHost.frameLocator('iframe');
  await expect(frame.getByText('Parent DOM: blocked')).toBeVisible();
  await expect(frame.getByText('Popup: blocked')).toBeVisible();
  await expect(frame.getByText('Api: rejected')).toBeVisible();
  await frame.getByRole('button', { name: 'Tăng' }).click();
  await expect(frame.getByText('Giá trị: 1')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Isolation' })).toBeVisible();
  await previewHost.close();

  const projects = await api('/api/projects');
  expect((await projects.json()) as { ok: true; data: unknown[] }).toMatchObject({ ok: true, data: [{ id: 'isolation' }] });
});
