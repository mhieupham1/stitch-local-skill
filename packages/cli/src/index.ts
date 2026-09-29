#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';
import { asCanvasError, type Project, type Result } from '../../core/src/schema.js';
import { ensureServer, getServerStatus, stopServer, type RuntimeInfo } from '../../server/src/lifecycle.js';
import { managementRequest } from './client.js';

type Parsed = {
  positionals: string[];
  workspace: string;
  json: boolean;
  open: boolean;
  port?: number;
  options: Map<string, string>;
};

function parseArguments(argv: string[]): Parsed {
  const parsed: Parsed = { positionals: [], workspace: cwd(), json: false, open: false, options: new Map() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--workspace') parsed.workspace = argv[++index] ?? '';
    else if (argument === '--json') parsed.json = true;
    else if (argument === '--open') parsed.open = true;
    else if (argument === '--port') parsed.port = Number(argv[++index]);
    else if (argument.startsWith('--')) parsed.options.set(argument, argv[++index] ?? '');
    else parsed.positionals.push(argument);
  }
  return parsed;
}

function option(parsed: Parsed, name: string): string {
  const value = parsed.options.get(name);
  if (!value) throw new Error(`Thiếu ${name}.`);
  return value;
}

function integerOption(parsed: Parsed, name: string): number {
  const value = Number(option(parsed, name));
  if (!Number.isInteger(value)) throw new Error(`${name} phải là số nguyên.`);
  return value;
}

function writeResult<T>(result: Result<T>, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.ok) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
  else process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
}

function openBrowser(url: string): void {
  if (process.platform !== 'darwin') return;
  const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function canvasOpenUrl(runtime: RuntimeInfo): string {
  const url = new URL(runtime.url);
  url.hash = new URLSearchParams({ previewUrl: runtime.previewUrl }).toString();
  return url.toString();
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArguments(argv);
  const [command, action, id] = args.positionals;
  try {
    if (command === 'start') {
      const runtime = await ensureServer(args.workspace, { managementPort: args.port });
      if (args.open) openBrowser(canvasOpenUrl(runtime));
      writeResult({ ok: true, data: runtime }, args.json);
      return 0;
    }
    if (command === 'status') {
      const runtime = await getServerStatus(args.workspace);
      writeResult({ ok: true, data: { running: runtime !== null, runtime } }, args.json);
      return 0;
    }
    if (command === 'stop') {
      await stopServer(args.workspace);
      writeResult({ ok: true, data: { stopped: true } }, args.json);
      return 0;
    }
    if (command === 'project' && action === 'create' && id) {
      const result = await managementRequest(args.workspace, '/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name: option(args, '--name') }),
      });
      writeResult({ ok: true, data: result }, args.json);
      return 0;
    }
    if (command === 'project' && action === 'list') {
      writeResult({ ok: true, data: await managementRequest(args.workspace, '/api/projects') }, args.json);
      return 0;
    }
    if (command === 'screen' && action === 'list') {
      const project = await managementRequest<Project>(args.workspace, `/api/projects/${encodeURIComponent(option(args, '--project'))}`);
      writeResult({ ok: true, data: project.screens }, args.json);
      return 0;
    }
    if (command === 'screen' && action === 'add' && id) {
      const projectId = option(args, '--project');
      const project = await managementRequest<Project>(args.workspace, `/api/projects/${encodeURIComponent(projectId)}`);
      const result = await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(projectId)}/screens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          name: option(args, '--name'),
          width: integerOption(args, '--width'),
          height: integerOption(args, '--height'),
          expectedRevision: project.revision,
        }),
      });
      writeResult({ ok: true, data: result }, args.json);
      return 0;
    }
    if (command === 'screen' && action === 'update' && id) {
      const projectId = option(args, '--project');
      const project = await managementRequest<Project>(args.workspace, `/api/projects/${encodeURIComponent(projectId)}`);
      const patch: Record<string, number | string> = { id };
      for (const name of ['--x', '--y', '--width', '--height']) {
        if (args.options.has(name)) patch[name.slice(2)] = integerOption(args, name);
      }
      if (Object.keys(patch).length === 1) throw new Error('Cần ít nhất một thuộc tính layout để cập nhật.');
      const result = await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(projectId)}/layout`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patches: [patch], expectedRevision: project.revision }),
      });
      writeResult({ ok: true, data: result }, args.json);
      return 0;
    }
    if (command === 'screen' && action === 'focus') {
      const result = await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(option(args, '--project'))}/focus`);
      writeResult({ ok: true, data: result }, args.json);
      return 0;
    }
    if (command === 'screen' && action === 'edit' && id === 'start') {
      const projectId = option(args, '--project');
      const body: Record<string, string> = {};
      if (args.options.has('--screen')) body.screenId = option(args, '--screen');
      if (args.options.has('--message')) body.message = option(args, '--message');
      const result = await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(projectId)}/editing`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      writeResult({ ok: true, data: result }, args.json);
      return 0;
    }
    if (command === 'screen' && action === 'edit' && id === 'done') {
      const projectId = option(args, '--project');
      const result = await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(projectId)}/editing`, { method: 'DELETE' });
      writeResult({ ok: true, data: result }, args.json);
      return 0;
    }
    if (command === 'screen' && action === 'duplicate' && id) {
      const projectId = option(args, '--project');
      const result = await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(projectId)}/screens/${encodeURIComponent(id)}/duplicate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newId: option(args, '--new-id') }) });
      writeResult({ ok: true, data: result }, args.json);
      return 0;
    }
    if (command === 'prototype') {
      const projectId = option(args, '--project');
      const base = `/api/projects/${encodeURIComponent(projectId)}/prototypes`;
      if (action === 'sources') {
        const screens = option(args, '--screens');
        writeResult({ ok: true, data: await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(projectId)}/prototype-sources?screenIds=${encodeURIComponent(screens)}`) }, args.json);
        return 0;
      }
      if (action === 'list') { writeResult({ ok: true, data: await managementRequest(args.workspace, base) }, args.json); return 0; }
      if (action === 'get' && id) { writeResult({ ok: true, data: await managementRequest(args.workspace, `${base}/${encodeURIComponent(id)}`) }, args.json); return 0; }
      if (action === 'delete' && id) {
        const data = await managementRequest(args.workspace, `${base}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: integerOption(args, '--revision') }) });
        writeResult({ ok: true, data }, args.json);
        return 0;
      }
      if (['create', 'update', 'regenerate'].includes(action ?? '') && id) {
        const input = JSON.parse(await readFile(option(args, '--input'), 'utf8')) as Record<string, unknown>;
        if (action === 'create' && input.id !== id) throw new Error('ID trong file input phải trùng ID lệnh tạo prototype.');
        const path = action === 'create' ? base : `${base}/${encodeURIComponent(id)}${action === 'regenerate' ? '/regenerate' : ''}`;
        const method = action === 'update' ? 'PATCH' : 'POST';
        const data = await managementRequest(args.workspace, path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
        writeResult({ ok: true, data }, args.json);
        return 0;
      }
    }
    if (command === 'screenshot' && action) {
      const projectId = option(args, '--project');
      const result = await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(projectId)}/screens/${encodeURIComponent(action)}/capture`, { method: 'POST' });
      writeResult({ ok: true, data: result }, args.json);
      return 0;
    }
    if (command === 'snapshot' && action === 'create') { const result = await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(option(args, '--project'))}/snapshots`, { method: 'POST' }); writeResult({ ok: true, data: result }, args.json); return 0; }
    if (command === 'snapshot' && action === 'restore' && id) { const projectId = option(args, '--project'); const result = await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(id)}/restore`, { method: 'POST' }); writeResult({ ok: true, data: result }, args.json); return 0; }
    if (command === 'selection' && action === 'get') {
      const result = await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(option(args, '--project'))}/selection`);
      writeResult({ ok: true, data: result }, args.json);
      return 0;
    }
    if (command === 'reference' && action === 'fetch' && id) {
      const result = await managementRequest(args.workspace, `/api/projects/${encodeURIComponent(option(args, '--project'))}/reference`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: id }) });
      writeResult({ ok: true, data: result }, args.json);
      return 0;
    }
    if (command === 'mcp' && action === 'serve') {
      const { serveMcp } = await import('../../mcp/src/index.js');
      await serveMcp(args.workspace);
      return 0;
    }
    throw new Error('Lệnh hợp lệ: start, status, stop, project create/list, screen add/list/update/duplicate/focus/edit start|done, prototype sources/list/get/create/update/regenerate/delete, screenshot, snapshot create/restore, selection get, reference fetch <url>, mcp serve.');
  } catch (error) {
    const canvasError = asCanvasError(error);
    writeResult({ ok: false, error: { code: canvasError.code, message: canvasError.message } }, args.json);
    return 1;
  }
}

const invokedFile = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
if (import.meta.url === invokedFile) {
  process.exitCode = await run(process.argv.slice(2));
}
