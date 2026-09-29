import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { asCanvasError, prototypeTransitionSchema, type Project } from '../../core/src/schema.js';
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

  const prototypePath = (project: string, id?: string) => `/api/projects/${encodeURIComponent(project)}/prototypes${id ? `/${encodeURIComponent(id)}` : ''}`;
  const requestJson = (path: string, method: string, body: unknown) => managementRequest(workspace, path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const transitions = z.array(prototypeTransitionSchema);
  const baseline = z.record(z.string(), z.string());

  server.registerTool('prototype_sources', {
    title: 'Prototype source revisions', description: 'Read current source fingerprints for the selected design screens.',
    inputSchema: { project: z.string(), screens: z.array(z.string()).min(2) },
  }, async ({ project, screens }) => runTool(async () => {
    await ensureServer(workspace);
    return managementRequest(workspace, `/api/projects/${encodeURIComponent(project)}/prototype-sources?screenIds=${encodeURIComponent(screens.join(','))}`);
  }));
  server.registerTool('prototype_list', {
    title: 'List prototypes', description: 'List prototype IDs and stale status for a project.', inputSchema: { project: z.string() },
  }, async ({ project }) => runTool(async () => { await ensureServer(workspace); return managementRequest(workspace, prototypePath(project)); }));
  server.registerTool('prototype_get', {
    title: 'Get prototype', description: 'Read a prototype by project and stable ID.', inputSchema: { project: z.string(), id: z.string() },
  }, async ({ project, id }) => runTool(async () => { await ensureServer(workspace); return managementRequest(workspace, prototypePath(project, id)); }));
  server.registerTool('prototype_create', {
    title: 'Create prototype', description: 'Save AI-inferred screen transitions without copying source screens.',
    inputSchema: { project: z.string(), id: z.string(), name: z.string(), screens: z.array(z.string()).min(2), startScreen: z.string(), transitions, expectedSourceBaseline: baseline },
  }, async ({ project, id, name, screens, startScreen, transitions: links, expectedSourceBaseline }) => runTool(async () => {
    await ensureServer(workspace);
    return requestJson(prototypePath(project), 'POST', { id, name, screenIds: screens, startScreenId: startScreen, transitions: links, expectedSourceBaseline });
  }));
  server.registerTool('prototype_update', {
    title: 'Update prototype', description: 'Edit prototype links or name without clearing stale source status.',
    inputSchema: { project: z.string(), id: z.string(), expectedRevision: z.number().int(), name: z.string().optional(), startScreen: z.string().optional(), transitions: transitions.optional() },
  }, async ({ project, id, expectedRevision, name, startScreen, transitions: links }) => runTool(async () => {
    await ensureServer(workspace);
    return requestJson(prototypePath(project, id), 'PATCH', { expectedRevision, name, startScreenId: startScreen, transitions: links });
  }));
  server.registerTool('prototype_regenerate', {
    title: 'Regenerate prototype', description: 'Replace transitions and source baseline for one existing prototype after the user requests regeneration.',
    inputSchema: { project: z.string(), id: z.string(), expectedRevision: z.number().int(), screens: z.array(z.string()).min(2), startScreen: z.string(), transitions, expectedSourceBaseline: baseline },
  }, async ({ project, id, expectedRevision, screens, startScreen, transitions: links, expectedSourceBaseline }) => runTool(async () => {
    await ensureServer(workspace);
    return requestJson(`${prototypePath(project, id)}/regenerate`, 'POST', { expectedRevision, screenIds: screens, startScreenId: startScreen, transitions: links, expectedSourceBaseline });
  }));
  server.registerTool('prototype_delete', {
    title: 'Delete prototype', description: 'Remove one prototype by project and stable ID.',
    inputSchema: { project: z.string(), id: z.string(), expectedRevision: z.number().int() },
  }, async ({ project, id, expectedRevision }) => runTool(async () => {
    await ensureServer(workspace);
    return requestJson(prototypePath(project, id), 'DELETE', { expectedRevision });
  }));

  return server;
}

export async function serveMcp(workspace: string): Promise<void> {
  const server = createMcpServer(workspace);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
