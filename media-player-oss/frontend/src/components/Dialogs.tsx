import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { errorMessage, isAbort } from '../api/client';
import type { Track } from '../api/types';
import { displayTitle } from '../library/metadata';
import { useRuntime } from '../player/context';

function Dialog({ id, titleId, children, onCancel, busy = false }: { id: string; titleId: string; children: ReactNode; onCancel(): void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [fallback] = useState(() => typeof HTMLDialogElement === 'undefined' || !('showModal' in HTMLDialogElement.prototype));
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <>
    {fallback && <div className="dialog-shade" aria-hidden="true" />}
    <dialog id={id} className={`dialog ${fallback ? 'dialog-fallback' : ''}`} ref={ref} aria-labelledby={titleId} aria-modal="true" onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}
      onKeyDown={(event) => {
        if (!fallback) return;
        if (event.key === 'Escape') { event.preventDefault(); if (!busy) onCancel(); }
        if (event.key === 'Tab') {
          const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')];
          const first = elements[0];
          const last = elements[elements.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>{children}</dialog>
  </>;
}

export function EditDialog({ track, onClose, onSaved }: { track: Track; onClose(): void; onSaved(): void }) {
  const { library } = useRuntime();
  // The inputs contain overrides only. Catalog values are placeholders, not saved edits.
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await library.updateMetadata(track.key, { title, artist });
      if (mounted.current) { onSaved(); onClose(); }
    } catch (failure) {
      if (mounted.current && !isAbort(failure)) setError(errorMessage(failure));
    } finally { if (mounted.current) setBusy(false); }
  };
  return <Dialog id="edit-dialog" titleId="edit-title" onCancel={onClose} busy={busy}>
    <form id="edit-form" onSubmit={(event) => { void submit(event); }}>
      <h2 id="edit-title">编辑曲目信息</h2>
      <p className="dialog-hint">默认显示 OSS 上 catalog.json 中的信息；这里填写的名称保存在服务端曲库并优先显示，留空即恢复 catalog.json 中的名称。不会修改 OSS 上的任何文件。此服务上的其他用户也能看到这些修改。</p>
      <p id="edit-key" className="dialog-key">OSS 对象：{track.key}</p>
      <label className="field">曲名<input id="edit-name" name="title" maxLength={200} autoComplete="off" value={title} placeholder={displayTitle({ ...track, title: '' })} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="field">歌手<input id="edit-artist" name="artist" maxLength={200} autoComplete="off" value={artist} placeholder={track.info.artist || ''} disabled={busy} onChange={(event) => setArtist(event.target.value)} /></label>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button" type="button" id="edit-cancel" disabled={busy} onClick={onClose}>取消</button><button className="button button-dark" type="submit" id="edit-save" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div>
    </form>
  </Dialog>;
}

export function ConnectionDialog({ initialValue, connected, onClose, onMessage }: { initialValue: string; connected: boolean; onClose(): void; onMessage(message: string): void }) {
  const { library } = useRuntime();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const persisted = library.connect(value);
      onMessage(persisted ? '连接地址已保存，正在读取曲库。' : '正在连接；本机存储不可用，下次需重新输入地址。');
      onClose();
    } catch (failure) { setError(errorMessage(failure)); }
  };
  return <Dialog id="connection-dialog" titleId="connection-title" onCancel={() => { if (connected) onClose(); }}>
    <form onSubmit={submit}>
      <h2 id="connection-title">连接播放服务</h2>
      <p className="dialog-hint">输入公开播放服务的 HTTPS 地址，仅含域名和可选端口。无需账号、密码或 OSS 凭据。</p>
      <label className="field connection-field">服务地址<input id="server-origin" type="url" required value={value} maxLength={2048} placeholder="https://music.example.com" autoCapitalize="none" autoCorrect="off" autoComplete="url" spellCheck={false} onChange={(event) => setValue(event.target.value)} /></label>
      <p className="dialog-hint">切换服务会停止播放并清除旧曲库、队列和播放进度。当前仅支持前台在线播放，不提供后台、锁屏或离线播放。</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions">{connected && <button className="button" type="button" onClick={onClose}>取消</button>}<button className="button button-dark" type="submit">保存并连接</button></div>
    </form>
  </Dialog>;
}
