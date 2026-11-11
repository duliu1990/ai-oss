import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Dialog } from '../../../shared/Dialog';
import { errorMessage, isAbort } from '../api/client';
import type { Track } from '../api/types';
import { displayTitle } from '../library/metadata';
import { useRuntime } from '../player/context';

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
  return <Dialog open id="edit-dialog" titleId="edit-title" className="form-dialog" eyebrow="EDIT TRACK" title="编辑曲目信息" busy={busy} onClose={onClose} onSubmit={(event) => { void submit(event); }}>
    <p className="dialog-hint">默认显示 OSS 上 catalog.json 中的信息；这里填写的名称保存在服务端曲库并优先显示，留空即恢复 catalog.json 中的名称。不会修改 OSS 上的任何文件。此服务上的其他用户也能看到这些修改。</p>
    <p id="edit-key" className="dialog-key">OSS 对象：{track.key}</p>
    <label className="field">曲名<input id="edit-name" name="title" maxLength={200} autoComplete="off" value={title} placeholder={displayTitle({ ...track, title: '' })} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="field">歌手<input id="edit-artist" name="artist" maxLength={200} autoComplete="off" value={artist} placeholder={track.info.artist || ''} disabled={busy} onChange={(event) => setArtist(event.target.value)} /></label>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" id="edit-cancel" disabled={busy} onClick={onClose}>取消</button>
      <button className="solid-button" type="submit" id="edit-save" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
    </div>
  </Dialog>;
}
