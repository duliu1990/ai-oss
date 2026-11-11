import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { Icon } from '../../shared/Icon';
import { useToast } from '../../shared/Toast';
import { errorMessage, isAbort } from './api/client';
import type { LibraryView, SortOrder, Track } from './api/types';
import { EditDialog } from './components/EditDialog';
import { TrackList } from './components/TrackList';
import { useLibrary, usePlayer, useRuntime } from './player/context';

/** Favorite toggles come from both the track list and the shell's player bar. */
export function useFavoriteToggle(): (track: Track) => void {
  const { library } = useRuntime();
  const { notify } = useToast();
  return useCallback((track: Track) => {
    void library.updateMetadata(track.key, { favorite: !track.favorite }).catch((error: unknown) => {
      if (!isAbort(error)) notify(errorMessage(error), { error: true });
    });
  }, [library, notify]);
}

interface PlayerModuleProps {
  view: LibraryView;
  onView(view: LibraryView): void;
  query: string;
  onQuery(query: string): void;
  /** Owned by the shell, whose keyboard shortcut "/" focuses it. */
  search: RefObject<HTMLInputElement | null>;
  /** The visible tracks; the shell shares their keys with the player bar. */
  tracks: readonly Track[];
  keys: readonly string[];
  online: boolean;
  onFavorite(track: Track): void;
  /** Opens the shell's navigation drawer on narrow screens. */
  onMenu?: () => void;
}

export default function PlayerModule({ view, onView, query, onQuery, search, tracks, keys, online, onFavorite, onMenu }: PlayerModuleProps) {
  const { player, library } = useRuntime();
  const state = useLibrary();
  const playback = usePlayer();
  const { notify } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const edited = useMemo(() => state.tracks.find((track) => track.key === editing), [state.tracks, editing]);
  const onPlay = useCallback((key: string) => player.playFromList(key, keys), [player, keys]);

  // Some WebKit versions clear a search input with a native search event rather than input.
  useEffect(() => {
    const input = search.current!;
    const clear = () => onQuery(input.value);
    input.addEventListener('search', clear);
    return () => input.removeEventListener('search', clear);
  }, [search, onQuery]);

  const empty = state.base === null ? '请先设置服务地址。'
    : state.loading && !state.tracks.length ? '正在读取音乐列表…'
    : state.error && !state.tracks.length ? '曲库暂不可用，请检查服务配置后点击“刷新”。'
    : !state.tracks.length ? 'OSS 前缀下还没有音频文件。用 media-to-oss 下载并上传后，点击“刷新”。'
    : query ? '没有匹配的歌曲。' : '还没有喜欢的歌曲，点击曲目右侧的收藏按钮添加。';
  const notice = [!online ? '网络已断开。恢复连接后可刷新曲库，点击播放重试；不会自动播放。' : '', state.error, state.notice].filter(Boolean).join(' ');
  return <div className="player-module">
    <header className="mobile-header">
      {onMenu && <button id="menu-toggle" className="menu-toggle" type="button" aria-label="打开菜单" aria-controls="sidebar" onClick={onMenu}><Icon name="menu" /></button>}
      <div className="mobile-brand">轻云<span>MUSIC</span></div>
      <span className="mobile-status" role="status" aria-label={online ? '网络已连接' : '网络已断开'}><span className={`status-dot ${online ? '' : 'error'}`} /></span>
    </header>
    <main className="player-main" id="library" tabIndex={-1}>
      <header className="page-heading">
        <div className={`library-art ${view === 'favorites' ? 'is-favorites' : ''}`} aria-hidden="true"><span className="vinyl"><Icon name={view === 'favorites' ? 'heart-fill' : 'music'} /></span></div>
        <div>
          <p className="eyebrow">YOUR PERSONAL SOUNDTRACK</p>
          <h1 id="view-title">{view === 'favorites' ? '我喜欢' : '全部音乐'}<span>。</span></h1>
          <p id="view-subtitle" className="page-subtitle">{tracks.length} 首音乐 · {view === 'favorites' ? '把喜欢的旋律留在这里' : '你的私人云端音乐库'}</p>
        </div>
      </header>
      <nav className="library-tabs" aria-label="曲库分类">
        <button type="button" aria-pressed={view === 'all'} onClick={() => onView('all')}>全部音乐</button>
        <button type="button" aria-pressed={view === 'favorites'} onClick={() => onView('favorites')}><Icon name="heart" />我喜欢</button>
      </nav>
      <div className="player-toolbar">
        <label className="player-search"><span className="sr-only">搜索曲名、歌手或文件名</span><Icon name="search" />
          <input id="search" ref={search} type="search" value={query} placeholder="搜索歌曲、歌手或文件名" autoComplete="off" spellCheck={false} maxLength={200} onChange={(event) => onQuery(event.target.value)} />
        </label>
        <label className="player-sort"><span className="sr-only">排序方式</span><select id="sort" value={playback.sort} onChange={(event) => player.setSort(event.target.value as SortOrder)}><option value="recent">最近上传</option><option value="title">按曲名</option><option value="artist">按歌手</option></select></label>
        <button id="play-all" className="button button-dark" type="button" disabled={!tracks.length} onClick={() => player.playAll(keys)}><Icon name="play" />播放全部</button>
        <button id="refresh" className={`button ${state.loading ? 'is-loading' : ''}`} type="button" disabled={state.loading || state.base === null} onClick={() => { void library.refresh(); }}><Icon name="refresh" />刷新</button>
      </div>
      {notice && <div id="notice" className={`notice ${state.error || !online ? 'error' : ''}`} role="status">{notice}</div>}
      {playback.error && <div className="notice error playback-error" role="alert"><span>{playback.error}</span><button className="button" type="button" onClick={() => player.play(keys)}>重试播放</button></div>}
      <TrackList tracks={tracks} currentKey={playback.currentKey} playing={playback.playing} pending={state.pending} empty={empty} loading={state.loading} onPlay={onPlay} onFavorite={onFavorite} onEdit={setEditing} />
    </main>
    {edited && <EditDialog key={edited.key} track={edited} onClose={() => setEditing(null)} onSaved={() => notify('已保存曲目信息')} />}
  </div>;
}
