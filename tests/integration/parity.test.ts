import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createManagementApp } from '../../packages/server/src/app.js';
import { COMMANDS } from '../../packages/cli/src/commands.js';
import { createMcpServer } from '../../packages/mcp/src/index.js';

/**
 * The API is the single source of truth, and the CLI and MCP adapter are thin
 * clients of it. Nothing in the type system stops a new route from being added
 * without a matching CLI command or MCP tool — that is how screen delete,
 * screen order, project rename and Figma export came to exist in the API and
 * in the canvas UI but nowhere the agent could reach. These tests fail on that
 * drift instead of leaving it for someone to notice months later.
 */

/** Routes that are deliberately not agent-facing, each with the reason. */
const NOT_AGENT_FACING: Record<string, string> = {
  'GET /health': 'Liveness probe for the lifecycle helper.',
  'POST /api/shutdown': 'Owned by `canvas stop`.',
  'GET /api/events': 'SSE stream consumed by the canvas UI.',
  'GET /api/preview': 'Serves screen files to the browser iframe.',
  'GET /api/projects/:projectId/focus': 'Read-only status; the CLI already writes focus through `screen focus`.',
  'GET /api/projects/:projectId/selection': 'Read-only status; the CLI already reads selection through `selection get`.',
  'PUT /api/projects/:projectId/focus': 'The canvas tells the server which screen the user is looking at. Not a server-side state change an agent should fake.',
  'DELETE /api/projects/:projectId/focus': 'Canvas-only: cleared when the user deselects.',
  'POST /api/projects/:projectId/selection': 'Canvas-only: the bridge reports the element the user picked, signed with a nonce minted for the canvas.',
  'POST /api/projects/:projectId/screens/:screenId/selection-nonce': 'Internal handshake for the canvas selection overlay.',
  'GET /*': 'SPA fallback that serves the canvas UI.',
};

/** MCP tools whose name does not read directly off a CLI command. */
const TOOL_ALIASES: Record<string, string> = {
  canvas_status: 'status',
  screen_capture: 'screenshot',
};

let root: string;
let workspace: string;

async function serverRoutes(): Promise<string[]> {
  const routes: string[] = [];
  const app = await createManagementApp({
    instanceId: 'parity',
    workspace,
    events: { subscribe: () => () => undefined, publish: () => undefined } as never,
    selection: { read: () => null } as never,
    getPreviewUrl: () => null,
    onShutdown: async () => undefined,
    onRoute: (route) => routes.push(`${route.method} ${route.url}`),
  });
  await app.close();
  return routes;
}

async function mcpToolNames(): Promise<string[]> {
  const server = createMcpServer(workspace);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'parity', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

/** `screen edit start` -> `screen edit start`; `status` -> `status`. */
const cliCommandNames = COMMANDS.map((command) => command.words.join(' '));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-canvas-parity-'));
  workspace = join(root, 'workspace');
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe('control surface parity', () => {
  it('mọi route quản lý đều có lệnh CLI hoặc nằm trong danh sách miễn trừ', async () => {
    const routes = await serverRoutes();
    const covered = new Set(COMMANDS.map((command) => command.route).filter((route): route is string => route !== null));
    // HEAD is added by Fastify alongside GET and carries no meaning of its own.
    const uncovered = routes
      .filter((route) => !route.startsWith('HEAD '))
      .filter((route) => !covered.has(route))
      .filter((route) => !(route in NOT_AGENT_FACING))
      .sort();

    expect(uncovered, 'Route mới chưa được phủ bởi CLI. Thêm lệnh vào packages/cli/src/commands.ts, hoặc ghi vào NOT_AGENT_FACING kèm lý do.').toEqual([]);
  });

  it('mọi route mà CLI khai báo đều tồn tại trên server', async () => {
    const routes = new Set(await serverRoutes());
    const stale = COMMANDS
      .filter((command) => command.route !== null)
      .map((command) => ({ command: command.words.join(' '), route: command.route as string }))
      .filter((entry) => !routes.has(entry.route))
      .map((entry) => `${entry.command} -> ${entry.route}`)
      .sort();

    expect(stale, 'Lệnh CLI trỏ tới route không còn tồn tại.').toEqual([]);
  });

  it('mọi tool MCP đều tương ứng một lệnh CLI', async () => {
    const tools = await mcpToolNames();
    const names = new Set(cliCommandNames);
    const orphans = tools
      .filter((tool) => {
        const mapped = TOOL_ALIASES[tool] ?? tool.replace(/_/g, ' ');
        return !names.has(mapped);
      })
      .sort();

    expect(orphans, 'Tool MCP không có lệnh CLI tương ứng. Hai adapter đã lệch nhau.').toEqual([]);
  });

  it('mọi lệnh CLI đều tới được server qua HTTP', async () => {
    const routes = new Set(await serverRoutes());
    const local = new Set(['start', 'status', 'stop', 'mcp serve']);
    const unreachable = COMMANDS
      .map((command) => ({ name: command.words.join(' '), route: command.route }))
      .filter((entry) => !local.has(entry.name))
      .filter((entry) => entry.route === null || !routes.has(entry.route))
      .map((entry) => entry.name)
      .sort();

    expect(unreachable, 'Lệnh CLI không gọi route nào cả và cũng không phải lệnh cục bộ.').toEqual([]);
  });
});
