import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, isAbort } from './api/client';
import type { LibraryView, SortOrder, Track } from './api/types';
import { ConnectionDialog, EditDialog } from './components/Dialogs';
import { Icon } from './components/Icon';
import { PlayerBar } from './components/PlayerBar';
import { Sidebar } from './components/Sidebar';
import { TrackList } from './components/TrackList';
import { visibleTracks } from './library/metadata';
import { browserStorage, platform, storedOrigin } from './platform/connection';
import { useLibrary, usePlayer, useRuntime } from './player/context';
import { useForegroundControls, useOnline } from './player/useForegroundControls';

function PlayerScreen() {
  const { player, library, native } = useRuntime();
  const state = useLibrary();
  const playback = usePlayer();
  const [view, setView] = useState<LibraryView>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const online = useOnline();
  const tracks = useMemo(() => visibleTracks(state.tracks, view, query, playback.sort), [state.tracks, view, query, playback.sort]);
  const keys = useMemo(() => tracks.map((track) => track.key), [tracks]);
  const current = useMemo(() => state.tracks.find((track) => track.key === playback.currentKey), [state.tracks, playback.currentKey]);
  const edited = useMemo(() => state.tracks.find((track) => track.key === editing), [state.tracks, editing]);
  const showMessage = useCallback((message: string, error = false) => setToast({ message, error }), []);
  const onPlay = useCallback((key: string) => player.playFromList(key, keys), [player, keys]);
  const onFavorite = useCallback((track: Track) => {
    void library.updateMetadata(track.key, { favorite: !track.favorite }).catch((error: unknown) => {
      if (!isAbort(error)) showMessage(errorMessage(error), true);
    });
  }, [library, showMessage]);
  useForegroundControls(player, keys, search, current, playback.playing);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.error ? 6000 : 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Some WebKit versions clear a search input with a native search event rather than input.
  useEffect(() => {
    const input = search.current!;
    const clear = () => setQuery(input.value);
    input.addEventListener('search', clear);
    return () => input.removeEventListener('search', clear);
  }, []);

  const empty = state.base === null ? '请先设置播放服务地址。'
    : state.loading && !state.tracks.length ? '正在读取音乐列表…'
    : state.error && !state.tracks.length ? '曲库暂不可用，请检查服务配置后点击“刷新”。'
    : !state.tracks.length ? 'OSS 前缀下还没有音频文件。用 media-to-oss 下载并上传后，点击“刷新”。'
    : query ? '没有匹配的歌曲。' : '还没有喜欢的歌曲，点击曲目右侧的收藏按钮添加。';
  const notice = [!online ? '网络已断开。恢复连接后可刷新曲库，点击播放重试；不会自动播放。' : '', state.error, state.notice].filter(Boolean).join(' ');
  return <>
    <a className="skip-link" href="#library">跳到曲库</a>
    <div className="app-shell">
      <Sidebar state={state} view={view} native={native} online={online} onView={setView} onSettings={() => setSettings(true)} />
      <main className="main" id="library" tabIndex={-1}>
        <header className="page-heading"><div>
          <p className="eyebrow">YOUR MUSIC, FROM YOUR OWN CLOUD.</p>
          <h1 id="view-title">{view === 'favorites' ? '我喜欢' : '全部音乐'}<span>。</span></h1>
          <p id="view-subtitle" className="page-subtitle">{view === 'favorites' ? '收藏的歌曲保存在服务端曲库文件中。' : '读取 OSS 前缀下的音频文件，点击即可播放。'}</p>
        </div></header>
        <div className="toolbar">
          <label className="search"><span className="sr-only">搜索曲名、歌手或文件名</span><Icon name="search" />
            <input id="search" ref={search} type="search" value={query} placeholder="搜索曲名、歌手或文件名（按 / 聚焦）" autoComplete="off" spellCheck={false} maxLength={200} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label className="sort"><span className="sr-only">排序方式</span><select id="sort" value={playback.sort} onChange={(event) => player.setSort(event.target.value as SortOrder)}><option value="recent">最近上传</option><option value="title">按曲名</option><option value="artist">按歌手</option></select></label>
          <button id="play-all" className="button button-dark" type="button" disabled={!tracks.length} onClick={() => player.playAll(keys)}><Icon name="play" />播放全部</button>
          <button id="refresh" className={`button ${state.loading ? 'is-loading' : ''}`} type="button" disabled={state.loading || state.base === null} onClick={() => { void library.refresh(); }}><Icon name="refresh" />刷新</button>
        </div>
        {notice && <div id="notice" className={`notice ${state.error || !online ? 'error' : ''}`} role="status">{notice}</div>}
        {playback.error && <div className="notice error playback-error" role="alert"><span>{playback.error}</span><button className="button" type="button" onClick={() => player.play(keys)}>重试播放</button></div>}
        <TrackList tracks={tracks} currentKey={playback.currentKey} playing={playback.playing} pending={state.pending} empty={empty} loading={state.loading} onPlay={onPlay} onFavorite={onFavorite} onEdit={setEditing} />
      </main>
    </div>
    <PlayerBar track={current} keys={keys} pending={!!current && state.pending.has(current.key)} onFavorite={onFavorite} onMessage={showMessage} />
    {edited && <EditDialog key={edited.key} track={edited} onClose={() => setEditing(null)} onSaved={() => showMessage('已保存曲目信息')} />}
    {native && (settings || state.base === null) && <ConnectionDialog initialValue={state.base || storedOrigin(browserStorage()) || platform.preset} connected={state.base !== null} onClose={() => setSettings(false)} onMessage={showMessage} />}
    {toast && <div id="toast" className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.message}</div>}
  </>;
}

export default function App() {
  const { base } = useLibrary();
  // A service switch resets only UI state, never the single shared Audio engine.
  return <PlayerScreen key={base ?? 'disconnected'} />;
}
