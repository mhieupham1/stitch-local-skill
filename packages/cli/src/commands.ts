import { readFile } from 'node:fs/promises';
import type { Project } from '../../core/src/schema.js';
import { ensureServer, getServerStatus, stopServer, type RuntimeInfo } from '../../server/src/lifecycle.js';
import { managementRequest } from './client.js';
import { integerOption, option, type Parsed } from './args.js';

export type CommandContext = {
  args: Parsed;
  /** Positional words left after the ones that selected this command. */
  rest: string[];
};

/**
 * One CLI command. `words` selects it (longest prefix wins), `route` names the
 * management API endpoint it drives so the parity test can prove every
 * agent-relevant route has a CLI entry, and `run` returns the payload to print.
 */
export type CommandSpec = {
  words: string[];
  route: string | null;
  run: (context: CommandContext) => Promise<unknown>;
};

const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

const jsonRequest = (workspace: string, path: string, method: string, body: unknown) =>
  managementRequest(workspace, path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Whole-project writes carry the revision the CLI last read so a concurrent
// canvas edit is rejected instead of silently overwritten.
const currentRevision = async (workspace: string, projectId: string): Promise<number> =>
  (await managementRequest<Project>(workspace, projectPath(projectId))).revision;

export const COMMANDS: CommandSpec[] = [
  {
    words: ['start'],
    route: null,
    run: async ({ args }) => {
      const runtime = await ensureServer(args.workspace, { managementPort: args.port });
      if (args.open) {
        const url = new URL(runtime.url);
        url.hash = new URLSearchParams({ previewUrl: runtime.previewUrl }).toString();
        const { spawn } = await import('node:child_process');
        if (process.platform === 'darwin') {
          const child = spawn('open', [url.toString()], { detached: true, stdio: 'ignore' });
          child.unref();
        }
      }
      return runtime;
    },
  },
  {
    words: ['status'],
    route: null,
    run: async ({ args }) => {
      const runtime = await getServerStatus(args.workspace);
      return { running: runtime !== null, runtime };
    },
  },
  {
    words: ['stop'],
    route: null,
    run: async ({ args }) => {
      await stopServer(args.workspace);
      return { stopped: true };
    },
  },
  {
    words: ['project', 'create'],
    route: 'POST /api/projects',
    run: async ({ args, rest }) => {
      const [id] = rest;
      if (!id) throw new Error('Thiếu ID project.');
      return jsonRequest(args.workspace, '/api/projects', 'POST', { id, name: option(args, '--name') });
    },
  },
  {
    words: ['project', 'list'],
    route: 'GET /api/projects',
    run: async ({ args }) => managementRequest(args.workspace, '/api/projects'),
  },
  {
    words: ['project', 'rename'],
    route: 'PATCH /api/projects/:projectId',
    run: async ({ args, rest }) => {
      const [id] = rest;
      if (!id) throw new Error('Thiếu ID project.');
      return jsonRequest(args.workspace, projectPath(id), 'PATCH', { name: option(args, '--name'), expectedRevision: await currentRevision(args.workspace, id) });
    },
  },
  {
    words: ['screen', 'list'],
    route: 'GET /api/projects/:projectId',
    run: async ({ args }) => {
      const project = await managementRequest<Project>(args.workspace, projectPath(option(args, '--project')));
      return project.screens;
    },
  },
  {
    words: ['screen', 'add'],
    route: 'POST /api/projects/:projectId/screens',
    run: async ({ args, rest }) => {
      const [id] = rest;
      if (!id) throw new Error('Thiếu ID màn hình.');
      const projectId = option(args, '--project');
      return jsonRequest(args.workspace, `${projectPath(projectId)}/screens`, 'POST', {
        id,
        name: option(args, '--name'),
        width: integerOption(args, '--width'),
        height: integerOption(args, '--height'),
        expectedRevision: await currentRevision(args.workspace, projectId),
      });
    },
  },
  {
    words: ['screen', 'update'],
    route: 'PATCH /api/projects/:projectId/layout',
    run: async ({ args, rest }) => {
      const [id] = rest;
      if (!id) throw new Error('Thiếu ID màn hình.');
      const projectId = option(args, '--project');
      const patch: Record<string, number | string> = { id };
      for (const name of ['--x', '--y', '--width', '--height']) {
        if (args.options.has(name)) patch[name.slice(2)] = integerOption(args, name);
      }
      if (Object.keys(patch).length === 1) throw new Error('Cần ít nhất một thuộc tính layout để cập nhật.');
      return jsonRequest(args.workspace, `${projectPath(projectId)}/layout`, 'PATCH', {
        patches: [patch],
        expectedRevision: await currentRevision(args.workspace, projectId),
      });
    },
  },
  {
    words: ['screen', 'duplicate'],
    route: 'POST /api/projects/:projectId/screens/:screenId/duplicate',
    run: async ({ args, rest }) => {
      const [id] = rest;
      if (!id) throw new Error('Thiếu ID màn hình.');
      const projectId = option(args, '--project');
      return jsonRequest(args.workspace, `${projectPath(projectId)}/screens/${encodeURIComponent(id)}/duplicate`, 'POST', { newId: option(args, '--new-id') });
    },
  },
  {
    words: ['screen', 'delete'],
    route: 'DELETE /api/projects/:projectId/screens',
    run: async ({ args, rest }) => {
      if (rest.length === 0) throw new Error('Cần ít nhất một ID màn hình để xóa.');
      const projectId = option(args, '--project');
      return jsonRequest(args.workspace, `${projectPath(projectId)}/screens`, 'DELETE', {
        screenIds: rest,
        expectedRevision: await currentRevision(args.workspace, projectId),
      });
    },
  },
  {
    words: ['screen', 'order'],
    route: 'PATCH /api/projects/:projectId/screen-order',
    run: async ({ args, rest }) => {
      if (rest.length === 0) throw new Error('Cần liệt kê đủ ID màn hình theo thứ tự layer mong muốn.');
      const projectId = option(args, '--project');
      return jsonRequest(args.workspace, `${projectPath(projectId)}/screen-order`, 'PATCH', {
        order: rest,
        expectedRevision: await currentRevision(args.workspace, projectId),
      });
    },
  },
  {
    words: ['screen', 'focus'],
    route: 'GET /api/projects/:projectId/focus',
    run: async ({ args }) => managementRequest(args.workspace, `${projectPath(option(args, '--project'))}/focus`),
  },
  {
    words: ['screen', 'edit', 'start'],
    route: 'PUT /api/projects/:projectId/editing',
    run: async ({ args }) => {
      const body: Record<string, string> = {};
      if (args.options.has('--screen')) body.screenId = option(args, '--screen');
      if (args.options.has('--message')) body.message = option(args, '--message');
      return jsonRequest(args.workspace, `${projectPath(option(args, '--project'))}/editing`, 'PUT', body);
    },
  },
  {
    words: ['screen', 'edit', 'done'],
    route: 'DELETE /api/projects/:projectId/editing',
    run: async ({ args }) => managementRequest(args.workspace, `${projectPath(option(args, '--project'))}/editing`, { method: 'DELETE' }),
  },
  {
    words: ['screen', 'edit', 'status'],
    route: 'GET /api/projects/:projectId/editing',
    run: async ({ args }) => managementRequest(args.workspace, `${projectPath(option(args, '--project'))}/editing`),
  },
  {
    words: ['screenshot'],
    route: 'POST /api/projects/:projectId/screens/:screenId/capture',
    run: async ({ args, rest }) => {
      const [screenId] = rest;
      if (!screenId) throw new Error('Thiếu ID màn hình.');
      const projectId = option(args, '--project');
      return managementRequest(args.workspace, `${projectPath(projectId)}/screens/${encodeURIComponent(screenId)}/capture`, { method: 'POST' });
    },
  },
  {
    words: ['figma', 'export'],
    route: 'POST /api/projects/:projectId/screens/:screenId/figma',
    run: async ({ args, rest }) => {
      const [screenId] = rest;
      if (!screenId) throw new Error('Thiếu ID màn hình.');
      const projectId = option(args, '--project');
      return managementRequest(args.workspace, `${projectPath(projectId)}/screens/${encodeURIComponent(screenId)}/figma`, { method: 'POST' });
    },
  },
  {
    words: ['snapshot', 'create'],
    route: 'POST /api/projects/:projectId/snapshots',
    run: async ({ args }) => managementRequest(args.workspace, `${projectPath(option(args, '--project'))}/snapshots`, { method: 'POST' }),
  },
  {
    words: ['snapshot', 'restore'],
    route: 'POST /api/projects/:projectId/snapshots/:snapshotId/restore',
    run: async ({ args, rest }) => {
      const [snapshotId] = rest;
      if (!snapshotId) throw new Error('Thiếu ID snapshot.');
      const projectId = option(args, '--project');
      return managementRequest(args.workspace, `${projectPath(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`, { method: 'POST' });
    },
  },
  {
    words: ['selection', 'get'],
    route: 'GET /api/projects/:projectId/selection',
    run: async ({ args }) => managementRequest(args.workspace, `${projectPath(option(args, '--project'))}/selection`),
  },
  {
    words: ['reference', 'fetch'],
    route: 'POST /api/projects/:projectId/reference',
    run: async ({ args, rest }) => {
      const [url] = rest;
      if (!url) throw new Error('Thiếu URL tham chiếu.');
      return jsonRequest(args.workspace, `${projectPath(option(args, '--project'))}/reference`, 'POST', { url });
    },
  },
  {
    words: ['prototype', 'sources'],
    route: 'GET /api/projects/:projectId/prototype-sources',
    run: async ({ args }) => {
      const projectId = option(args, '--project');
      const screens = option(args, '--screens');
      return managementRequest(args.workspace, `${projectPath(projectId)}/prototype-sources?screenIds=${encodeURIComponent(screens)}`);
    },
  },
  {
    words: ['prototype', 'list'],
    route: 'GET /api/projects/:projectId/prototypes',
    run: async ({ args }) => managementRequest(args.workspace, `${projectPath(option(args, '--project'))}/prototypes`),
  },
  {
    words: ['prototype', 'get'],
    route: 'GET /api/projects/:projectId/prototypes/:prototypeId',
    run: async ({ args, rest }) => {
      const [id] = rest;
      if (!id) throw new Error('Thiếu ID prototype.');
      const projectId = option(args, '--project');
      return managementRequest(args.workspace, `${projectPath(projectId)}/prototypes/${encodeURIComponent(id)}`);
    },
  },
  {
    words: ['prototype', 'delete'],
    route: 'DELETE /api/projects/:projectId/prototypes/:prototypeId',
    run: async ({ args, rest }) => {
      const [id] = rest;
      if (!id) throw new Error('Thiếu ID prototype.');
      const projectId = option(args, '--project');
      return jsonRequest(args.workspace, `${projectPath(projectId)}/prototypes/${encodeURIComponent(id)}`, 'DELETE', { expectedRevision: integerOption(args, '--revision') });
    },
  },
  {
    words: ['prototype', 'create'],
    route: 'POST /api/projects/:projectId/prototypes',
    run: async ({ args, rest }) => {
      const [id] = rest;
      if (!id) throw new Error('Thiếu ID prototype.');
      const projectId = option(args, '--project');
      const input = JSON.parse(await readFile(option(args, '--input'), 'utf8')) as Record<string, unknown>;
      if (input.id !== id) throw new Error('ID trong file input phải trùng ID lệnh tạo prototype.');
      return jsonRequest(args.workspace, `${projectPath(projectId)}/prototypes`, 'POST', input);
    },
  },
  {
    words: ['prototype', 'update'],
    route: 'PATCH /api/projects/:projectId/prototypes/:prototypeId',
    run: async ({ args, rest }) => {
      const [id] = rest;
      if (!id) throw new Error('Thiếu ID prototype.');
      const projectId = option(args, '--project');
      const input = JSON.parse(await readFile(option(args, '--input'), 'utf8')) as Record<string, unknown>;
      return jsonRequest(args.workspace, `${projectPath(projectId)}/prototypes/${encodeURIComponent(id)}`, 'PATCH', input);
    },
  },
  {
    words: ['prototype', 'regenerate'],
    route: 'POST /api/projects/:projectId/prototypes/:prototypeId/regenerate',
    run: async ({ args, rest }) => {
      const [id] = rest;
      if (!id) throw new Error('Thiếu ID prototype.');
      const projectId = option(args, '--project');
      const input = JSON.parse(await readFile(option(args, '--input'), 'utf8')) as Record<string, unknown>;
      return jsonRequest(args.workspace, `${projectPath(projectId)}/prototypes/${encodeURIComponent(id)}/regenerate`, 'POST', input);
    },
  },
  {
    words: ['mcp', 'serve'],
    route: null,
    run: async ({ args }) => {
      const { serveMcp } = await import('../../mcp/src/index.js');
      await serveMcp(args.workspace);
      return null;
    },
  },
];

/** Longest matching prefix of leading words wins, so `screen edit start` beats `screen`. */
export function matchCommand(positionals: string[]): { spec: CommandSpec; rest: string[] } | null {
  let best: CommandSpec | null = null;
  for (const spec of COMMANDS) {
    if (spec.words.length > positionals.length) continue;
    if (!spec.words.every((word, index) => positionals[index] === word)) continue;
    if (!best || spec.words.length > best.words.length) best = spec;
  }
  return best ? { spec: best, rest: positionals.slice(best.words.length) } : null;
}

export function usage(): string {
  const names = COMMANDS.map((spec) => spec.words.join(' ')).sort();
  return `Lệnh hợp lệ: ${names.join(', ')}.`;
}

export type { RuntimeInfo };
