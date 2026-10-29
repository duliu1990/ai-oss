import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, endpoint } from '../src/api/client';
import type { ConfigResponse, Track, TracksResponse } from '../src/api/types';
import { displayArtist, displayTitle, visibleTracks } from '../src/library/metadata';
import { LibraryStore } from '../src/library/store';
import { CONNECTION_KEY, initialConnection, validateOrigin } from '../src/platform/connection';
import type { ConnectionPolicy, StorageLike } from '../src/platform/connection';
import { PlayerEngine } from '../src/player/engine';
import type { AudioPort } from '../src/player/engine';
import { defaults, readPreferences, STORE_KEY } from '../src/player/preferences';
import { nextKey } from '../src/player/queue';

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class FakeAudio extends EventTarget implements AudioPort {
  private source = '';
  currentSrc = '';
  currentTime = 0;
  duration = Number.NaN;
  volume = 0.8;
  muted = false;
  loop = false;
  paused = true;
  ended = false;
  readyState = 0;
  error: { code: number } | null = null;
  preload = '';
  crossOrigin: string | null = null;
  sourceCount = 0;
  loadCount = 0;
  playCount = 0;
  corsAtSource: (string | null)[] = [];
  playImpl?: () => Promise<void>;
  get src() { return this.source; }
  set src(value: string) { this.source = value; this.sourceCount++; this.corsAtSource.push(this.crossOrigin); }
  getAttribute(name: string) { return name === 'src' && this.source ? this.source : null; }
  removeAttribute(name: string) { if (name === 'src') this.source = ''; }
  load() {
    this.loadCount++;
    this.currentSrc = this.source;
    this.currentTime = 0;
    this.duration = Number.NaN;
    this.readyState = 0;
    this.error = null;
    this.ended = false;
    this.paused = true;
  }
  play() {
    this.playCount++;
    // HTMLMediaElement clears paused before its play promise settles.
    this.paused = false;
    if (this.playImpl) return this.playImpl();
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  metadata(duration = 120) { this.duration = duration; this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); }
  tick(seconds: number) { this.currentTime = seconds; this.dispatchEvent(new Event('timeupdate')); }
  finish() {
    this.currentTime = this.duration;
    this.ended = true;
    this.pause();
    this.dispatchEvent(new Event('ended'));
  }
  fail(code: number) { this.error = { code }; this.dispatchEvent(new Event('error')); }
}

const keys = ['media/a.mp3', 'media/b.mp3', 'media/c.mp3'];
const secure: ConnectionPolicy = { development: false, production: true, allowHttp: false };
const config: ConfigResponse = { oss_ready: true, oss_missing: [], bucket: 'music', prefix: 'media/' };
const engines: PlayerEngine[] = [];
const stores: LibraryStore[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function track(key = keys[0], changes: Partial<Track> = {}): Track {
  return { key, name: key.split('/').pop()!, title: '', artist: '', favorite: false, size: 12345, last_modified: '2026-01-01T00:00:00Z', info: {}, ...changes };
}
function listing(tracks = keys.map((key) => track(key))): TracksResponse {
  return { tracks, prefix: 'media/', truncated: false, catalog_error: null };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(storage = new MemoryStorage(), native = false, base = '') {
  const audio = new FakeAudio();
  const client = new ApiClient(base, vi.fn<typeof fetch>());
  const player = new PlayerEngine(audio, client, storage, native, base, () => 0);
  engines.push(player);
  return { audio, client, player, storage };
}
function libraryFixture(native = false, base = '') {
  const result = fixture(new MemoryStorage(), native, base);
  const clients = new Map<string, ApiClient>();
  const makeClient = (origin: string) => {
    if (!clients.has(origin)) {
      const client = origin === base ? result.client : new ApiClient(origin, vi.fn<typeof fetch>());
      vi.spyOn(client, 'config').mockResolvedValue({ ...config });
      vi.spyOn(client, 'tracks').mockImplementation(async () => listing());
      clients.set(origin, client);
    }
    return clients.get(origin)!;
  };
  const store = new LibraryStore(result.player, { native, base, policy: secure, storage: result.storage }, makeClient);
  stores.push(store);
  return { ...result, store, makeClient };
}

afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
  engines.splice(0).forEach((engine) => engine.destroy());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('default browser fetch receiver', () => {
  function installBrowserFetch(respond: typeof fetch) {
    // Unlike Node fetch and arrow mocks, browser Web IDL rejects arbitrary receivers.
    // Keep this a normal function and throw synchronously, before dispatching a request.
    function browserFetch(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return respond(...args);
    }
    vi.stubGlobal('fetch', browserFetch);
    expect(() => Reflect.apply(browserFetch, {}, ['/api/config'])).toThrow('Illegal invocation');
    return browserFetch;
  }

  it.each(['', 'https://music.example:9443'])('preserves the native receiver for config, tracks and metadata with base %j', async (base) => {
    const entry = { key: keys[0], title: '', artist: '', favorite: true };
    const respond = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => json(config))
      .mockImplementationOnce(async () => json(listing()))
      .mockImplementationOnce(async () => json(entry));
    installBrowserFetch(respond);
    // No injected fetcher: exercise the production constructor default.
    const client = new ApiClient(base);
    await expect(client.config()).resolves.toEqual(config);
    await expect(client.tracks()).resolves.toEqual(listing());
    await expect(client.updateMetadata({ key: keys[0], title: '', artist: null })).resolves.toEqual(entry);
    expect(respond.mock.calls.map(([url]) => url)).toEqual([
      `${base}/api/config`, `${base}/api/tracks`, `${base}/api/tracks/meta`,
    ]);
    for (const [, init] of respond.mock.calls) {
      expect(init?.credentials).toBe('omit');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(respond.mock.calls[2][1]?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Player-Client': 'web' });
    expect(JSON.parse(respond.mock.calls[2][1]?.body as string)).toEqual({ key: keys[0], title: '', artist: null });
  });

  it.each([200, 206, 416])('preserves the native receiver during stream diagnosis with status %s', async (status) => {
    const respond = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status }));
    installBrowserFetch(respond);
    const client = new ApiClient('https://music.example');
    const message = await client.describeStreamError(keys[0], new AbortController().signal);
    expect(message).toBe(status === 416 ? '服务返回 416' : '浏览器无法解码该音频文件。');
    expect(respond).toHaveBeenCalledWith(client.streamUrl(keys[0]), expect.objectContaining({
      headers: { Range: 'bytes=0-1' }, credentials: 'omit', signal: expect.any(AbortSignal),
    }));
  });

  it('loads and refreshes the library through default clients without mocking API methods', async () => {
    const data = listing([...keys, 'media/d.mp3'].map((key) => track(key)));
    const respond = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (url === '/api/config') return json(config);
      if (url === '/api/tracks') return json(data);
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    installBrowserFetch(respond);
    const storage = new MemoryStorage();
    // A Web launch must ignore a native preset and saved server while using the default transport.
    storage.setItem(CONNECTION_KEY, 'https://stored.example');
    const base = initialConnection(false, 'https://preset.example', storage, secure)!;
    const audio = new FakeAudio();
    const player = new PlayerEngine(audio, new ApiClient(base), storage);
    engines.push(player);
    const store = new LibraryStore(player, { native: false, base, policy: secure, storage });
    stores.push(store);
    for (let attempt = 0; attempt < 2; attempt++) {
      await store.refresh();
      expect(store.getSnapshot()).toMatchObject({ base: '', config, tracks: data.tracks, loading: false, error: null });
    }
    expect(respond.mock.calls.map(([url]) => url)).toEqual(['/api/config', '/api/tracks', '/api/config', '/api/tracks']);
    expect(audio.playCount).toBe(0);
  });
});

describe('queue snapshots and playback controls', () => {
  it('copies the visible list and does not replace it when filtering or refreshing', () => {
    const { player } = fixture();
    player.setLibrary(keys);
    const visible = [keys[0], keys[2]];
    player.playFromList(keys[0], visible);
    visible.pop();
    player.setLibrary([...keys, 'media/d.mp3']);
    player.next(false, [keys[1]]);
    expect(player.getSnapshot().queue).toEqual([keys[0], keys[2]]);
    expect(player.getSnapshot().currentKey).toBe(keys[2]);
  });

  it('play all starts a fresh visible snapshot and honors shuffle', () => {
    const { player } = fixture();
    player.setLibrary(keys);
    player.setShuffle(true);
    player.playAll([keys[2], keys[1]]);
    expect(player.getSnapshot().currentKey).toBe(keys[2]);
    expect(player.getSnapshot().queue).toEqual([keys[2], keys[1]]);
  });

  it.each(['all', 'off', 'one'] as const)('manual next wraps to the first track in %s mode', (repeat) => {
    const { player } = fixture();
    player.setLibrary(keys);
    player.setRepeat(repeat);
    player.playFromList(keys[2], keys);
    player.next();
    expect(player.getSnapshot().currentKey).toBe(keys[0]);
  });

  it.each([['all', keys[0]], ['one', keys[2]], ['off', keys[2]]] as const)('handles automatic ending in %s mode', (repeat, expected) => {
    const { player, audio } = fixture();
    player.setLibrary(keys);
    player.setRepeat(repeat);
    player.playFromList(keys[2], keys);
    audio.metadata();
    audio.finish();
    expect(player.getSnapshot().currentKey).toBe(expected);
    expect(player.getSnapshot().playing).toBe(repeat !== 'off');
    expect(audio.loop).toBe(repeat === 'one');
  });

  it('preserves shuffle with repeat off rather than stopping at the end', () => {
    expect(nextKey({ queue: keys, currentKey: keys[2], history: [], shuffle: true, repeat: 'off' }, true, () => 0)).toBe(keys[0]);
    expect(nextKey({ queue: [keys[0]], currentKey: keys[0], history: [], shuffle: true, repeat: 'off' }, true)).toBeNull();
    expect(nextKey({ queue: [], currentKey: null, history: [], shuffle: false, repeat: 'all' })).toBeNull();
  });

  it('rewinds after three seconds, otherwise goes to the previous track', () => {
    const { player, audio } = fixture();
    player.setLibrary(keys);
    player.playFromList(keys[1], keys);
    audio.metadata();
    audio.tick(4);
    player.previous();
    expect(player.getSnapshot().currentKey).toBe(keys[1]);
    expect(audio.currentTime).toBe(0);
    audio.tick(3);
    player.previous();
    expect(player.getSnapshot().currentKey).toBe(keys[0]);
  });

  it('uses shuffle history for back navigation without growing it', () => {
    const { player } = fixture();
    player.setLibrary(keys);
    player.setShuffle(true);
    player.playFromList(keys[0], keys);
    player.next();
    player.next();
    expect(player.getSnapshot().currentKey).toBe(keys[2]);
    player.previous();
    expect(player.getSnapshot().currentKey).toBe(keys[1]);
    expect(player.getSnapshot().history).toEqual([keys[0]]);
    player.previous();
    expect(player.getSnapshot().currentKey).toBe(keys[0]);
    expect(player.getSnapshot().history).toEqual([]);
  });

  it('prunes deleted queue and history entries, and stops completely if current is removed', () => {
    const { player, audio, storage } = fixture();
    player.setLibrary(keys);
    player.playFromList(keys[0], keys);
    player.next();
    player.setLibrary([keys[1], keys[2]]);
    expect(player.getSnapshot().queue).toEqual([keys[1], keys[2]]);
    expect(player.getSnapshot().history).toEqual([]);
    player.setLibrary([keys[2]]);
    expect(player.getSnapshot()).toMatchObject({ currentKey: null, queue: [], history: [], position: 0, duration: 0, playing: false, buffering: false });
    expect(audio.getAttribute('src')).toBeNull();
    expect(readPreferences(storage).lastKey).toBeNull();
  });

  it('supports seek, volume, mute, and pause without reconstructing or reloading audio', () => {
    const { player, audio } = fixture();
    player.setLibrary(keys);
    player.playFromList(keys[0], keys);
    audio.metadata();
    player.seek(999);
    expect(audio.currentTime).toBe(120);
    player.seek(-20);
    expect(audio.currentTime).toBe(0);
    player.setVolume(0);
    expect(audio.muted).toBe(true);
    player.toggleMute();
    expect(audio.volume).toBe(0.5);
    expect(audio.muted).toBe(false);
    player.toggle();
    expect(audio.paused).toBe(true);
    expect(audio.sourceCount).toBe(1);
    expect(audio.corsAtSource).toEqual(['anonymous']);
  });
});

describe('native pause event ordering and play intent', () => {
  it('resumes with one toggle after an external pause without reloading or losing position', () => {
    const { player, audio, storage } = fixture();
    player.setLibrary(keys);
    player.playFromList(keys[0], keys);
    audio.metadata();
    audio.tick(23);
    expect(audio.paused).toBe(false);
    // An external pause changes the element state, not just the emitted event.
    audio.pause();
    expect(audio.paused).toBe(true);
    expect(player.getSnapshot()).toMatchObject({ playing: false, buffering: false, position: 23 });
    expect(readPreferences(storage).lastTime).toBe(23);
    player.toggle();
    expect(audio.playCount).toBe(2);
    expect(audio.sourceCount).toBe(1);
    expect(audio.currentTime).toBe(23);
    expect(player.getSnapshot()).toMatchObject({ currentKey: keys[0], playing: true, buffering: false, error: null });
  });

  it.each(['all', 'off'] as const)('advances once after the natural pause-before-ended sequence in %s mode', (repeat) => {
    const { player, audio } = fixture();
    player.setLibrary(keys);
    player.setRepeat(repeat);
    player.playFromList(keys[0], keys);
    audio.metadata();
    audio.currentTime = audio.duration;
    // At natural completion ended is already true when the pause event arrives.
    audio.ended = true;
    audio.pause();
    expect(player.getSnapshot()).toMatchObject({ currentKey: keys[0], playing: false, buffering: false });
    audio.dispatchEvent(new Event('ended'));
    expect(player.getSnapshot()).toMatchObject({ currentKey: keys[1], playing: true, error: null });
    expect(audio.playCount).toBe(2);
    // A queued old ended event cannot advance the newly loaded source again.
    audio.dispatchEvent(new Event('ended'));
    expect(player.getSnapshot().currentKey).toBe(keys[1]);
    expect(audio.playCount).toBe(2);
  });

  it.each(['before', 'after'] as const)('ignores a paused pending request rejecting %s one-toggle resume', async (timing) => {
    const { player, audio } = fixture();
    const pending = deferred<void>();
    audio.playImpl = () => pending.promise;
    player.setLibrary(keys);
    player.playFromList(keys[0], keys);
    expect(audio.paused).toBe(false);
    expect(player.getSnapshot().buffering).toBe(true);
    audio.pause();
    expect(player.getSnapshot()).toMatchObject({ playing: false, buffering: false, error: null });
    if (timing === 'before') {
      pending.reject(new Error('Interrupted old play'));
      await flush();
      expect(player.getSnapshot()).toMatchObject({ playing: false, buffering: false, error: null });
    }
    audio.playImpl = undefined;
    player.toggle();
    expect(audio.playCount).toBe(2);
    if (timing === 'after') pending.reject(new Error('Interrupted old play'));
    await flush();
    expect(audio.paused).toBe(false);
    expect(player.getSnapshot()).toMatchObject({ currentKey: keys[0], playing: true, buffering: false, error: null });
  });

  it('blocks late play events from a resolved request after an external pause', async () => {
    const { player, audio } = fixture();
    const pending = deferred<void>();
    audio.playImpl = () => pending.promise;
    player.setLibrary(keys);
    player.playFromList(keys[0], keys);
    audio.pause();
    pending.resolve();
    // Simulate late playback becoming active, not an event on an already paused element.
    audio.paused = false;
    audio.dispatchEvent(new Event('play'));
    audio.dispatchEvent(new Event('playing'));
    await flush();
    expect(audio.paused).toBe(true);
    expect(player.getSnapshot()).toMatchObject({ playing: false, buffering: false, error: null });
    audio.playImpl = undefined;
    player.toggle();
    expect(audio.playCount).toBe(2);
    expect(player.getSnapshot().playing).toBe(true);
  });

  it.each([
    ['resume', 'resolve'], ['resume', 'reject'], ['switch', 'resolve'], ['switch', 'reject'],
  ] as const)('ignores a queued internal pause during %s when the new request will %s', async (transition, outcome) => {
    const { player, audio } = fixture();
    const first = deferred<void>();
    const second = deferred<void>();
    audio.playImpl = () => first.promise;
    player.setLibrary(keys);
    player.playFromList(keys[0], keys);
    const queued: (() => void)[] = [];
    vi.spyOn(audio, 'pause').mockImplementation(() => {
      if (audio.paused) return;
      // Native pause changes state synchronously but dispatches its event later.
      audio.paused = true;
      queued.push(() => audio.dispatchEvent(new Event('pause')));
    });
    audio.playImpl = () => second.promise;
    if (transition === 'resume') {
      player.pause();
      expect(audio.paused).toBe(true);
      player.toggle();
    } else player.playFromList(keys[1], keys);
    const currentKey = transition === 'resume' ? keys[0] : keys[1];
    expect(queued).toHaveLength(1);
    expect(audio.paused).toBe(false);
    // Deliver only the old event: a newer play() has already cleared paused.
    queued.shift()!();
    first.reject(new Error('Superseded play'));
    await flush();
    expect(audio.paused).toBe(false);
    expect(player.getSnapshot()).toMatchObject({ currentKey, playing: false, buffering: true, error: null });
    if (outcome === 'resolve') {
      audio.dispatchEvent(new Event('play'));
      audio.dispatchEvent(new Event('playing'));
      second.resolve();
      await flush();
      expect(player.getSnapshot()).toMatchObject({ currentKey, playing: true, buffering: false, error: null });
      player.toggle();
      expect(audio.paused).toBe(true);
    } else {
      second.reject(new Error('Current play failed'));
      await flush();
      expect(player.getSnapshot()).toMatchObject({ currentKey, playing: false, buffering: false });
      expect(player.getSnapshot().error).toContain('Current play failed');
    }
    expect(audio.playCount).toBe(2);
  });
});

describe('legacy preferences and stable source lifecycle', () => {
  it('restores old localStorage preferences and progress without autoplay', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORE_KEY, JSON.stringify({ volume: 0.4, muted: true, shuffle: true, repeat: 'off', sort: 'artist', lastKey: keys[1], lastTime: 27 }));
    const { player, audio } = fixture(storage);
    player.setLibrary(keys, [...keys].reverse());
    expect(audio.playCount).toBe(0);
    player.save();
    expect(readPreferences(storage).lastTime).toBe(27);
    audio.metadata();
    expect(audio.currentTime).toBe(27);
    expect(audio.paused).toBe(true);
    expect(player.getSnapshot()).toMatchObject({ volume: 0.4, muted: true, shuffle: true, repeat: 'off', sort: 'artist', currentKey: keys[1], playing: false });
    player.setLibrary(keys);
    expect(audio.sourceCount).toBe(1);
  });

  it('does not overwrite a saved session before the first successful listing', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORE_KEY, JSON.stringify({ lastKey: keys[0], lastTime: 18 }));
    const { player } = fixture(storage);
    player.setShuffle(true);
    player.save();
    expect(readPreferences(storage).lastTime).toBe(18);
    player.setLibrary(keys);
    expect(player.getSnapshot().currentKey).toBe(keys[0]);
  });

  it('sanitizes malformed preferences and restores overlong progress at the beginning', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORE_KEY, '{broken');
    expect(readPreferences(storage)).toEqual(defaults);
    storage.setItem(STORE_KEY, JSON.stringify({ volume: 8, repeat: 'bad', lastKey: keys[0], lastTime: 999 }));
    const { player, audio } = fixture(storage);
    player.setLibrary(keys);
    audio.metadata(100);
    expect(audio.currentTime).toBe(0);
    expect(audio.volume).toBe(1);
    expect(player.getSnapshot().repeat).toBe('all');
  });

  it('restores the same native service without autoplay and tolerates unavailable storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORE_KEY, JSON.stringify({ lastKey: keys[0], lastTime: 30, service: 'https://one.example' }));
    const { player, audio } = fixture(storage, true, 'https://one.example');
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    expect(() => player.setLibrary(keys)).not.toThrow();
    audio.metadata();
    expect(audio.currentTime).toBe(30);
    expect(audio.playCount).toBe(0);
  });

  it('isolates saved progress by native service', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORE_KEY, JSON.stringify({ lastKey: keys[0], lastTime: 30, service: 'https://one.example' }));
    const { player, audio } = fixture(storage, true, 'https://two.example');
    player.setLibrary(keys);
    expect(player.getSnapshot().currentKey).toBeNull();
    expect(audio.playCount).toBe(0);
  });

  it('ignores a late play rejection after a rapid track switch', async () => {
    const { player, audio } = fixture();
    const first = deferred<void>();
    player.setLibrary(keys);
    audio.playImpl = () => first.promise;
    player.playFromList(keys[0], keys);
    audio.playImpl = undefined;
    player.playFromList(keys[1], keys);
    first.reject(new Error('Old track failed'));
    await flush();
    expect(player.getSnapshot()).toMatchObject({ currentKey: keys[1], playing: true, error: null });
  });

  it('ignores stale media events whose currentSrc still points at the previous source', () => {
    const { player, audio } = fixture();
    player.setLibrary(keys);
    player.playFromList(keys[0], keys);
    const oldSrc = audio.src;
    player.playFromList(keys[1], keys);
    audio.currentSrc = oldSrc;
    audio.metadata(900);
    audio.finish();
    expect(player.getSnapshot()).toMatchObject({ currentKey: keys[1], duration: 0 });
  });

  it('keeps playback paused if a pending play resolves after pause', async () => {
    const { player, audio } = fixture();
    const pending = deferred<void>();
    audio.playImpl = () => pending.promise;
    player.setLibrary(keys);
    player.playFromList(keys[0], keys);
    player.toggle();
    pending.resolve();
    audio.paused = false;
    audio.dispatchEvent(new Event('play'));
    await flush();
    expect(audio.paused).toBe(true);
    expect(player.getSnapshot().playing).toBe(false);
  });

  it('invalidates pending playback on removal and service switches', async () => {
    const { player, audio } = fixture();
    const pending = deferred<void>();
    audio.playImpl = () => pending.promise;
    player.setLibrary(keys);
    player.playFromList(keys[0], keys);
    player.setLibrary([keys[1]]);
    player.switchService(new ApiClient('https://two.example', vi.fn<typeof fetch>()), 'https://two.example');
    player.setLibrary(keys);
    audio.playImpl = undefined;
    player.playFromList(keys[1], keys);
    pending.reject(new Error('Old service failure'));
    await flush();
    expect(audio.src).toContain('https://two.example/api/stream');
    expect(player.getSnapshot()).toMatchObject({ currentKey: keys[1], playing: true, error: null });
  });

  it('ignores aborted play attempts and surfaces current playback failures', async () => {
    const { player, audio } = fixture();
    player.setLibrary(keys);
    audio.playImpl = () => Promise.reject(new DOMException('Replaced', 'AbortError'));
    player.playFromList(keys[0], keys);
    await flush();
    expect(player.getSnapshot().error).toBeNull();
    audio.playImpl = () => Promise.reject(new Error('Not allowed'));
    player.play();
    await flush();
    expect(player.getSnapshot().error).toContain('Not allowed');
    expect(player.getSnapshot().buffering).toBe(false);
  });

  it('discards an old decode diagnostic after switching tracks', async () => {
    const { player, audio, client } = fixture();
    const diagnostic = deferred<string>();
    vi.spyOn(client, 'describeStreamError').mockReturnValue(diagnostic.promise);
    player.setLibrary(keys);
    player.playFromList(keys[0], keys);
    audio.fail(3);
    player.playFromList(keys[1], keys);
    diagnostic.resolve('Old decode error');
    await flush();
    expect(player.getSnapshot().error).toBeNull();
    expect(player.getSnapshot().currentKey).toBe(keys[1]);
  });

  it('surfaces current decoding/network errors and retries on the same Audio', async () => {
    const { player, audio, client } = fixture();
    vi.spyOn(client, 'describeStreamError').mockResolvedValue('Unable to decode');
    player.setLibrary(keys);
    player.playFromList(keys[0], keys);
    audio.fail(3);
    await flush();
    expect(player.getSnapshot().error).toContain('Unable to decode');
    player.play();
    expect(audio.sourceCount).toBe(2);
    expect(player.getSnapshot()).toMatchObject({ error: null, playing: true });
  });
});

describe('metadata precedence and API semantics', () => {
  it('uses manual edits, then catalog, then filename without writing catalog overrides', () => {
    const source = track(keys[0], { title: 'Edited', artist: 'Local', info: { title: 'Catalog', artist: 'Remote' } });
    expect(displayTitle(source)).toBe('Edited');
    expect(displayArtist(source)).toBe('Local');
    expect(displayTitle({ ...source, title: '' })).toBe('Catalog');
    expect(displayArtist({ ...source, artist: '' })).toBe('Remote');
    expect(displayTitle(track())).toBe('a');
    expect(displayTitle(track('media/0123456789abcdef0123456789abcdef.mp3'))).toBe('未命名音频 012345');
  });

  it('searches catalog title, artist and filename and keeps global counts outside filtering', () => {
    const tracks = [track(keys[0], { info: { title: 'Song 10', artist: 'Singer' }, favorite: true }), track(keys[1], { title: 'Song 2' })];
    expect(visibleTracks(tracks, 'all', 'singer', 'recent')).toHaveLength(1);
    expect(visibleTracks(tracks, 'all', 'b.mp3', 'recent')[0].key).toBe(keys[1]);
    expect(visibleTracks(tracks, 'favorites', '', 'recent')).toHaveLength(1);
    expect(visibleTracks(tracks, 'all', '', 'title').map((item) => item.key)).toEqual([keys[1], keys[0]]);
    expect(visibleTracks(tracks, 'all', '', 'artist')[0].key).toBe(keys[0]);
    expect(tracks).toHaveLength(2);
  });

  it('preserves null, empty, and omitted metadata fields with the web write marker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ key: keys[0], title: '', artist: '', favorite: true }));
    const api = new ApiClient('https://music.example', fetcher);
    await api.updateMetadata({ key: keys[0], title: '', artist: null });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://music.example/api/tracks/meta');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Player-Client': 'web' });
    expect(init?.credentials).toBe('omit');
    expect(JSON.parse(init?.body as string)).toEqual({ key: keys[0], title: '', artist: null });
    expect(JSON.parse(init?.body as string)).not.toHaveProperty('favorite');
  });

  it('encodes exact OSS keys in stream URLs and shares the API base', () => {
    const key = 'media/中文 +#?&%.mp3';
    const api = new ApiClient('https://music.example:9443');
    const url = new URL(api.streamUrl(key));
    expect(url.origin).toBe('https://music.example:9443');
    expect(url.pathname).toBe('/api/stream');
    expect(url.searchParams.get('key')).toBe(key);
    expect(endpoint('', '/api/stream', { key })).toMatch(/^\/api\/stream\?/);
  });

  it.each([400, 403, 404, 413, 416, 422, 500])('reports JSON API errors with status %s', async (status) => {
    const api = new ApiClient('', vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'Request rejected' }, status)));
    await expect(api.config()).rejects.toMatchObject({ message: 'Request rejected', status });
  });

  it('handles non-JSON and invalid-shape responses without rendering arbitrary detail objects', async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }));
    fetcher.mockResolvedValueOnce(json({ detail: [{ msg: 'bad' }] }, 422));
    fetcher.mockResolvedValueOnce(json({ wrong: true }));
    const api = new ApiClient('', fetcher);
    await expect(api.config()).rejects.toMatchObject({ status: 502 });
    await expect(api.config()).rejects.toThrow('422');
    await expect(api.config()).rejects.toBeInstanceOf(ApiError);
  });

  it('handles offline fetch and request timeout', async () => {
    const api = new ApiClient('', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api.config()).rejects.toThrow('无法连接');
    vi.useFakeTimers();
    const hanging = new ApiClient('', vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const expectation = expect(hanging.config()).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(20001);
    await expectation;
  });

  it('allows a broken catalog warning and malformed optional info without losing tracks', async () => {
    const data = { ...listing(), catalog_error: 'Catalog is damaged' };
    const malformed = { ...data, tracks: [{ ...track(), info: { title: 4, duration: -1 } }] };
    const api = new ApiClient('', vi.fn<typeof fetch>().mockResolvedValue(json(malformed)));
    const result = await api.tracks();
    expect(result.tracks[0].info).toEqual({});
    expect(result.catalog_error).toBe('Catalog is damaged');
  });

  it.each([200, 206])('diagnoses media with a tiny range and cancels successful %s bodies', async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
    const result = await new ApiClient('', fetcher).describeStreamError(keys[0], new AbortController().signal);
    expect(result).toContain('解码');
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Range: 'bytes=0-1' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('service connection and library request isolation', () => {
  it.each(['https://music.example', 'https://music.example:9443', 'https://[::1]:8767', 'https://music.example/'])('accepts a secure origin: %s', (origin) => {
    expect(validateOrigin(origin, secure)).toBe(new URL(origin).origin);
  });

  it.each(['', 'music.example', '//music.example', 'javascript:alert(1)', 'file:///music', 'http://music.example', 'https://user:pass@music.example', 'https://@music.example', 'https://music.example/api', 'https://music.example/.', 'https://music.example?x=1', 'https://music.example?', 'https://music.example#x', 'https://music.example#', 'https://music.example\\evil', 'https://music.exa\nmple'])('rejects unsafe or non-origin input: %s', (origin) => {
    expect(() => validateOrigin(origin, secure)).toThrow();
  });

  it('only allows HTTP with an explicit development flag, never in production', () => {
    expect(validateOrigin('http://127.0.0.1:8767', { development: true, production: false, allowHttp: true })).toBe('http://127.0.0.1:8767');
    expect(() => validateOrigin('http://127.0.0.1:8767', { development: true, production: true, allowHttp: true })).toThrow();
    expect(() => validateOrigin('http://127.0.0.1:8767', { development: true, production: false, allowHttp: false })).toThrow();
  });

  it('fixes Web to same-origin and uses validated stored/preset origins only on native', () => {
    const storage = new MemoryStorage();
    storage.setItem(CONNECTION_KEY, 'https://stored.example');
    expect(initialConnection(false, 'https://preset.example', storage, secure)).toBe('');
    expect(initialConnection(true, 'https://preset.example', storage, secure)).toBe('https://stored.example');
    storage.removeItem(CONNECTION_KEY);
    expect(initialConnection(true, 'https://preset.example', storage, secure)).toBe('https://preset.example');
    expect(initialConnection(true, '', storage, secure)).toBeNull();
    expect(initialConnection(true, 'http://unsafe.example', storage, secure)).toBeNull();
  });

  it('does not reload Audio when refreshing tracks or saving metadata', async () => {
    const { store, player, audio, client } = libraryFixture();
    await store.refresh();
    player.playFromList(keys[0], keys);
    const count = audio.sourceCount;
    vi.spyOn(client, 'updateMetadata').mockResolvedValue({ key: keys[0], title: '', artist: '', favorite: true });
    await store.updateMetadata(keys[0], { favorite: true });
    await store.refresh();
    expect(audio.sourceCount).toBe(count);
    expect(player.getSnapshot().playing).toBe(true);
  });

  it('clearing an override restores catalog display without replacing info', async () => {
    const { store, client } = libraryFixture();
    vi.mocked(client.tracks).mockResolvedValue(listing([track(keys[0], { title: 'Manual', info: { title: 'Catalog' } })]));
    await store.refresh();
    vi.spyOn(client, 'updateMetadata').mockResolvedValue({ key: keys[0], title: '', artist: '', favorite: false });
    await store.updateMetadata(keys[0], { title: '' });
    expect(displayTitle(store.getSnapshot().tracks[0])).toBe('Catalog');
    expect(client.updateMetadata).toHaveBeenCalledWith({ key: keys[0], title: '' }, expect.any(AbortSignal));
  });

  it('preserves an unrestored session while OSS configuration is incomplete', async () => {
    const storage = new MemoryStorage();
    storage.setItem(STORE_KEY, JSON.stringify({ lastKey: keys[0], lastTime: 17 }));
    const { player, audio, client } = fixture(storage);
    vi.spyOn(client, 'config').mockResolvedValueOnce({ ...config, oss_ready: false, oss_missing: ['OSS_BUCKET'] }).mockResolvedValue(config);
    vi.spyOn(client, 'tracks').mockResolvedValue(listing());
    const store = new LibraryStore(player, { native: false, base: '', policy: secure, storage }, () => client);
    stores.push(store);
    await store.refresh();
    expect(readPreferences(storage).lastTime).toBe(17);
    await store.refresh();
    audio.metadata();
    expect(audio.currentTime).toBe(17);
    expect(audio.playCount).toBe(0);
  });

  it('reconnecting the same native origin refreshes without resetting playback', async () => {
    const { store, player, audio } = libraryFixture(true, 'https://one.example');
    await store.refresh();
    player.playFromList(keys[0], keys);
    store.connect('https://one.example/');
    await flush();
    expect(audio.sourceCount).toBe(1);
    expect(player.getSnapshot().playing).toBe(true);
  });

  it('rejects Web service switching', () => {
    expect(() => libraryFixture().store.connect('https://other.example')).toThrow('网页版');
  });

  it('stops and clears old media, library and progress before a new service resolves', async () => {
    const { store, player, audio, storage, makeClient } = libraryFixture(true, 'https://one.example');
    await store.refresh();
    player.playFromList(keys[0], keys);
    audio.metadata();
    audio.tick(45);
    const pending = deferred<ConfigResponse>();
    vi.mocked(makeClient('https://two.example').config).mockReturnValue(pending.promise);
    store.connect('https://two.example');
    expect(store.getSnapshot()).toMatchObject({ base: 'https://two.example', tracks: [], config: null });
    expect(player.getSnapshot()).toMatchObject({ currentKey: null, position: 0, queue: [], history: [], playing: false });
    expect(audio.src).toBe('');
    expect(readPreferences(storage)).toMatchObject({ lastKey: null, lastTime: 0, service: 'https://two.example' });
    expect(storage.getItem(CONNECTION_KEY)).toBe('https://two.example');
    pending.resolve(config);
    await flush();
    expect(player.getSnapshot().currentKey).toBeNull();
  });

  it('ignores a late old-service list even when transport ignores abort', async () => {
    const { store, client } = libraryFixture(true, 'https://one.example');
    const old = deferred<TracksResponse>();
    vi.mocked(client.tracks).mockReturnValue(old.promise);
    const request = store.refresh();
    await flush();
    store.connect('https://two.example');
    await flush();
    old.resolve(listing([track('media/old-only.mp3')]));
    await request;
    expect(store.getSnapshot().base).toBe('https://two.example');
    expect(store.getSnapshot().tracks.map((item) => item.key)).toEqual(keys);
  });

  it('rejects a late old-service metadata write without applying it', async () => {
    const { store, client } = libraryFixture(true, 'https://one.example');
    await store.refresh();
    const old = deferred<{ key: string; title: string; artist: string; favorite: boolean }>();
    vi.spyOn(client, 'updateMetadata').mockReturnValue(old.promise);
    const request = store.updateMetadata(keys[0], { title: 'Old edit' });
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    store.connect('https://two.example');
    await flush();
    old.resolve({ key: keys[0], title: 'Old edit', artist: '', favorite: false });
    await rejected;
    expect(store.getSnapshot().tracks[0].title).toBe('');
    expect(store.getSnapshot().pending.size).toBe(0);
  });

  it('does not let an older refresh roll back a successful edit', async () => {
    const { store, client } = libraryFixture();
    await store.refresh();
    const older = deferred<TracksResponse>();
    vi.mocked(client.tracks).mockReturnValueOnce(older.promise);
    const refresh = store.refresh();
    await flush();
    vi.spyOn(client, 'updateMetadata').mockResolvedValue({ key: keys[0], title: 'New edit', artist: '', favorite: true });
    await store.updateMetadata(keys[0], { title: 'New edit', favorite: true });
    older.resolve(listing());
    await refresh;
    expect(store.getSnapshot().tracks[0]).toMatchObject({ title: 'New edit', favorite: true });
  });

  it('keeps existing tracks on transient list failure and reports catalog warnings nonfatally', async () => {
    const { store, client, player, audio } = libraryFixture();
    vi.mocked(client.tracks).mockResolvedValueOnce({ ...listing(), catalog_error: 'Catalog warning', truncated: true });
    await store.refresh();
    expect(store.getSnapshot().notice).toContain('Catalog warning');
    player.playFromList(keys[0], keys);
    vi.mocked(client.tracks).mockRejectedValueOnce(new ApiError('Offline'));
    await store.refresh();
    expect(store.getSnapshot().tracks).toHaveLength(3);
    expect(store.getSnapshot().error).toBe('Offline');
    expect(audio.sourceCount).toBe(1);
  });
});
