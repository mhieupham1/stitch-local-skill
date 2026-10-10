import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureServer, stopServer, type RuntimeInfo } from '../../packages/server/src/lifecycle.js';

let root: string;
let workspace: string;
let runtime: RuntimeInfo;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${runtime.url}${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
}

const DESIGN_SYSTEM = `:root {
  --ink: #111111;
  --paper: #ffffff;
  --gap-sm: 8px;
  --gap-lg: 16px;
  --font-body: "Inter", sans-serif;
  --unused: #abcdef;
}
`;

/** Writes a screen whose files replace the ones `screen add` scaffolded. */
async function writeScreen(id: string, html: string, css: string): Promise<void> {
  const directory = join(workspace, 'projects', 'shop', 'screens', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'index.html'), html);
  await writeFile(join(directory, 'styles.css'), css);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local canvas audit '));
  workspace = join(root, 'workspace');
  runtime = await ensureServer(workspace);
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'shop', name: 'Shop' }) });
  await api('/api/projects/shop/screens', { method: 'POST', body: JSON.stringify({ id: 'home', name: 'Home', width: 800, height: 600, expectedRevision: 0 }) });
  await writeFile(join(workspace, 'projects', 'shop', 'design-system.css'), DESIGN_SYSTEM);
});

afterEach(async () => {
  await stopServer(workspace).catch(() => undefined);
  await rm(root, { force: true, recursive: true });
});

describe('GET /api/projects/:projectId/token-audit', () => {
  it('liệt kê token và không báo lỗi khi màn hình dùng đúng token', async () => {
    await writeScreen('home', '<!doctype html><html><body><main>x</main></body></html>', `.card {
  color: var(--ink);
  background: var(--paper);
  padding: var(--gap-lg);
  font-family: var(--font-body);
}
`);

    const report = await (await api('/api/projects/shop/token-audit')).json() as { data: { findings: { kind: string }[]; tokens: { name: string }[]; summary: { errors: number } } };

    expect(report.data.summary.errors).toBe(0);
    expect(report.data.findings.filter((finding) => finding.kind === 'hardcoded-color')).toEqual([]);
    expect(report.data.findings.filter((finding) => finding.kind === 'hardcoded-font')).toEqual([]);
    expect(report.data.tokens.map((token) => token.name)).toContain('--ink');
  });

  it('báo màu cứng, font cứng và tham chiếu hỏng kèm số dòng', async () => {
    await writeScreen('home', '<!doctype html><html><body><main>x</main></body></html>', `.a {
  color: #111111;
}
.b {
  font-family: Georgia, serif;
}
.c {
  color: var(--khong-ton-tai);
}
`);

    const report = await (await api('/api/projects/shop/token-audit')).json() as { data: { findings: { kind: string; file: string; line: number; message: string }[]; summary: { errors: number; warnings: number } } };

    const byKind = (kind: string) => report.data.findings.filter((finding) => finding.kind === kind);
    // `#111111` is exactly what `--ink` holds, so the message can name the token to use.
    expect(byKind('hardcoded-color')).toMatchObject([{ file: 'screens/home/styles.css', line: 2, message: expect.stringContaining('--ink') }]);
    expect(byKind('hardcoded-font')).toMatchObject([{ file: 'screens/home/styles.css', line: 5 }]);
    expect(byKind('broken-reference')).toMatchObject([{ line: 8, message: expect.stringContaining('--khong-ton-tai') }]);
    expect(report.data.summary.errors).toBe(1);
  });

  it('chỉ báo tham chiếu có dự phòng ở mức warning', async () => {
    await writeScreen('home', '<!doctype html><html><body><main>x</main></body></html>', `.a { color: var(--thieu, #000); }
`);

    const report = await (await api('/api/projects/shop/token-audit')).json() as { data: { findings: { kind: string; severity: string }[]; summary: { errors: number; warnings: number } } };

    expect(report.data.findings.filter((finding) => finding.kind === 'broken-reference')).toMatchObject([{ severity: 'warning' }]);
    expect(report.data.summary.errors).toBe(0);
  });

  it('báo khoảng cách lệch thang và token không ai dùng', async () => {
    await writeScreen('home', '<!doctype html><html><body><main>x</main></body></html>', `.a { padding: 13px; margin-top: 8px; }
`);

    const report = await (await api('/api/projects/shop/token-audit')).json() as { data: { findings: { kind: string; value: string }[] } };

    expect(report.data.findings.filter((finding) => finding.kind === 'off-scale-spacing')).toMatchObject([{ value: '13px' }]);
    expect(report.data.findings.filter((finding) => finding.kind === 'unused-token').map((finding) => finding.value)).toContain('--unused');
  });

  it('không báo màu cứng cho giá trị nằm trong comment', async () => {
    await writeScreen('home', '<!doctype html><html><body><main>x</main></body></html>', `/* color: #ff0000; */
.a { color: var(--ink); }
`);

    const report = await (await api('/api/projects/shop/token-audit')).json() as { data: { findings: { kind: string }[] } };

    expect(report.data.findings.filter((finding) => finding.kind === 'hardcoded-color')).toEqual([]);
  });

  it('trả 404 cho project không tồn tại', async () => {
    const response = await api('/api/projects/khong-co/token-audit');
    expect(response.status).toBe(404);
  });
});
