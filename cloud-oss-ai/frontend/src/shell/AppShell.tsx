import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppSidebar } from '../shared/AppSidebar';
import type { NavGroup, SidebarStatus } from '../shared/AppSidebar';
import { ConnectionDialog } from '../shared/ConnectionDialog';
import { LoginPage } from '../shared/LoginPage';
import { browserStorage, platform, storedOrigin } from '../shared/platform/connection';
import { initialBase } from '../shared/session';
import { useToast } from '../shared/Toast';
import DriveModule from '../modules/drive/DriveModule';
import { api, DriveApi } from '../modules/drive/api/client';
import PlayerModule, { useFavoriteToggle } from '../modules/player/PlayerModule';
import type { LibraryView } from '../modules/player/api/types';
import { PlayerBar } from '../modules/player/components/PlayerBar';
import { FullPlayer } from '../modules/player/components/FullPlayer';
import { visibleTracks } from '../modules/player/library/metadata';
import { useLibrary, usePlayer, useRuntime } from '../modules/player/player/context';
import { useForegroundControls, useOnline } from '../modules/player/player/useForegroundControls';

type Route = 'files' | 'notes' | 'music' | 'favorites';
type Module = 'drive' | 'player';

const routes: Record<string, Route> = {
  '#/files': 'files',
  '#/notes': 'notes',
  '#/music': 'music',
  '#/music/favorites': 'favorites',
};
const moduleOf = (route: Route): Module => (route === 'files' || route === 'notes' ? 'drive' : 'player');
const mobileQuery = '(max-width: 760px), (max-width: 1024px) and (max-height: 500px)';

function currentRoute(): Route {
  const route = routes[globalThis.location.hash];
  if (route) return route;
  // Unknown or empty hashes land on the drive without adding a history entry.
  history.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search}#/files`);
  return 'files';
}

function useRoute(): Route {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const update = () => setRoute(currentRoute());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

function useMobile(onChange: () => void): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(mobileQuery).matches);
  useEffect(() => {
    const media = window.matchMedia(mobileQuery);
    const update = () => { setMobile(media.matches); onChange(); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [onChange]);
  return mobile;
}

function Workspace({ onSettings }: { onSettings?: () => void }) {
  const { player, library, native } = useRuntime();
  const state = useLibrary();
  const playback = usePlayer();
  const { notify } = useToast();
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const mobile = useMobile(closeMenu);
  const drawerOpen = mobile && menuOpen;
  const [editorOpen, setEditorOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapse = useCallback(() => setExpanded(false), []);
  const active = moduleOf(route);
  // The drive gets the whole viewport: the bar is hidden there while the shared engine keeps playing.
  const playerShown = active === 'player';
  // Leaving the music routes also folds the full-screen player away.
  if (expanded && !playerShown) setExpanded(false);
  const fullOpen = expanded && playerShown;
  const covered = drawerOpen || editorOpen || fullOpen;
  // The text editor renders inside the drive, which already inerts its own page behind it;
  // inerting #content as well would freeze the editor itself.
  const contentInert = drawerOpen || fullOpen;

  // Each module mounts on first visit and then stays mounted, so switching keeps folders,
  // scroll positions and the music search intact.
  const [seen, setSeen] = useState<ReadonlySet<Module>>(() => new Set([active]));
  if (!seen.has(active)) setSeen(new Set([...seen, active]));

  const view: LibraryView = route === 'favorites' ? 'favorites' : 'all';
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const online = useOnline();
  const tracks = useMemo(() => visibleTracks(state.tracks, view, query, playback.sort), [state.tracks, view, query, playback.sort]);
  const keys = useMemo(() => tracks.map((track) => track.key), [tracks]);
  const current = useMemo(() => state.tracks.find((track) => track.key === playback.currentKey), [state.tracks, playback.currentKey]);
  const favorites = useMemo(() => state.tracks.filter((track) => track.favorite).length, [state.tracks]);
  const onFavorite = useFavoriteToggle();
  useForegroundControls(player, keys, search, current, playback.playing, active === 'player');

  useEffect(() => {
    document.body.classList.toggle('player-hidden', !playerShown);
    return () => { document.body.classList.remove('player-hidden'); };
  }, [playerShown]);

  const client = useMemo(() => (state.base === initialBase ? api : new DriveApi(state.base ?? '')), [state.base]);
  const selectView = useCallback((next: LibraryView) => {
    globalThis.location.hash = next === 'favorites' ? '#/music/favorites' : '#/music';
  }, []);

  const groups: readonly NavGroup[] = [
    { label: '云盘', items: [
      { id: 'files', label: '文件', icon: 'folder', href: '#/files' },
      { id: 'notes', label: '笔记', icon: 'note', href: '#/notes' },
    ] },
    { label: '音乐', items: [
      { id: 'music', label: '全部音乐', icon: 'music', href: '#/music', count: state.tracks.length },
      { id: 'favorites', label: '我喜欢', icon: 'heart', href: '#/music/favorites', count: favorites },
    ] },
  ];
  const config = state.config;
  const prefix = !config ? '' : route === 'files' ? config.drive_prefix : route === 'notes' ? config.note_prefix : config.media_prefix;
  const status: SidebarStatus = !online ? { tone: 'error', label: '网络已断开', detail: '恢复连接后再刷新。' }
    : state.error && !config ? { tone: 'error', label: '服务不可用', detail: state.error }
    : config?.oss_ready ? { tone: '', label: 'OSS 已配置', detail: `${config.bucket} / ${prefix}` }
    : config ? { tone: 'warn', label: 'OSS 未配置', detail: `缺少：${config.oss_missing.join('、')}` }
    : { tone: 'neutral', label: '正在读取配置…', detail: '私有 OSS，经服务转发。' };

  return <>
    <a className="skip-link" href="#content" inert={covered} onClick={(event) => {
      // The hash is the router, so the skip link moves focus without navigating.
      event.preventDefault();
      document.getElementById('content')?.focus();
    }}>跳到主要内容</a>
    {drawerOpen && <div className="menu-backdrop" aria-hidden="true" onClick={closeMenu} />}
    <AppSidebar groups={groups} active={route} status={status} mobile={mobile} open={drawerOpen} inert={editorOpen || fullOpen}
      onClose={closeMenu}
      onLogout={() => { closeMenu(); library.logout(); }}
      onSettings={onSettings && (() => { closeMenu(); onSettings(); })} />
    <div className="app-content" id="content" tabIndex={-1} inert={contentInert}>
      {seen.has('drive') && <div className="module-frame" hidden={active !== 'drive'}>
        <DriveModule section={route === 'notes' ? 'notes' : 'files'} client={client}
          onMenu={mobile ? openMenu : undefined} onBackgroundInert={setEditorOpen} />
      </div>}
      {seen.has('player') && <div className="module-frame" hidden={active !== 'player'}>
        <PlayerModule view={view} onView={selectView} query={query} onQuery={setQuery} search={search}
          tracks={tracks} keys={keys} online={online} onFavorite={onFavorite} onMenu={mobile ? openMenu : undefined} />
      </div>}
    </div>
    {/* The player bar sits outside the modules and only shows on music routes; playback never stops on a switch.
        In the app layout its track info opens the full-screen player, which covers the bar until it is closed. */}
    {playerShown && <div inert={covered}><PlayerBar track={current} keys={keys} pending={!!current && state.pending.has(current.key)} onFavorite={onFavorite} onMessage={notify}
      onExpand={mobile || native ? () => setExpanded(true) : undefined} /></div>}
    {fullOpen && <FullPlayer track={current} keys={keys} pending={!!current && state.pending.has(current.key)} onFavorite={onFavorite} onMessage={notify} onClose={collapse} />}
  </>;
}

export default function AppShell() {
  const { library, native } = useRuntime();
  const state = useLibrary();
  const { notify } = useToast();
  const [settings, setSettings] = useState(false);
  const openSettings = native ? () => setSettings(true) : undefined;
  // Native builds must choose a server before anything else; the dialog cannot be dismissed until then.
  const connection = native && (settings || state.base === null) && <ConnectionDialog
    initialValue={state.base || storedOrigin(browserStorage()) || platform.preset}
    connected={state.base !== null}
    onConnect={(value) => library.connect(value)}
    onClose={() => setSettings(false)}
    onMessage={(message) => notify(message)} />;

  if (state.base !== null && !state.authenticated) {
    return <>
      <LoginPage key={state.base} base={state.base} authReady={state.authReady} onCheckAuth={library.checkAuthReady}
        onLogin={(username, password) => library.login(username, password)} onSettings={openSettings} />
      {connection}
    </>;
  }
  // Without a server the modules have nothing to talk to; only the connection dialog is shown.
  if (state.base === null) return connection || null;
  return <>
    {/* A server switch resets the modules' UI state but never the single shared Audio engine. */}
    <Workspace key={state.base} onSettings={openSettings} />
    {connection}
  </>;
}
