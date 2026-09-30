import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createManagementApp, createPreviewApp } from './app.js';
import { CanvasEvents } from './events.js';
import { SelectionStore } from './selection.js';
import { watchWorkspace } from './watcher.js';

type RuntimeState = {
  instanceId: string;
  pid: number;
  url: string;
  previewUrl: string;
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`Missing ${name} runtime argument.`);
  return value;
}

function portArgument(name: string): number {
  const value = argument(name);
  if (!value) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid ${name} value.`);
  return port;
}

async function writeRuntime(path: string, state: RuntimeState): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeOwnRuntime(path: string, instanceId: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(path, 'utf8')) as { instanceId?: unknown };
    if (current.instanceId === instanceId) await rm(path, { force: true });
  } catch {
    // A stale or absent state file must not prevent shutdown.
  }
}

const workspace = requiredArgument('--workspace');
const instanceId = requiredArgument('--instance-id');

const runtimeDirectory = join(workspace, '.local-canvas');
const runtimePath = join(runtimeDirectory, 'runtime.json');
const logPath = join(runtimeDirectory, 'server.log');
const logHandle = await open(logPath, 'a', 0o600);
await logHandle.close();

let closed = false;
let management: Awaited<ReturnType<typeof createManagementApp>> | undefined;
let preview: Awaited<ReturnType<typeof createPreviewApp>> | undefined;
let watcher: ReturnType<typeof watchWorkspace> | undefined;
let previewAddress: string | null = null;
const events = new CanvasEvents(instanceId);
const selection = new SelectionStore();

async function shutdown(): Promise<void> {
  if (closed) return;
  closed = true;
  events.close();
  await Promise.allSettled([watcher?.close(), management?.close(), preview?.close()]);
  await removeOwnRuntime(runtimePath, instanceId);
}

try {
  management = await createManagementApp({ instanceId, workspace, events, selection, getPreviewUrl: () => previewAddress, onShutdown: shutdown });
  preview = await createPreviewApp(workspace);
  previewAddress = await preview.listen({ host: '127.0.0.1', port: portArgument('--preview-port') });
  const managementAddress = await management.listen({ host: '127.0.0.1', port: portArgument('--management-port') });
  watcher = watchWorkspace(workspace, events);
  await writeRuntime(runtimePath, {
    instanceId,
    pid: process.pid,
    url: managementAddress,
    previewUrl: previewAddress,
  });
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await writeFile(logPath, `[SERVER_START_FAILED] ${message}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
  await shutdown();
  process.exitCode = 1;
}
