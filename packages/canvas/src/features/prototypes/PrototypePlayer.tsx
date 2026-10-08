import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, PrototypeView } from '../../../../core/src/schema.js';
import { CanvasApi, connectEvents } from '../../api.js';

type PlayerData = { prototype: PrototypeView; project: Project; previewUrl: string };
type Navigation = { history: string[]; nonce: string };

export function PrototypePlayer({ projectId, prototypeId }: { projectId: string; prototypeId: string }) {
  const api = useMemo(() => new CanvasApi(), []);
  const [data, setData] = useState<PlayerData | null>(null);
  const [navigation, setNavigation] = useState<Navigation>({ history: [], nonce: crypto.randomUUID() });
  const [readyNonce, setReadyNonce] = useState<string | null>(null);
  const [missingIds, setMissingIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadCountRef = useRef(0);
  const revisionRef = useRef<number | null>(null);
  const currentScreenRef = useRef<string | null>(null);
  currentScreenRef.current = navigation.history.at(-1) ?? null;

  const refresh = useCallback(async () => {
    try {
      const [prototype, project, preview] = await Promise.all([
        api.getPrototype(projectId, prototypeId), api.getProject(projectId), api.getPreview(),
      ]);
      if (revisionRef.current !== null && revisionRef.current !== prototype.revision) {
        setNavigation((current) => ({ ...current, nonce: crypto.randomUUID() }));
      }
      revisionRef.current = prototype.revision;
      setData({ prototype, project, previewUrl: preview.url });
      setNavigation((current) => current.history.length ? current : { history: [prototype.startScreenId], nonce: crypto.randomUUID() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được prototype hoặc preview.');
    }
  }, [api, projectId, prototypeId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => connectEvents(api, (event) => {
    if (event.projectId !== projectId) return;
    if (event.type === 'prototype.updated' || event.type === 'project.updated' || event.type === 'screen.changed') {
      void refresh();
      if (event.type === 'screen.changed' && currentScreenRef.current && event.screenIds.includes(currentScreenRef.current)) {
        setNavigation((current) => ({ ...current, nonce: crypto.randomUUID() }));
      }
    }
  }, () => undefined), [api, projectId, refresh]);

  const currentScreenId = navigation.history.at(-1) ?? null;
  const currentScreen = data?.project.screens.find((screen) => screen.id === currentScreenId) ?? null;
  const source = data && currentScreen ? new URL(`/projects/${encodeURIComponent(projectId)}/${currentScreen.entry}`, data.previewUrl) : null;
  if (source && currentScreenId) {
    source.searchParams.set('screen', currentScreenId);
    source.searchParams.set('prototype', navigation.nonce);
    source.searchParams.set('parentOrigin', window.location.origin);
  }
  const sourceUrl = source?.href ?? null;

  useEffect(() => {
    setReadyNonce(null);
    setMissingIds([]);
    loadCountRef.current = 0;
  }, [sourceUrl]);

  useEffect(() => {
    if (!sourceUrl || readyNonce === navigation.nonce) return;
    const timer = window.setTimeout(() => setError('Preview không phản hồi. Hãy kiểm tra preview rồi bấm Tải lại.'), 8_000);
    return () => window.clearTimeout(timer);
  }, [sourceUrl, readyNonce, navigation.nonce]);

  useEffect(() => {
    if (!data || !currentScreenId) return;
    const handler = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const message = event.data as { source?: string; kind?: string; nonce?: string; projectId?: string; screenId?: string; elementId?: string; missingElementIds?: unknown };
      if (message.source !== 'local-design-canvas' || message.nonce !== navigation.nonce || message.projectId !== projectId || message.screenId !== currentScreenId) return;
      if (message.kind === 'prototype.ready') {
        const elementIds = data.prototype.transitions.filter((link) => link.fromScreenId === currentScreenId).map((link) => link.elementId);
        iframeRef.current.contentWindow?.postMessage({ source: 'local-design-canvas', kind: 'prototype.init', nonce: navigation.nonce, projectId, screenId: currentScreenId, elementIds }, '*');
      } else if (message.kind === 'prototype.initialized') {
        setReadyNonce(navigation.nonce);
        setMissingIds(Array.isArray(message.missingElementIds) ? message.missingElementIds.filter((id): id is string => typeof id === 'string') : []);
        setError((current) => current?.startsWith('Preview không phản hồi') ? null : current);
      } else if (message.kind === 'prototype.click' && readyNonce === navigation.nonce && typeof message.elementId === 'string') {
        const link = data.prototype.transitions.find((candidate) => candidate.fromScreenId === currentScreenId && candidate.elementId === message.elementId);
        if (!link) return;
        if (!data.project.screens.some((screen) => screen.id === link.toScreenId)) {
          setError(`Liên kết ${message.elementId} trỏ tới màn hình không còn tồn tại: ${link.toScreenId}.`);
          return;
        }
        setError(null);
        setNavigation((current) => ({ history: [...current.history, link.toScreenId], nonce: crypto.randomUUID() }));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [data, currentScreenId, navigation.nonce, projectId, readyNonce]);

  const back = () => setNavigation((current) => ({ history: current.history.slice(0, -1), nonce: crypto.randomUUID() }));
  const restart = () => {
    if (data) setNavigation({ history: [data.prototype.startScreenId], nonce: crypto.randomUUID() });
    setError(null);
  };
  const retry = () => {
    setError(null);
    setReadyNonce(null);
    setNavigation((current) => ({ ...current, nonce: crypto.randomUUID() }));
    void refresh();
  };

  return <main className="prototype-player">
    <header className="prototype-player-header">
      <div><h1>{data?.prototype.name ?? 'Prototype'}</h1><code>{projectId}/{prototypeId}</code></div>
      <button type="button" onClick={back} disabled={navigation.history.length <= 1}>Quay lại</button>
      <button type="button" onClick={restart} disabled={!data}>Chạy lại</button>
      <button type="button" onClick={retry}>Tải lại</button>
      <a href={`/?project=${encodeURIComponent(projectId)}${data ? `#previewUrl=${encodeURIComponent(data.previewUrl)}` : ''}`}>Về Canvas</a>
    </header>
    {data?.prototype.stale && <p className="prototype-player-warning" role="status">Cần tạo lại: UI gốc đã đổi. Play vẫn dùng giao diện mới nhất và liên kết đã lưu.</p>}
    {missingIds.length > 0 && <p className="prototype-player-warning" role="status">Không tìm thấy điểm bấm: {missingIds.join(', ')}. Hãy tạo lại prototype nếu liên kết đã đổi.</p>}
    {error && <p className="prototype-player-error" role="alert">{error} <button type="button" onClick={retry}>Thử lại</button></p>}
    {data && !currentScreen && <p className="prototype-player-error" role="alert">Màn hình hiện tại không còn tồn tại trong project. Hãy tạo lại prototype.</p>}
    {sourceUrl && currentScreen && <div className="prototype-player-stage"><div className="prototype-player-screen-name">{currentScreen.name} · {currentScreenId}</div><iframe
      key={navigation.nonce}
      ref={iframeRef}
      title={`Prototype: ${currentScreen.name}`}
      src={sourceUrl}
      sandbox="allow-scripts"
      data-ready={readyNonce === navigation.nonce}
      style={{ width: currentScreen.width, height: currentScreen.height, pointerEvents: readyNonce === navigation.nonce ? 'auto' : 'none' }}
      onError={() => setError('Không tải được preview. Hãy kiểm tra server rồi bấm Tải lại.')}
      onLoad={() => {
        loadCountRef.current += 1;
        if (loadCountRef.current > 1) {
          setError('Giao diện tự điều hướng ngoài prototype; đã mở lại màn hình hiện tại.');
          setNavigation((current) => ({ ...current, nonce: crypto.randomUUID() }));
        }
      }}
    /></div>}
  </main>;
}
