import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { errorMessage, isAbort } from '../api/client';
import type { DriveItem } from '../api/types';
import { extension, fileIcon, formatBytes, formatDate } from './FileItem';
import { Icon } from './Icon';

type PreviewType = 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'unknown';

const types: Record<Exclude<PreviewType, 'unknown'>, ReadonlySet<string>> = {
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif']),
  video: new Set(['mp4', 'webm', 'mov', 'm4v']),
  audio: new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']),
  text: new Set(['txt', 'md', 'json', 'yaml', 'yml', 'xml', 'csv', 'log', 'ini', 'toml']),
  pdf: new Set(['pdf']),
};

export function previewType(name: string): PreviewType {
  const ext = extension(name);
  for (const [type, extensions] of Object.entries(types) as [Exclude<PreviewType, 'unknown'>, ReadonlySet<string>][]) {
    if (extensions.has(ext)) return type;
  }
  return 'unknown';
}

interface PreviewModalProps {
  client: ApiClient;
  item: DriveItem | null;
  onClose: () => void;
  onDownload: (item: DriveItem) => void;
  onNotify: (message: string) => void;
}

export function PreviewModal({ client, item, onClose, onDownload, onNotify }: PreviewModalProps) {
  const modalRef = useRef<HTMLElement>(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const type = item ? previewType(item.name) : 'unknown';
  const url = item ? client.downloadUrl(item.key) : '';

  const exitFullscreen = useCallback(async () => {
    if (document.fullscreenElement !== modalRef.current) return;
    if (typeof document.exitFullscreen !== 'function') {
      onNotify('当前浏览器无法退出全屏，请按 Esc 键退出。');
      return;
    }
    try {
      await document.exitFullscreen();
    } catch {
      onNotify('退出全屏失败，请按 Esc 键重试。');
    }
  }, [onNotify]);

  const closePreview = useCallback(async () => {
    await exitFullscreen();
    onClose();
  }, [exitFullscreen, onClose]);

  const toggleFullscreen = useCallback(async () => {
    const modal = modalRef.current;
    if (!modal) return;
    if (document.fullscreenElement === modal) {
      await exitFullscreen();
      return;
    }
    if (typeof modal.requestFullscreen !== 'function') {
      onNotify('当前浏览器不支持全屏阅读。');
      return;
    }
    try {
      await modal.requestFullscreen();
    } catch {
      onNotify('无法进入全屏阅读，请检查浏览器权限后重试。');
    }
  }, [exitFullscreen, onNotify]);

  useEffect(() => {
    if (!item) return undefined;
    const previous = document.body.style.overflow;
    const modal = modalRef.current;
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === modal);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement !== modalRef.current) void closePreview();
    };
    document.body.style.overflow = 'hidden';
    syncFullscreen();
    document.addEventListener('fullscreenchange', syncFullscreen);
    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('fullscreenchange', syncFullscreen);
      globalThis.removeEventListener('keydown', onKeyDown);
      if (document.fullscreenElement === modal && typeof document.exitFullscreen === 'function') {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [closePreview, item]);

  useEffect(() => {
    if (!item || type !== 'text') {
      setText('');
      setError(null);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    client.text(item.key, controller.signal)
      .then(setText)
      .catch((reason: unknown) => { if (!isAbort(reason)) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, item, type]);

  const displayedText = useMemo(() => {
    if (extension(item?.name ?? '') !== 'json') return text;
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }, [item?.name, text]);

  if (!item) return null;
  return (
    <div className="modal-backdrop preview-backdrop" onMouseDown={() => void closePreview()} role="presentation">
      <section aria-labelledby="preview-title" aria-modal="true" className={`preview-modal preview-${type}`} onMouseDown={(event) => event.stopPropagation()} ref={modalRef} role="dialog">
        <header className="preview-head">
          <div className="preview-title-wrap">
            <span className={`file-glyph type-${fileIcon(item)}`}><Icon name={fileIcon(item)} size={24} /></span>
            <div><span className="eyebrow">PREVIEW / {type.toUpperCase()}</span><h2 id="preview-title">{item.name}</h2></div>
          </div>
          <div className="preview-actions">
            <button onClick={() => onDownload(item)} type="button"><Icon name="download" size={17} />下载</button>
            {type === 'pdf' && (
              <button aria-label={isFullscreen ? '退出全屏' : '全屏'} className="fullscreen-button" onClick={() => void toggleFullscreen()} type="button">
                <Icon name={isFullscreen ? 'fullscreen-exit' : 'fullscreen'} size={17} />{isFullscreen ? '退出全屏' : '全屏'}
              </button>
            )}
            <button aria-label="关闭预览" className="icon-button" onClick={() => void closePreview()} type="button"><Icon name="close" /></button>
          </div>
        </header>
        <div className="preview-stage">
          {type === 'image' && <img alt={item.name} src={url} />}
          {type === 'video' && <video controls playsInline preload="metadata" src={url} />}
          {type === 'audio' && (
            <div className="audio-preview">
              <div className="audio-disc"><Icon name="audio" size={54} /></div>
              <strong>{item.name}</strong>
              <audio controls preload="metadata" src={url} />
            </div>
          )}
          {type === 'pdf' && <iframe src={url} title={`PDF 预览：${item.name}`} />}
          {type === 'text' && (
            <div className="text-preview">
              {loading && <div className="preview-loading">正在读取文本…</div>}
              {error && <div className="state-card error-state"><span>!</span><p>{error}</p></div>}
              {!loading && !error && <pre><code>{displayedText}</code></pre>}
            </div>
          )}
          {type === 'unknown' && (
            <div className="unsupported-preview">
              <div className="unknown-glyph"><Icon name="file" size={54} /></div>
              <span className="eyebrow">NO INLINE VIEWER</span>
              <h3>此格式暂不支持在线预览</h3>
              <p>您仍可以安全下载并在本地应用中打开它。</p>
              <button className="primary-action" onClick={() => onDownload(item)} type="button"><Icon name="download" size={18} />下载文件</button>
            </div>
          )}
        </div>
        <footer className="preview-meta"><span>{formatBytes(item.size)}</span><span>{formatDate(item.lastModified)}</span><span title={item.key}>{item.key}</span></footer>
      </section>
    </div>
  );
}
