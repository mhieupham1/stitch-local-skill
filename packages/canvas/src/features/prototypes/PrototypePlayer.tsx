import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, PrototypeView, Screen } from '../../../../core/src/schema.js';
import { CanvasApi, connectEvents } from '../../api.js';

type PlayerData = { prototype: PrototypeView; project: Project; previewUrl: string };
// `id` is the frame's identity for React; `nonce` is its reload token, so a
// reload replaces the iframe without remounting the overlay around it.
type Frame = { id: string; screenId: string; overlay: boolean; nonce: string };
type FrameState = { ready: boolean; missing: string[] };

export function PrototypePlayer({ projectId, prototypeId }: { projectId: string; prototypeId: string }) {
  const api = useMemo(() => new CanvasApi(), []);
  const [data, setData] = useState<PlayerData | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [states, setStates] = useState<Record<string, FrameState>>({});
  const [error, setError] = useState<string | null>(null);
  const iframes = useRef(new Map<string, HTMLIFrameElement>());
  const loadCounts = useRef(new Map<string, number>());
  const revisionRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [prototype, project, preview] = await Promise.all([
        api.getPrototype(projectId, prototypeId), api.getProject(projectId), api.getPreview(),
      ]);
      if (revisionRef.current !== null && revisionRef.current !== prototype.revision) {
        setFrames((current) => current.map((frame) => ({ ...frame, nonce: crypto.randomUUID() })));
      }
      revisionRef.current = prototype.revision;
      setData({ prototype, project, previewUrl: preview.url });
      setFrames((current) => {
        const kept = current.filter((frame) => project.screens.some((screen) => screen.id === frame.screenId));
        // A run with no base screen left has nothing to stack overlays on.
        return kept.some((frame) => !frame.overlay)
          ? kept
          : [{ id: crypto.randomUUID(), screenId: prototype.startScreenId, overlay: false, nonce: crypto.randomUUID() }];
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được prototype hoặc preview.');
    }
  }, [api, projectId, prototypeId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => connectEvents(api, (event) => {
    if (event.projectId !== projectId) return;
    if (event.type === 'prototype.updated' || event.type === 'project.updated' || event.type === 'screen.changed') {
      void refresh();
      if (event.type === 'screen.changed') {
        setFrames((current) => current.map((frame) => event.screenIds.includes(frame.screenId) ? { ...frame, nonce: crypto.randomUUID() } : frame));
      }
    }
  }, () => undefined), [api, projectId, refresh]);

  const screenOf = useCallback((screenId: string) => data?.project.screens.find((screen) => screen.id === screenId) ?? null, [data]);
  // The base is the last screen pushed; anything stacked after it is an overlay.
  let baseIndex = -1;
  for (let index = frames.length - 1; index >= 0; index -= 1) if (!frames[index].overlay) { baseIndex = index; break; }
  const visible = baseIndex < 0 ? [] : frames.slice(baseIndex);
  const base = visible.find((frame) => !frame.overlay) ?? null;
  const overlays = visible.filter((frame) => frame.overlay);

  const closeTop = useCallback(() => setFrames((current) => current.length <= 1 ? current : current.slice(0, -1)), []);
  useEffect(() => {
    if (!overlays.length) return;
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') closeTop(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [overlays.length, closeTop]);

  const pending = visible.filter((frame) => !states[frame.nonce]?.ready).map((frame) => frame.nonce).join(',');
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setError('Preview không phản hồi. Hãy kiểm tra preview rồi bấm Tải lại.'), 8_000);
    return () => window.clearTimeout(timer);
  }, [pending]);

  useEffect(() => {
    if (!data) return;
    const handler = (event: MessageEvent) => {
      const frame = frames.find((candidate) => iframes.current.get(candidate.nonce)?.contentWindow === event.source);
      if (!frame) return;
      const message = event.data as { source?: string; kind?: string; nonce?: string; projectId?: string; screenId?: string; elementId?: string; found?: unknown; missingElementIds?: unknown };
      if (message.source !== 'local-design-canvas' || message.nonce !== frame.nonce || message.projectId !== projectId || message.screenId !== frame.screenId) return;
      const target = iframes.current.get(frame.nonce)?.contentWindow;
      const post = (payload: Record<string, unknown>) => target?.postMessage({ source: 'local-design-canvas', nonce: frame.nonce, projectId, screenId: frame.screenId, ...payload }, '*');
      if (message.kind === 'prototype.ready') {
        const elementIds = data.prototype.transitions.filter((link) => link.fromScreenId === frame.screenId).map((link) => link.elementId);
        post({ kind: 'prototype.init', elementIds });
        return;
      }
      if (message.kind === 'prototype.initialized') {
        const missing = Array.isArray(message.missingElementIds) ? message.missingElementIds.filter((id): id is string => typeof id === 'string') : [];
        setStates((current) => ({ ...current, [frame.nonce]: { ready: true, missing } }));
        setError((current) => current?.startsWith('Preview không phản hồi') ? null : current);
        return;
      }
      if (message.kind === 'prototype.scrolled') {
        if (message.found === false) setError(`Không tìm thấy mục tiêu cuộn ${String(message.elementId)} trong màn hình ${frame.screenId}.`);
        return;
      }
      if (message.kind === 'prototype.escape') { closeTop(); return; }
      if (message.kind !== 'prototype.click' || typeof message.elementId !== 'string' || !states[frame.nonce]?.ready) return;
      const link = data.prototype.transitions.find((candidate) => candidate.fromScreenId === frame.screenId && candidate.elementId === message.elementId);
      if (!link) return;
      if (link.kind === 'back') {
        setError(null);
        setFrames((current) => current.length <= 1 ? current : current.slice(0, -1));
        return;
      }
      if (link.kind === 'scroll') {
        if (!link.toElementId) return;
        setError(null);
        post({ kind: 'prototype.scroll', elementId: link.toElementId });
        return;
      }
      if (!link.toScreenId || !data.project.screens.some((screen) => screen.id === link.toScreenId)) {
        setError(`Liên kết ${message.elementId} trỏ tới màn hình không còn tồn tại: ${link.toScreenId}.`);
        return;
      }
      setError(null);
      const next: Frame = { id: crypto.randomUUID(), screenId: link.toScreenId, overlay: link.kind === 'overlay', nonce: crypto.randomUUID() };
      // A push starts a new run: any overlay the click came from is dismissed.
      setFrames((current) => link.kind === 'overlay' ? [...current, next] : [...current.filter((candidate) => !candidate.overlay), next]);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [data, frames, states, projectId]);

  const onFrameLoad = (frame: Frame) => {
    const loads = (loadCounts.current.get(frame.nonce) ?? 0) + 1;
    loadCounts.current.set(frame.nonce, loads);
    if (loads > 1) {
      setError('Giao diện tự điều hướng ngoài prototype; đã mở lại màn hình hiện tại.');
      setFrames((current) => current.map((candidate) => candidate.id === frame.id ? { ...candidate, nonce: crypto.randomUUID() } : candidate));
      return;
    }
    setStates((current) => ({ ...current, [frame.nonce]: { ready: false, missing: [] } }));
  };

  const frameUrl = (screen: Screen, nonce: string) => {
    if (!data) return null;
    const url = new URL(`/projects/${encodeURIComponent(projectId)}/${screen.entry}`, data.previewUrl);
    url.searchParams.set('screen', screen.id);
    url.searchParams.set('prototype', nonce);
    url.searchParams.set('parentOrigin', window.location.origin);
    return url.href;
  };

  const renderFrame = (frame: Frame, screen: Screen) => {
    const ready = states[frame.nonce]?.ready === true;
    return <>
      <div className="prototype-player-screen-name">{screen.name} · {frame.screenId}</div>
      <iframe
        key={frame.nonce}
        ref={(node) => { if (node) iframes.current.set(frame.nonce, node); else iframes.current.delete(frame.nonce); }}
        title={`Prototype: ${screen.name}`}
        src={frameUrl(screen, frame.nonce) ?? undefined}
        sandbox="allow-scripts"
        data-ready={ready}
        style={{ width: screen.width, height: screen.height, pointerEvents: ready ? 'auto' : 'none' }}
        onError={() => setError('Không tải được preview. Hãy kiểm tra server rồi bấm Tải lại.')}
        onLoad={() => onFrameLoad(frame)}
      />
    </>;
  };

  const baseScreen = base ? screenOf(base.screenId) : null;
  const missingIds = [...new Set(visible.flatMap((frame) => states[frame.nonce]?.missing ?? []))];
  const restart = () => {
    if (data) setFrames([{ id: crypto.randomUUID(), screenId: data.prototype.startScreenId, overlay: false, nonce: crypto.randomUUID() }]);
    setError(null);
  };
  const retry = () => {
    setError(null);
    loadCounts.current.clear();
    setStates({});
    setFrames((current) => current.map((frame) => ({ ...frame, nonce: crypto.randomUUID() })));
    void refresh();
  };

  return <main className="prototype-player">
    <header className="prototype-player-header">
      <div><h1>{data?.prototype.name ?? 'Prototype'}</h1><code>{projectId}/{prototypeId}</code></div>
      <button type="button" onClick={closeTop} disabled={frames.length <= 1}>Quay lại</button>
      <button type="button" onClick={restart} disabled={!data}>Chạy lại</button>
      <button type="button" onClick={retry}>Tải lại</button>
      <a href={`/?project=${encodeURIComponent(projectId)}${data ? `#previewUrl=${encodeURIComponent(data.previewUrl)}` : ''}`}>Về Canvas</a>
    </header>
    <div className="prototype-player-body">
      {data?.prototype.stale && <p className="prototype-player-warning" role="status">Cần tạo lại: UI gốc đã đổi. Play vẫn dùng giao diện mới nhất và liên kết đã lưu.</p>}
      {missingIds.length > 0 && <p className="prototype-player-warning" role="status">Không tìm thấy điểm bấm: {missingIds.join(', ')}. Hãy tạo lại prototype nếu liên kết đã đổi.</p>}
      {error && <p className="prototype-player-error" role="alert">{error} <button type="button" onClick={retry}>Thử lại</button></p>}
      {data && !baseScreen && <p className="prototype-player-error" role="alert">Màn hình hiện tại không còn tồn tại trong project. Hãy tạo lại prototype.</p>}
      {baseScreen && base && <div className="prototype-player-stage">{renderFrame(base, baseScreen)}</div>}
      {overlays.map((frame) => {
        const screen = screenOf(frame.screenId);
        if (!screen) return null;
        return <div className="prototype-player-overlay" key={frame.id}>
          <button type="button" className="prototype-player-scrim" aria-label={`Đóng lớp phủ ${screen.name}`} onClick={closeTop} />
          <div className="prototype-player-panel">
            {renderFrame(frame, screen)}
            <button type="button" className="prototype-player-overlay-close" onClick={closeTop}>Đóng lớp phủ</button>
          </div>
        </div>;
      })}
    </div>
  </main>;
}
