import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { asCanvasError, type Project } from '../../core/src/schema.js';
import { ensureServer, getServerStatus } from '../../server/src/lifecycle.js';
import { managementRequest } from '../../cli/src/client.js';

/**
 * MCP adapter over the same management API the CLI uses. It never creates a second
 * project store or lifecycle: every tool ensures/queries the one runtime bound to
 * the workspace. stdout is reserved for the protocol; diagnostics go to stderr.
 * Errors are surfaced as structured `{ ok:false, error:{ code, message } }` text so
 * they line up with the CLI's error shape for the same failure.
 */
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] };
}

async function runTool(operation: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await operation());
  } catch (error) {
    const canvasError = asCanvasError(error);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: canvasError.code, message: canvasError.message } }) }], isError: true };
  }
}

export function createMcpServer(workspace: string): McpServer {
  const server = new McpServer({ name: 'local-design-canvas', version: '0.1.0' });

  server.registerTool('canvas_status', {
    title: 'Canvas status',
    description: 'Report whether the local canvas runtime is running for the workspace.',
    inputSchema: {},
  }, async () => runTool(async () => {
    const runtime = await getServerStatus(workspace);
    return { running: runtime !== null, runtime };
  }));

  server.registerTool('project_list', {
    title: 'List projects',
    description: 'List design projects in the workspace.',
    inputSchema: {},
  }, async () => runTool(async () => {
    await ensureServer(workspace);
    return managementRequest<Project[]>(workspace, '/api/projects');
  }));

  server.registerTool('project_create', {
    title: 'Create project',
    description: 'Create a design project with a slug id and a display name.',
    inputSchema: { id: z.string(), name: z.string() },
  }, async ({ id, name }) => runTool(async () => {
    await ensureServer(workspace);
    return managementRequest(workspace, '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name }) });
  }));

  server.registerTool('screen_list', {
    title: 'List screens',
    description: 'List the screens of a project.',
    inputSchema: { project: z.string() },
  }, async ({ project }) => runTool(async () => {
    await ensureServer(workspace);
    const data = await managementRequest<Project>(workspace, `/api/projects/${encodeURIComponent(project)}`);
    return data.screens;
  }));

  server.registerTool('screen_add', {
    title: 'Add screen',
    description: 'Add a screen to a project and return its entry file path.',
    inputSchema: { project: z.string(), id: z.string(), name: z.string(), width: z.number().int(), height: z.number().int() },
  }, async ({ project, id, name, width, height }) => runTool(async () => {
    await ensureServer(workspace);
    const current = await managementRequest<Project>(workspace, `/api/projects/${encodeURIComponent(project)}`);
    return managementRequest(workspace, `/api/projects/${encodeURIComponent(project)}/screens`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name, width, height, expectedRevision: current.revision }),
    });
  }));

  server.registerTool('screen_capture', {
    title: 'Capture screen',
    description: 'Render a screen preview to a PNG and return its path and any render errors.',
    inputSchema: { project: z.string(), screen: z.string() },
  }, async ({ project, screen }) => runTool(async () => {
    await ensureServer(workspace);
    return managementRequest(workspace, `/api/projects/${encodeURIComponent(project)}/screens/${encodeURIComponent(screen)}/capture`, { method: 'POST' });
  }));

  server.registerTool('reference_fetch', {
    title: 'Fetch design reference',
    description: 'Open a real URL in a headless browser and extract its title, headings, section text, links, and a full-page screenshot as a design reference. Runs a browser on the local machine; confirm the URL with the user first.',
    inputSchema: { project: z.string(), url: z.string() },
  }, async ({ project, url }) => runTool(async () => {
    await ensureServer(workspace);
    return managementRequest(workspace, `/api/projects/${encodeURIComponent(project)}/reference`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
  }));

  server.registerTool('screen_focus', {
    title: 'Focused screen',
    description: 'Read the screen the user last highlighted on the canvas, from the sidebar or by clicking its frame.',
    inputSchema: { project: z.string() },
  }, async ({ project }) => runTool(async () => {
    await ensureServer(workspace);
    return managementRequest(workspace, `/api/projects/${encodeURIComponent(project)}/focus`);
  }));

  server.registerTool('screen_edit_start', {
    title: 'Start screen edit lock',
    description: 'Lock a canvas screen while editing so the user sees an editing overlay and cannot Interact/Select that frame. Pass screen or rely on the focused screen.',
    inputSchema: { project: z.string(), screen: z.string().optional(), message: z.string().optional() },
  }, async ({ project, screen, message }) => runTool(async () => {
    await ensureServer(workspace);
    return managementRequest(workspace, `/api/projects/${encodeURIComponent(project)}/editing`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screenId: screen, message }),
    });
  }));

  server.registerTool('screen_edit_done', {
    title: 'End screen edit lock',
    description: 'Clear the editing overlay so the user can Interact and Select on the canvas again.',
    inputSchema: { project: z.string() },
  }, async ({ project }) => runTool(async () => {
    await ensureServer(workspace);
    return managementRequest(workspace, `/api/projects/${encodeURIComponent(project)}/editing`, { method: 'DELETE' });
  }));

  server.registerTool('selection_get', {
    title: 'Get selection',
    description: 'Read the most recent element selection for a project, including whether it is stale.',
    inputSchema: { project: z.string() },
  }, async ({ project }) => runTool(async () => {
    await ensureServer(workspace);
    return managementRequest(workspace, `/api/projects/${encodeURIComponent(project)}/selection`);
  }));

  return server;
}

export async function serveMcp(workspace: string): Promise<void> {
  const server = createMcpServer(workspace);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
