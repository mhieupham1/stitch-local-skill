import type { CanvasEvent, Project, PrototypeView, Result, ScreenLayoutPatch, SelectionContext } from '../../core/src/schema.js';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

export class CanvasApi {
  constructor(readonly baseUrl = window.location.origin) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
    const result = await response.json() as Result<T>;
    if (!result.ok) throw new ApiError(result.error.code, result.error.message, response.status);
    return result.data;
  }

  listProjects() { return this.request<Project[]>('/api/projects'); }
  createProject(input: { id: string; name: string }) {
    return this.request<{ project: Project; path: string }>('/api/projects', { method: 'POST', body: JSON.stringify(input) });
  }
  getPreview() { return this.request<{ url: string }>('/api/preview'); }
  getProject(projectId: string) { return this.request<Project>(`/api/projects/${encodeURIComponent(projectId)}`); }
  listPrototypes(projectId: string) { return this.request<PrototypeView[]>(`/api/projects/${encodeURIComponent(projectId)}/prototypes`); }
  getPrototype(projectId: string, prototypeId: string) { return this.request<PrototypeView>(`/api/projects/${encodeURIComponent(projectId)}/prototypes/${encodeURIComponent(prototypeId)}`); }
  updatePrototypePosition(projectId: string, prototypeId: string, x: number, y: number, expectedRevision: number) {
    return this.request<PrototypeView>(`/api/projects/${encodeURIComponent(projectId)}/prototypes/${encodeURIComponent(prototypeId)}`, { method: 'PATCH', body: JSON.stringify({ x, y, expectedRevision }) });
  }
  deletePrototype(projectId: string, prototypeId: string, expectedRevision: number) {
    return this.request<{ deleted: true }>(`/api/projects/${encodeURIComponent(projectId)}/prototypes/${encodeURIComponent(prototypeId)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision }) });
  }
  renameProject(projectId: string, name: string, expectedRevision: number) {
    return this.request<Project>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ name, expectedRevision }) });
  }
  updateLayout(projectId: string, patches: ScreenLayoutPatch[], expectedRevision: number) {
    return this.request<Project>(`/api/projects/${encodeURIComponent(projectId)}/layout`, { method: 'PATCH', body: JSON.stringify({ patches, expectedRevision }) });
  }
  reorderScreens(projectId: string, order: string[], expectedRevision: number) {
    return this.request<Project>(`/api/projects/${encodeURIComponent(projectId)}/screen-order`, { method: 'PATCH', body: JSON.stringify({ order, expectedRevision }) });
  }
  deleteScreens(projectId: string, screenIds: string[], expectedRevision: number) {
    return this.request<Project>(`/api/projects/${encodeURIComponent(projectId)}/screens`, { method: 'DELETE', body: JSON.stringify({ screenIds, expectedRevision }) });
  }
  addScreen(projectId: string, input: { id: string; name: string; width: number; height: number; expectedRevision: number }) {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/screens`, { method: 'POST', body: JSON.stringify(input) });
  }
  captureScreen(projectId: string, screenId: string) { return this.request<{ imagePath: string }>(`/api/projects/${encodeURIComponent(projectId)}/screens/${encodeURIComponent(screenId)}/capture`, { method: 'POST' }); }
  exportForFigma(projectId: string, screenId: string) { return this.request<{ html: string; text: string; screenId: string; screenName: string; nodeCount: number }>(`/api/projects/${encodeURIComponent(projectId)}/screens/${encodeURIComponent(screenId)}/figma`, { method: 'POST' }); }
  duplicateScreen(projectId: string, screenId: string, newId: string) { return this.request(`/api/projects/${encodeURIComponent(projectId)}/screens/${encodeURIComponent(screenId)}/duplicate`, { method: 'POST', body: JSON.stringify({ newId }) }); }
  createSnapshot(projectId: string) { return this.request<{ snapshotId: string }>(`/api/projects/${encodeURIComponent(projectId)}/snapshots`, { method: 'POST' }); }
  restoreSnapshot(projectId: string, snapshotId: string) { return this.request<{ backupSnapshotId: string }>(`/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`, { method: 'POST' }); }
  focusScreen(projectId: string, screenId: string) { return this.request<{ screenId: string; name: string; entry: string }>(`/api/projects/${encodeURIComponent(projectId)}/focus`, { method: 'PUT', body: JSON.stringify({ screenId }) }); }
  clearFocus(projectId: string) { return this.request<{ cleared: true }>(`/api/projects/${encodeURIComponent(projectId)}/focus`, { method: 'DELETE' }); }
  getEditing(projectId: string) { return this.request<{ session: { screenId: string; name: string; message: string; startedAt: string } | null }>(`/api/projects/${encodeURIComponent(projectId)}/editing`); }
  selectionNonce(projectId: string, screenId: string) { return this.request<{ nonce: string }>(`/api/projects/${encodeURIComponent(projectId)}/screens/${encodeURIComponent(screenId)}/selection-nonce`, { method: 'POST' }); }
  recordSelection(projectId: string, context: SelectionContext, nonce: string) { return this.request<SelectionContext>(`/api/projects/${encodeURIComponent(projectId)}/selection`, { method: 'POST', body: JSON.stringify({ context, nonce }) }); }
}

const previewStorageKey = 'local-canvas-preview-url';

export function readSession(): { previewUrl: string | null } {
  const hash = new URLSearchParams(location.hash.slice(1));
  const previewUrl = hash.get('previewUrl') ?? sessionStorage.getItem(previewStorageKey);
  if (hash.has('previewUrl')) {
    if (previewUrl) sessionStorage.setItem(previewStorageKey, previewUrl);
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  return { previewUrl };
}

export function savePreviewUrl(previewUrl: string): void {
  sessionStorage.setItem(previewStorageKey, previewUrl);
}

export function clearPreviewUrl(): void {
  sessionStorage.removeItem(previewStorageKey);
}

export function connectEvents(api: CanvasApi, onEvent: (event: CanvasEvent) => void, onState: (state: 'connected' | 'reconnecting') => void): () => void {
  const controller = new AbortController();
  let closed = false;
  const run = async () => {
    while (!closed) {
      try {
        const response = await fetch(`${api.baseUrl}/api/events`, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('Không kết nối được event stream.');
        onState('connected');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!closed) {
          const result = await reader.read();
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          let separator = buffer.indexOf('\n\n');
          while (separator >= 0) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            if (data) onEvent(JSON.parse(data.slice(6)) as CanvasEvent);
            separator = buffer.indexOf('\n\n');
          }
        }
      } catch {
        if (closed) return;
      }
      if (!closed) { onState('reconnecting'); await new Promise<void>((resolve) => setTimeout(resolve, 1_000)); }
    }
  };
  void run();
  return () => { closed = true; controller.abort(); };
}
