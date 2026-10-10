import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  addScreen,
  createProject,
  getProjectRoot,
  listProjects,
  readProject,
  updateLayout,
  reorderScreens,
  deleteScreens,
  renameProject,
} from '../../core/src/project-store.js';
import { canonicalWorkspace, resolveProjectDirectory, resolveProjectFile } from '../../core/src/paths.js';
import { asCanvasError, CanvasError, projectIdSchema, type Result, screenLayoutPatchSchema, screenOrderSchema, selectionContextSchema, prototypeCreateInputSchema, prototypePatchInputSchema, prototypeRegenerateInputSchema } from '../../core/src/schema.js';
import { CanvasEvents } from './events.js';
import { captureScreen } from './capture.js';
import { exportScreenForFigma } from './figma-export.js';
import { fetchReference } from './reference.js';
import { createSnapshot, duplicateScreen, restoreSnapshot } from './snapshots.js';
import { SelectionStore } from './selection.js';
import { ensureDesignIds } from './design-ids.js';
import { createPrototype, deletePrototype, listPrototypes, readPrototype, regeneratePrototype, updatePrototype } from './prototypes.js';
import { readPrototypeSources } from './prototype-sources.js';
import { bridgeScriptSource, contentSizeScriptSource, figmaCaptureScriptSource, prototypeBridgeScriptSource } from '../../preview-bridge/src/index.js';

export type ManagementAppOptions = {
  instanceId: string;
  workspace: string;
  events: CanvasEvents;
  selection: SelectionStore;
  getPreviewUrl: () => string | null;
  onShutdown: () => Promise<void>;
  /** Observes every route as it is registered. Used by the control-surface parity test. */
  onRoute?: (route: { method: string; url: string }) => void;
};

function success<T>(data: T): Result<T> {
  return { ok: true, data };
}

function assertAllowedOrigin(origin: string | undefined, host: string | undefined): void {
  if (!host || !/^127\.0\.0\.1:\d+$/.test(host)) {
    throw new CanvasError('FORBIDDEN_HOST', 'Host không được phép gọi API quản lý.', 403);
  }
  if (origin && origin !== `http://${host}`) {
    throw new CanvasError('FORBIDDEN_ORIGIN', 'Origin không được phép gọi API quản lý.', 403);
  }
}

const projectCreateBodySchema = z.object({ id: projectIdSchema, name: z.string().trim().min(1) });
const screenCreateBodySchema = z.object({
  id: projectIdSchema,
  name: z.string().trim().min(1),
  width: z.number().int().min(240).max(4096),
  height: z.number().int().min(240).max(4096),
  expectedRevision: z.number().int().nonnegative(),
});
const layoutBodySchema = z.object({ patches: z.array(screenLayoutPatchSchema), expectedRevision: z.number().int().nonnegative() });
const screenOrderBodySchema = z.object({ order: screenOrderSchema, expectedRevision: z.number().int().nonnegative() });
const screenDeleteBodySchema = z.object({ screenIds: screenOrderSchema.min(1), expectedRevision: z.number().int().nonnegative() });
const projectRenameBodySchema = z.object({ name: z.string().min(1).max(120), expectedRevision: z.number().int().nonnegative() });

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

async function createScreenSource(
  workspace: string,
  input: { projectId: string; id: string; name: string; width: number; height: number; expectedRevision: number },
): Promise<{ entry: string; entryPath: string }> {
  const project = await readProject(workspace, input.projectId);
  if (project.revision !== input.expectedRevision) {
    throw new CanvasError('REVISION_CONFLICT', 'Project đã thay đổi; hãy tải lại rồi thử lại.', 409);
  }
  if (project.screens.some((screen) => screen.id === input.id)) {
    throw new CanvasError('SCREEN_EXISTS', `Màn hình “${input.id}” đã tồn tại.`, 409);
  }
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  const root = await getProjectRoot(canonicalWorkspacePath, input.projectId);
  const screensDirectory = await resolveProjectDirectory(root, 'screens');
  const screenDirectory = join(screensDirectory, input.id);
  const entry = `screens/${input.id}/index.html`;
  try {
    await mkdir(screenDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CanvasError('SCREEN_EXISTS', `Màn hình “${input.id}” đã tồn tại.`, 409);
    }
    throw error;
  }
  try {
    const templateRoot = process.env.LOCAL_CANVAS_TEMPLATE_DIR
      ?? fileURLToPath(new URL('../../../templates/basic-screen/', import.meta.url));
    const [html, css] = await Promise.all([
      readFile(join(templateRoot, 'index.html'), 'utf8'),
      readFile(join(templateRoot, 'styles.css'), 'utf8'),
    ]);
    await Promise.all([
      writeFile(join(screenDirectory, 'index.html'), html.replaceAll('{{screenId}}', escapeHtml(input.id)).replaceAll('{{screenName}}', escapeHtml(input.name)), 'utf8'),
      writeFile(join(screenDirectory, 'styles.css'), css, 'utf8'),
    ]);
    await addScreen(
      canonicalWorkspacePath,
      input.projectId,
      {
        id: input.id,
        name: input.name,
        entry,
        x: project.screens.length * (input.width + 120),
        y: 0,
        width: input.width,
        height: input.height,
      },
      input.expectedRevision,
    );
    return { entry, entryPath: await resolveProjectFile(root, entry) };
  } catch (error) {
    await rm(screenDirectory, { force: true, recursive: true });
    throw error;
  }
}

export async function createManagementApp(options: ManagementAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: false });

  // Registered before any route so it observes the whole table.
  if (options.onRoute) {
    const observe = options.onRoute;
    app.addHook('onRoute', (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        observe({ method, url: route.url });
      }
    });
  }

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    assertAllowedOrigin(request.headers.origin, request.headers.host);
  });

  app.get('/health', async () =>
    success({
      appId: 'local-design-canvas',
      protocolVersion: 1,
      instanceId: options.instanceId,
      capabilities: ['capture', 'snapshots', 'selection', 'reference', 'editing'],
    }),
  );

  app.post('/api/shutdown', async (request, reply) => {
    void options.onShutdown();
    return reply.send(success({ stopped: true }));
  });

  app.get('/api/events', async (_request, reply) => {
    options.events.subscribe(reply);
  });

  app.get('/api/preview', async () => {
    const url = options.getPreviewUrl();
    if (!url) throw new CanvasError('PREVIEW_UNAVAILABLE', 'Preview của phiên canvas này chưa sẵn sàng.', 503);
    return success({ url });
  });

  app.get('/api/projects', async () => success(await listProjects(options.workspace)));

  app.post('/api/projects', async (request, reply) => {
    const body = projectCreateBodySchema.parse(request.body);
    const project = await createProject(options.workspace, body);
    const root = await getProjectRoot(await canonicalWorkspace(options.workspace), project.id);
    await writeFile(join(root, 'design-system.css'), ':root {\n  --canvas-accent: #2563eb;\n}\n', { encoding: 'utf8', flag: 'a' });
    options.events.publish({ type: 'project.updated', projectId: project.id, screenIds: [] });
    return reply.code(201).send(success({ project, path: root }));
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request) => {
    return success(await readProject(options.workspace, request.params.projectId));
  });

  app.get<{ Params: { projectId: string }; Querystring: { screenIds?: string } }>('/api/projects/:projectId/prototype-sources', async (request) => {
    const ids = z.array(projectIdSchema).min(2).max(50).parse(request.query.screenIds?.split(',') ?? []);
    if (new Set(ids).size !== ids.length) throw new CanvasError('VALIDATION_ERROR', 'Màn hình prototype bị trùng.');
    return success(await readPrototypeSources(options.workspace, request.params.projectId, ids));
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/prototypes', async (request) => success(await listPrototypes(options.workspace, request.params.projectId)));
  app.get<{ Params: { projectId: string; prototypeId: string } }>('/api/projects/:projectId/prototypes/:prototypeId', async (request) => success(await readPrototype(options.workspace, request.params.projectId, request.params.prototypeId)));
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/prototypes', async (request, reply) => {
    const created = await createPrototype(options.workspace, request.params.projectId, prototypeCreateInputSchema.parse(request.body));
    options.events.publish({ type: 'prototype.updated', projectId: request.params.projectId, screenIds: created.screenIds });
    return reply.code(201).send(success(created));
  });
  app.patch<{ Params: { projectId: string; prototypeId: string } }>('/api/projects/:projectId/prototypes/:prototypeId', async (request) => {
    const updated = await updatePrototype(options.workspace, request.params.projectId, request.params.prototypeId, prototypePatchInputSchema.parse(request.body));
    options.events.publish({ type: 'prototype.updated', projectId: request.params.projectId, screenIds: updated.screenIds });
    return success(updated);
  });
  app.post<{ Params: { projectId: string; prototypeId: string } }>('/api/projects/:projectId/prototypes/:prototypeId/regenerate', async (request) => {
    const updated = await regeneratePrototype(options.workspace, request.params.projectId, request.params.prototypeId, prototypeRegenerateInputSchema.parse(request.body));
    options.events.publish({ type: 'prototype.updated', projectId: request.params.projectId, screenIds: updated.screenIds });
    return success(updated);
  });
  app.delete<{ Params: { projectId: string; prototypeId: string } }>('/api/projects/:projectId/prototypes/:prototypeId', async (request) => {
    const body = z.object({ expectedRevision: z.number().int().nonnegative() }).parse(request.body);
    await deletePrototype(options.workspace, request.params.projectId, request.params.prototypeId, body.expectedRevision);
    options.events.publish({ type: 'prototype.updated', projectId: request.params.projectId, screenIds: [] });
    return success({ deleted: true });
  });

  app.patch<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request) => {
    const body = projectRenameBodySchema.parse(request.body);
    const project = await renameProject(options.workspace, request.params.projectId, body.name, body.expectedRevision);
    options.events.publish({ type: 'project.updated', projectId: project.id, screenIds: [] });
    return success(project);
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/screens', async (request, reply) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const body = screenCreateBodySchema.parse(request.body);
    const source = await createScreenSource(options.workspace, {
      projectId,
      ...body,
    });
    const project = await readProject(options.workspace, projectId);
    const screen = project.screens.find((item) => item.id === body.id);
    options.events.publish({ type: 'project.updated', projectId, screenIds: [body.id] });
    return reply.code(201).send(success({ project, screen, ...source }));
  });

  app.patch<{ Params: { projectId: string } }>('/api/projects/:projectId/layout', async (request) => {
    const body = layoutBodySchema.parse(request.body);
    const project = await updateLayout(options.workspace, request.params.projectId, body.patches, body.expectedRevision);
    options.events.publish({ type: 'project.updated', projectId: project.id, screenIds: body.patches.map((patch) => patch.id) });
    return success(project);
  });

  app.patch<{ Params: { projectId: string } }>('/api/projects/:projectId/screen-order', async (request) => {
    const body = screenOrderBodySchema.parse(request.body);
    const project = await reorderScreens(options.workspace, request.params.projectId, body.order, body.expectedRevision);
    options.events.publish({ type: 'project.updated', projectId: project.id, screenIds: body.order });
    return success(project);
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId/screens', async (request) => {
    const body = screenDeleteBodySchema.parse(request.body);
    const project = await deleteScreens(options.workspace, request.params.projectId, body.screenIds, body.expectedRevision);
    options.events.publish({ type: 'project.updated', projectId: project.id, screenIds: body.screenIds });
    return success(project);
  });

  app.post<{ Params: { projectId: string; screenId: string } }>('/api/projects/:projectId/screens/:screenId/capture', async (request) => {
    return success(await captureScreen(options.workspace, request.params.projectId, request.params.screenId));
  });
  app.post<{ Params: { projectId: string; screenId: string } }>('/api/projects/:projectId/screens/:screenId/figma', async (request) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const screenId = projectIdSchema.parse(request.params.screenId);
    return success(await exportScreenForFigma(options.workspace, projectId, screenId));
  });
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/reference', async (request) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const body = z.object({ url: z.string().min(1) }).parse(request.body);
    return success(await fetchReference(options.workspace, projectId, body.url));
  });
  app.post<{ Params: { projectId: string; screenId: string } }>('/api/projects/:projectId/screens/:screenId/duplicate', async (request) => {
    const body = z.object({ newId: projectIdSchema }).parse(request.body);
    const screen = await duplicateScreen(options.workspace, request.params.projectId, request.params.screenId, body.newId);
    options.events.publish({ type: 'project.updated', projectId: request.params.projectId, screenIds: [screen.id] });
    return success(screen);
  });
  app.post<{ Params: { projectId: string; screenId: string } }>('/api/projects/:projectId/screens/:screenId/selection-nonce', async (request) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const screenId = projectIdSchema.parse(request.params.screenId);
    const project = await readProject(options.workspace, projectId);
    if (!project.screens.some((screen) => screen.id === screenId)) {
      throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${screenId}”.`, 404);
    }
    await ensureDesignIds(options.workspace, projectId, screenId);
    return success({ nonce: options.selection.issueNonce(projectId, screenId) });
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/selection', async (request) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const body = z.object({ context: selectionContextSchema, nonce: z.string().min(1) }).parse(request.body);
    if (body.context.projectId !== projectId) {
      throw new CanvasError('SELECTION_REJECTED', 'Selection không thuộc project này.', 400);
    }
    return success(await options.selection.record(options.workspace, body));
  });

  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId/focus', async (request) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const body = z.object({ screenId: projectIdSchema }).parse(request.body);
    return success(await options.selection.setFocus(options.workspace, projectId, body.screenId));
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId/focus', async (request) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    await readProject(options.workspace, projectId);
    options.selection.clearFocus(projectId);
    return success({ cleared: true });
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/focus', async (request) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    await readProject(options.workspace, projectId);
    const focus = await options.selection.getFocus(options.workspace, projectId);
    if (!focus) throw new CanvasError('NO_SCREEN_FOCUS', 'Chưa có màn hình nào được chọn trên canvas.', 404);
    return success(focus);
  });

  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId/editing', async (request) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const body = z.object({
      screenId: projectIdSchema.optional(),
      message: z.string().trim().max(160).optional(),
    }).parse(request.body ?? {});
    let screenId = body.screenId;
    if (!screenId) {
      const focus = await options.selection.getFocus(options.workspace, projectId);
      if (!focus) throw new CanvasError('NO_SCREEN_FOCUS', 'Chưa có màn hình nào được chọn trên canvas.', 404);
      screenId = focus.screenId;
    }
    const session = await options.selection.beginEdit(options.workspace, projectId, screenId, body.message);
    options.events.publish({
      type: 'screen.editing',
      projectId,
      screenIds: [session.screenId],
      message: session.message,
    });
    return success(session);
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId/editing', async (request) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    await readProject(options.workspace, projectId);
    const previous = options.selection.clearEdit(projectId);
    options.events.publish({
      type: 'screen.editing',
      projectId,
      screenIds: previous ? [previous.screenId] : [],
      message: 'idle',
    });
    return success({ cleared: true, previous });
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/editing', async (request) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    await readProject(options.workspace, projectId);
    return success({ session: options.selection.getEdit(projectId) });
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/selection', async (request) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    await readProject(options.workspace, projectId);
    const current = await options.selection.get(options.workspace, projectId);
    if (!current) throw new CanvasError('NO_SELECTION', 'Chưa có phần tử nào được chọn trong project này.', 404);
    return success(current);
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/snapshots', async (request) => success(await createSnapshot(options.workspace, request.params.projectId)));
  app.post<{ Params: { projectId: string; snapshotId: string } }>('/api/projects/:projectId/snapshots/:snapshotId/restore', async (request) => {
    const result = await restoreSnapshot(options.workspace, request.params.projectId, request.params.snapshotId);
    const project = await readProject(options.workspace, request.params.projectId);
    options.events.publish({ type: 'screen.changed', projectId: project.id, screenIds: project.screens.map((screen) => screen.id) });
    return success(result);
  });

  app.get('/*', async (request, reply) => serveCanvasAsset(reply, request.url));

  app.setErrorHandler((error, _request, reply) => {
    const canvasError = asCanvasError(error);
    void reply.status(canvasError.statusCode).send({
      ok: false,
      error: { code: canvasError.code, message: canvasError.message },
    } satisfies Result<never>);
  });

  return app;
}

function contentType(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function isInside(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

async function serveCanvasAsset(reply: FastifyReply, requestUrl: string): Promise<unknown> {
  const staticDirectory = process.env.LOCAL_CANVAS_STATIC_DIR;
  if (!staticDirectory) throw new CanvasError('NOT_FOUND', 'Canvas chưa được build.', 404);
  const root = await realpath(staticDirectory);
  const pathname = decodeURIComponent(requestUrl.split('?')[0] || '/');
  const candidate = resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
  if (!isInside(root, candidate)) throw new CanvasError('NOT_FOUND', 'Asset canvas không hợp lệ.', 404);
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) throw new Error('Không phải file canvas.');
    reply.header('cache-control', pathname === '/' ? 'no-store' : 'public, max-age=31536000, immutable');
    reply.header('content-type', contentType(candidate));
    return reply.send(await readFile(candidate));
  } catch {
    if (pathname.includes('.')) throw new CanvasError('NOT_FOUND', 'Không tìm thấy asset canvas.', 404);
    const index = join(root, 'index.html');
    reply.header('cache-control', 'no-store');
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(await readFile(index));
  }
}

const bridgeQuerySchema = z.object({
  bridge: z.string().min(1).optional(),
  screen: projectIdSchema.optional(),
  figma: z.enum(['1']).optional(),
  prototype: z.string().min(1).max(200).optional(),
  parentOrigin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/).optional(),
});

function injectBridge(html: string, script: string): string {
  const tag = `<script>${script}</script>`;
  const index = html.toLowerCase().lastIndexOf('</body>');
  if (index === -1) return `${html}${tag}`;
  return `${html.slice(0, index)}${tag}${html.slice(index)}`;
}

export async function createPreviewApp(workspace: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: false });
  app.get('/health', async () => ({ ok: true, data: { preview: true } }));
  app.get<{ Params: { projectId: string; '*': string }; Querystring: { bridge?: string; screen?: string } }>('/projects/:projectId/*', async (request, reply) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const relativePath = request.params['*'];
    const topLevel = relativePath.split('/')[0];
    if (['.local-canvas', 'project.json', 'snapshots', 'artifacts', 'prototypes'].includes(topLevel)) {
      throw new CanvasError('PATH_OUTSIDE_PROJECT', 'File không được phục vụ bởi preview.', 403);
    }
    await readProject(workspace, projectId);
    const root = await getProjectRoot(await canonicalWorkspace(workspace), projectId);
    const file = await resolveProjectFile(root, relativePath);
    reply.header('content-type', contentType(file));
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', "sandbox allow-scripts; default-src 'self'; script-src 'self' 'unsafe-inline' https://mcp.figma.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src *; base-uri 'none'; form-action 'none'");
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    const query = bridgeQuerySchema.parse(request.query);
    if (query.screen && file.endsWith('.html')) {
      let html = await readFile(file, 'utf8');
      // Canvas artboards expand to page height; the separate Play iframe must
      // retain ordinary page scrolling instead of inheriting that overflow lock.
      if (!query.prototype) html = injectBridge(html, contentSizeScriptSource({ screenId: query.screen }));
      if (query.bridge) html = injectBridge(html, bridgeScriptSource({ projectId, screenId: query.screen, nonce: query.bridge }));
      if (query.prototype && query.parentOrigin) html = injectBridge(html, prototypeBridgeScriptSource({ projectId, screenId: query.screen, nonce: query.prototype, parentOrigin: query.parentOrigin }));
      if (query.figma) html = injectBridge(html, figmaCaptureScriptSource({ screenId: query.screen }));
      return reply.send(html);
    }
    return reply.send(await readFile(file));
  });
  return app;
}
