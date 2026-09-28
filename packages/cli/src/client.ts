import { CanvasError, type Result } from '../../core/src/schema.js';
import { getServerStatus } from '../../server/src/lifecycle.js';

export async function managementRequest<T>(workspace: string, path: string, init: RequestInit = {}): Promise<T> {
  const status = await getServerStatus(workspace);
  if (!status) throw new CanvasError('SERVER_NOT_RUNNING', 'Server chưa chạy cho workspace này.', 503);
  const response = await fetch(`${status.url}${path}`, init);
  const body = (await response.json()) as Result<T>;
  if (!body.ok) throw new CanvasError(body.error.code, body.error.message, response.status);
  return body.data;
}
