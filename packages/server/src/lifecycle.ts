import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { canonicalWorkspace } from '../../core/src/paths.js';
import { CanvasError } from '../../core/src/schema.js';

export type RuntimeInfo = {
  instanceId: string;
  pid: number;
  url: string;
  previewUrl: string;
};

type RuntimeState = RuntimeInfo;

export type EnsureServerOptions = {
  managementPort?: number;
  previewPort?: number;
};

const START_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function runtimeDirectory(workspace: string): string {
  return join(workspace, '.local-canvas');
}

function runtimePath(workspace: string): string {
  return join(runtimeDirectory(workspace), 'runtime.json');
}

function runtimeLogPath(workspace: string): string {
  return join(runtimeDirectory(workspace), 'server.log');
}

function lockPath(workspace: string): string {
  return join(runtimeDirectory(workspace), 'start.lock');
}

function lockOwnerPath(workspace: string): string {
  return join(lockPath(workspace), 'owner.json');
}

function publicRuntime(state: RuntimeState): RuntimeInfo {
  return { instanceId: state.instanceId, pid: state.pid, url: state.url, previewUrl: state.previewUrl };
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<RuntimeState>;
  return typeof state.instanceId === 'string'
    && typeof state.pid === 'number'
    && typeof state.url === 'string'
    && typeof state.previewUrl === 'string';
}

async function readRuntime(workspace: string): Promise<RuntimeState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(runtimePath(workspace), 'utf8'));
    return isRuntimeState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function isHealthy(state: RuntimeState): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`${state.url}/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean; data?: { instanceId?: unknown } };
    return body.ok === true && body.data?.instanceId === state.instanceId;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function getServerStatus(workspace: string): Promise<RuntimeInfo | null> {
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  const state = await readRuntime(canonicalWorkspacePath);
  if (!state || !(await isHealthy(state))) return null;
  return publicRuntime(state);
}

export async function getServerCredentials(workspace: string): Promise<RuntimeInfo | null> {
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  const state = await readRuntime(canonicalWorkspacePath);
  if (!state || !(await isHealthy(state))) return null;
  return publicRuntime(state);
}

async function acquireStartupLock(workspace: string): Promise<() => Promise<void>> {
  const path = lockPath(workspace);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(path);
      const owner = { id: crypto.randomUUID(), pid: process.pid, createdAt: Date.now() };
      await writeFile(lockOwnerPath(workspace), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 });
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockOwnerPath(workspace), 'utf8')) as { id?: unknown };
          if (current.id === owner.id) await rm(path, { force: true, recursive: true });
        } catch {
          // A missing lock is already released; a replacement lock belongs to another caller.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await isStaleLock(workspace)) {
        await rm(path, { force: true, recursive: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CanvasError('SERVER_START_TIMEOUT', 'Không thể lấy lock khởi động server trong 10 giây.', 503);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function isStaleLock(workspace: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(lockOwnerPath(workspace), 'utf8')) as { pid?: unknown };
    if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'EPERM';
      }
    }
  } catch {
    // A crash between mkdir and owner write uses the age fallback below.
  }
  try {
    return Date.now() - (await stat(lockPath(workspace))).mtimeMs >= START_TIMEOUT_MS;
  } catch {
    return false;
  }
}

function validatePort(port: number | undefined): void {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new CanvasError('VALIDATION_ERROR', 'Port phải là số nguyên từ 1 đến 65535.');
  }
}

async function startProcess(workspace: string, options: EnsureServerOptions): Promise<void> {
  const releaseEntrypoint = process.env.LOCAL_CANVAS_SERVER_ENTRY;
  const nodeModulesTsc = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const sourceEntrypoint = fileURLToPath(new URL('./standalone.ts', import.meta.url));
  const log = await open(runtimeLogPath(workspace), 'a', 0o600);
  const args = releaseEntrypoint
    ? [releaseEntrypoint, '--workspace', workspace, '--instance-id', crypto.randomUUID()]
    : [nodeModulesTsc, sourceEntrypoint, '--workspace', workspace, '--instance-id', crypto.randomUUID()];
  if (options.managementPort !== undefined) args.push('--management-port', String(options.managementPort));
  if (options.previewPort !== undefined) args.push('--preview-port', String(options.previewPort));
  const child = spawn(process.execPath, args, {
    cwd: workspace,
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    windowsHide: true,
  });
  child.unref();
  await log.close();
}

async function startupFailure(workspace: string): Promise<CanvasError> {
  try {
    const log = await readFile(runtimeLogPath(workspace), 'utf8');
    if (log.includes('EADDRINUSE')) {
      return new CanvasError('PORT_IN_USE', 'Port được chỉ định đang được sử dụng.', 409);
    }
  } catch {
    // The generic error below includes the useful recovery action.
  }
  return new CanvasError('SERVER_START_TIMEOUT', 'Server không phản hồi health check trong 10 giây.', 503);
}

export async function ensureServer(workspace: string, options: EnsureServerOptions = {}): Promise<RuntimeInfo> {
  validatePort(options.managementPort);
  validatePort(options.previewPort);
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  await mkdir(runtimeDirectory(canonicalWorkspacePath), { recursive: true, mode: 0o700 });
  const existing = await getServerStatus(canonicalWorkspacePath);
  if (existing) return existing;

  const release = await acquireStartupLock(canonicalWorkspacePath);
  try {
    const afterLock = await getServerStatus(canonicalWorkspacePath);
    if (afterLock) return afterLock;
    await rm(runtimePath(canonicalWorkspacePath), { force: true });
    await startProcess(canonicalWorkspacePath, options);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await getServerStatus(canonicalWorkspacePath);
      if (status) return status;
      await sleep(POLL_INTERVAL_MS);
    }
    throw await startupFailure(canonicalWorkspacePath);
  } finally {
    await release();
  }
}

export async function stopServer(workspace: string): Promise<void> {
  const canonicalWorkspacePath = await canonicalWorkspace(workspace);
  const state = await readRuntime(canonicalWorkspacePath);
  if (!state || !(await isHealthy(state))) return;
  const response = await fetch(`${state.url}/api/shutdown`, { method: 'POST' });
  if (!response.ok) throw new CanvasError('SERVER_STOP_FAILED', 'Server từ chối yêu cầu dừng.', response.status);
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (!(await getServerStatus(canonicalWorkspacePath))) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new CanvasError('SERVER_STOP_TIMEOUT', 'Server chưa dừng sau 4 giây.', 503);
}
