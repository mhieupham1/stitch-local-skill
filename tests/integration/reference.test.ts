import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchReference } from '../../packages/server/src/reference.js';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

const fixture = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Trang tham chiếu</title></head>
<body><main><h1>Tiêu đề chính</h1><section><h2>Phần một</h2><p>Đoạn nội dung đủ dài để được thu thập làm tham chiếu thiết kế.</p></section>
<a href="https://example.com/lien-ket">Liên kết mẫu</a></main></body></html>`;

async function pngSize(path: string): Promise<{ width: number; height: number }> {
  const image = await readFile(path);
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-canvas-reference-'));
  workspace = join(root, 'workspace');
  runtime = await ensureServer(workspace);
  const request = (path: string, body: unknown) => fetch(`${runtime.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await request('/api/projects', { id: 'shop', name: 'Shop' });
  await request('/api/projects/shop/screens', { id: 'ref', name: 'Ref', width: 800, height: 600, expectedRevision: 0 });
  await writeFile(join(workspace, 'projects', 'shop', 'screens', 'ref', 'index.html'), fixture);
});

afterEach(async () => { await stopServer(workspace).catch(() => undefined); await rm(root, { force: true, recursive: true }); });

describe('reference fetch', () => {
  it('trích tiêu đề, heading, section, link và lưu ảnh full-page', async () => {
    const url = `${runtime.previewUrl}/projects/shop/screens/ref/index.html`;
    const result = await fetchReference(workspace, 'shop', url);

    expect(result.title).toBe('Trang tham chiếu');
    expect(result.headings.map((heading) => heading.text)).toEqual(expect.arrayContaining(['Tiêu đề chính', 'Phần một']));
    expect(result.sections.join(' ')).toContain('Đoạn nội dung đủ dài');
    expect(result.links.some((link) => link.href.includes('example.com'))).toBe(true);

    await expect(access(result.imagePath)).resolves.toBeUndefined();
    await expect(access(result.dataPath)).resolves.toBeUndefined();
    const size = await pngSize(result.imagePath);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  }, 20_000);

  it('từ chối URL không phải http/https', async () => {
    await expect(fetchReference(workspace, 'shop', 'file:///etc/hosts')).rejects.toMatchObject({ code: 'INVALID_URL' });
  });
});
