import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerApi } from '../../src/modules/player/api/client';
import { LibraryStore } from '../../src/modules/player/library/store';
import { RuntimeProvider } from '../../src/modules/player/player/context';
import { PlayerEngine } from '../../src/modules/player/player/engine';
import { tokens } from '../../src/shared/session';
import { ToastProvider } from '../../src/shared/Toast';
import AppShell from '../../src/shell/AppShell';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const config = { oss_ready: true, oss_missing: [], bucket: 'darren-note', drive_prefix: 'driver/', note_prefix: 'my-note/', media_prefix: 'media/' };
const tracks = ['media/a.mp3', 'media/b.mp3'].map((key, index) => ({
  key, name: key.slice(6), title: '', artist: '', favorite: index === 0, size: 1, last_modified: '2026-01-01T00:00:00Z', info: {},
}));

function signedToken(): string {
  const payload = btoa(JSON.stringify({ sub: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.signature`;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let library: LibraryStore | null = null;
let player: PlayerEngine | null = null;
let requests: string[] = [];

beforeEach(() => {
  requests = [];
  history.replaceState(null, '', '/#/files');
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url.pathname);
    if (url.pathname === '/api/config') return json(config);
    if (url.pathname === '/api/tracks') return json({ tracks, prefix: 'media/', truncated: false, catalog_error: null });
    if (url.pathname === '/api/files') return json({ files: [], folders: [], next_marker: null, truncated: false });
    if (url.pathname === '/api/auth/status') return json({ auth_required: true, auth_ready: true });
    return json({ detail: 'Not Found' }, 404);
  }));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  library?.dispose();
  player?.destroy();
  library = null;
  player = null;
  tokens.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise((resolve) => globalThis.setTimeout(resolve, 0)); });
  }
}

async function renderShell() {
  const audio = document.createElement('audio');
  player = new PlayerEngine(audio, new PlayerApi('', undefined, tokens), undefined, false, '');
  library = new LibraryStore(player, { native: false, base: '', tokens });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const runtime = { player, library, native: false };
  await act(async () => {
    root?.render(createElement(RuntimeProvider, { runtime, children: createElement(ToastProvider, null, createElement(AppShell)) }));
  });
  await act(async () => { await library?.refresh(); });
  await settle();
  return container;
}

async function navigate(hash: string) {
  await act(async () => {
    history.replaceState(null, '', `/${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await settle();
}

describe('app shell', () => {
  it('asks for a login before mounting any module', async () => {
    const host = await renderShell();
    expect(host.querySelector('.login-page')).not.toBeNull();
    expect(host.querySelector('#sidebar')).toBeNull();
    expect(requests).not.toContain('/api/files');
    expect(requests).not.toContain('/api/tracks');
  });

  it('shares one session across the drive and the player and keeps both mounted', async () => {
    tokens.save(signedToken());
    const host = await renderShell();
    const links = [...host.querySelectorAll<HTMLAnchorElement>('#sidebar .nav-link')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#/files', '#/notes', '#/music', '#/music/favorites']);
    expect(host.querySelector('.nav-link.is-active')?.getAttribute('data-view')).toBe('files');
    expect(host.querySelector('#count-music')?.textContent).toBe('2');
    expect(host.querySelector('#count-favorites')?.textContent).toBe('1');
    expect(host.querySelector('#oss-detail')?.textContent).toBe('darren-note / driver/');
    expect(host.querySelector('.drive-module')).not.toBeNull();
    expect(host.querySelector('.player-module')).toBeNull();
    // The drive hides the player bar and releases the room it reserved.
    expect(host.querySelector('footer.player')).toBeNull();
    expect(document.body.classList.contains('player-hidden')).toBe(true);

    await navigate('#/music');
    expect(host.querySelector('.nav-link.is-active')?.getAttribute('data-view')).toBe('music');
    expect(host.querySelector('#oss-detail')?.textContent).toBe('darren-note / media/');
    expect(host.querySelector('.player-module')?.closest('.module-frame')?.hasAttribute('hidden')).toBe(false);
    // The drive stays mounted behind the player so its folder and scroll survive the switch.
    expect(host.querySelector('.drive-module')?.closest('.module-frame')?.hasAttribute('hidden')).toBe(true);
    expect(host.querySelectorAll('#track-list li[data-key]').length).toBe(2);
    expect(host.querySelector('footer.player')).not.toBeNull();
    expect(document.body.classList.contains('player-hidden')).toBe(false);

    await navigate('#/music/favorites');
    expect(host.querySelector('#view-title')?.textContent).toContain('我喜欢');
    expect(host.querySelector('footer.player')).not.toBeNull();

    await navigate('#/notes');
    expect(host.querySelector('footer.player')).toBeNull();
    expect(document.body.classList.contains('player-hidden')).toBe(true);
  });

  it('sends unknown routes to the files section', async () => {
    tokens.save(signedToken());
    history.replaceState(null, '', '/#/nowhere');
    const host = await renderShell();
    expect(globalThis.location.hash).toBe('#/files');
    expect(host.querySelector('.nav-link.is-active')?.getAttribute('data-view')).toBe('files');
  });

  it('logging out from the shared sidebar returns every module to the login page', async () => {
    tokens.save(signedToken());
    const host = await renderShell();
    await act(async () => host.querySelector<HTMLButtonElement>('#logout')?.click());
    await settle();
    expect(tokens.token()).toBeNull();
    expect(host.querySelector('.login-page')).not.toBeNull();
    expect(host.querySelector('.drive-module')).toBeNull();
  });

  it('keeps the drive text editor interactive while it covers the rest of the app', async () => {
    const note = { key: 'driver/readme.md', name: 'readme.md', size: 7, last_modified: '2026-01-01T00:00:00Z', is_dir: false };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/config') return json(config);
      if (url.pathname === '/api/tracks') return json({ tracks, prefix: 'media/', truncated: false, catalog_error: null });
      if (url.pathname === '/api/files') return json({ files: [note], folders: [], next_marker: null, truncated: false });
      if (url.pathname === '/api/files/edit') return json({ key: note.key, content: '# Hello', etag: '"1"', size: 7, content_type: 'text/markdown' });
      return json({ detail: 'Not Found' }, 404);
    }));
    tokens.save(signedToken());
    const host = await renderShell();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="编辑文件 readme.md"]')?.click());
    await settle();
    const modal = document.querySelector<HTMLElement>('.edit-modal');
    expect(modal).not.toBeNull();
    expect(modal?.closest('[inert]')).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>('.edit-modal textarea')?.value).toBe('# Hello');
    // Only the page behind the editor and the shell chrome are inert.
    expect(host.querySelector('.drive-module')?.hasAttribute('inert')).toBe(true);
    expect(host.querySelector('#sidebar')?.closest('[inert]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="关闭编辑器"]')?.click());
    expect(document.querySelector('.edit-modal')).toBeNull();
    expect(host.querySelector('.drive-module')?.hasAttribute('inert')).toBe(false);
    expect(host.querySelector('#sidebar')?.closest('[inert]')).toBeNull();
  });

  it('opens a full-screen player in the app layout, swipes between tracks and closes again', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    tokens.save(signedToken());
    history.replaceState(null, '', '/#/music');
    const host = await renderShell();
    // Nothing to expand before a track is chosen.
    expect(host.querySelector('#now-expand')).toBeNull();
    await act(async () => player?.playFromList(tracks[0].key, tracks.map((track) => track.key)));
    await act(async () => host.querySelector<HTMLButtonElement>('#now-expand')?.click());
    const sheet = host.querySelector('#full-player');
    expect(sheet?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.id).toBe('full-close');
    expect(host.querySelector('#content')?.hasAttribute('inert')).toBe(true);
    expect(host.querySelector('footer.player')?.parentElement?.hasAttribute('inert')).toBe(true);

    const stage = host.querySelector<HTMLElement>('#full-stage')!;
    const swipe = async (from: number, to: number) => {
      await act(async () => {
        for (const [type, y] of [['pointerdown', from], ['pointermove', to], ['pointerup', to]] as const) {
          stage.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 1, clientX: 100, clientY: y }));
        }
      });
    };
    await swipe(500, 380);
    expect(player?.getSnapshot().currentKey).toBe(tracks[1].key);
    expect(host.querySelector('#full-title')?.textContent).toBe('b');
    await swipe(380, 500);
    expect(player?.getSnapshot().currentKey).toBe(tracks[0].key);
    // A short drag is not a swipe.
    await swipe(500, 470);
    expect(player?.getSnapshot().currentKey).toBe(tracks[0].key);

    await act(async () => host.querySelector<HTMLButtonElement>('#full-close')?.click());
    expect(host.querySelector('#full-player')).toBeNull();
    expect(host.querySelector('#content')?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement?.id).toBe('now-expand');

    // Escape closes it too, and leaving the music routes never leaves it open behind the drive.
    await act(async () => host.querySelector<HTMLButtonElement>('#now-expand')?.click());
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(host.querySelector('#full-player')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('#now-expand')?.click());
    await navigate('#/files');
    await navigate('#/music');
    expect(host.querySelector('#full-player')).toBeNull();
    expect(player?.getSnapshot().currentKey).toBe(tracks[0].key);
  });

  it('keeps the desktop bar compact without a full-screen entry', async () => {
    tokens.save(signedToken());
    history.replaceState(null, '', '/#/music');
    const host = await renderShell();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    await act(async () => player?.playFromList(tracks[0].key, tracks.map((track) => track.key)));
    expect(host.querySelector('#now-title')?.textContent).toBe('a');
    expect(host.querySelector('#now-expand')).toBeNull();
  });
});
