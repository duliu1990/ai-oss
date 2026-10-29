import { ApiClient, errorMessage, isAbort } from '../api/client';
import type { RepeatMode, SortOrder } from '../api/types';
import type { StorageLike } from '../platform/connection';
import { readPreferences, writePreferences } from './preferences';
import type { Preferences } from './preferences';
import { nextKey, previousKey } from './queue';

export interface AudioPort extends EventTarget {
  src: string;
  readonly currentSrc: string;
  currentTime: number;
  readonly duration: number;
  volume: number;
  muted: boolean;
  loop: boolean;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  readonly error: { code: number } | null;
  preload: string;
  crossOrigin: string | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
}

export interface PlayerSnapshot {
  currentKey: string | null;
  queue: readonly string[];
  history: readonly string[];
  position: number;
  duration: number;
  playing: boolean;
  buffering: boolean;
  error: string | null;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  sort: SortOrder;
}

export class PlayerEngine {
  private snapshot: PlayerSnapshot;
  private listeners = new Set<() => void>();
  private available = new Set<string>();
  private sourceListeners: (() => void)[] = [];
  private generation = 0;
  private playRequest = 0;
  private wantPlay = false;
  private pendingSeek: number | null = null;
  private restored = false;
  private initial: Preferences;
  private diagnosis?: AbortController;
  private lastSaved = 0;
  private service: string | null;

  constructor(
    private readonly audio: AudioPort,
    private client: ApiClient,
    private readonly storage?: StorageLike,
    private readonly native = false,
    service: string | null = client.base,
    private readonly random: () => number = Math.random,
  ) {
    this.service = service;
    this.initial = readPreferences(storage);
    if (native && this.initial.service !== service) {
      this.initial.lastKey = null;
      this.initial.lastTime = 0;
    }
    const { volume, muted, shuffle, repeat, sort } = this.initial;
    this.snapshot = {
      currentKey: null, queue: [], history: [], position: 0, duration: 0,
      playing: false, buffering: false, error: null, volume, muted, shuffle, repeat, sort,
    };
    audio.crossOrigin = 'anonymous';
    audio.preload = 'metadata';
    audio.volume = volume;
    audio.muted = muted;
    audio.loop = repeat === 'one';
    audio.addEventListener('volumechange', this.volumeChanged);
  }

  getSnapshot = (): PlayerSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit(patch: Partial<PlayerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private volumeChanged = (): void => {
    this.emit({ volume: this.audio.volume, muted: this.audio.muted });
    this.save();
  };

  save = (): void => {
    // A failed first request must not erase the old session before restoration.
    if (!this.restored) return;
    const state = this.snapshot;
    writePreferences({
      volume: state.volume, muted: state.muted, shuffle: state.shuffle, repeat: state.repeat,
      sort: state.sort, lastKey: state.currentKey,
      lastTime: state.currentKey ? this.pendingSeek ?? state.position : 0,
      ...(this.native ? { service: this.service } : {}),
    }, this.storage);
  };

  setLibrary(keys: readonly string[], restoreQueue: readonly string[] = keys): void {
    this.available = new Set(keys);
    if (this.snapshot.currentKey && !this.available.has(this.snapshot.currentKey)) {
      this.stop();
      return;
    }
    this.emit({
      queue: this.snapshot.queue.filter((key) => this.available.has(key)),
      history: this.snapshot.history.filter((key) => this.available.has(key)),
    });
    if (!this.restored) {
      this.restored = true;
      const { lastKey, lastTime } = this.initial;
      if (lastKey && this.available.has(lastKey)) {
        this.setQueue(restoreQueue);
        this.loadTrack(lastKey, false, lastTime);
      }
      this.save();
    }
  }

  private setQueue(keys: readonly string[]): void {
    this.emit({ queue: [...new Set(keys)].filter((key) => this.available.has(key)) });
  }

  playFromList(key: string, visible: readonly string[]): void {
    if (!this.available.has(key)) return;
    this.setQueue(visible);
    if (this.snapshot.currentKey === key) this.toggle();
    else this.loadTrack(key);
  }

  playAll(visible: readonly string[]): void {
    this.setQueue(visible);
    const queue = this.snapshot.queue;
    if (!queue.length) return;
    const index = this.snapshot.shuffle ? Math.min(queue.length - 1, Math.floor(this.random() * queue.length)) : 0;
    this.loadTrack(queue[index]);
  }

  toggle(visible: readonly string[] = []): void {
    if (this.wantPlay || this.snapshot.playing) this.pause();
    else this.play(visible);
  }

  play(visible: readonly string[] = []): void {
    if (!this.snapshot.currentKey) {
      if (!this.snapshot.queue.length) this.setQueue(visible);
      const first = this.snapshot.queue[0];
      if (first) this.loadTrack(first);
      return;
    }
    if (this.audio.error) {
      this.loadTrack(this.snapshot.currentKey, true, this.snapshot.position);
      return;
    }
    this.wantPlay = true;
    const generation = this.generation;
    const request = ++this.playRequest;
    this.emit({ buffering: true, error: null });
    try {
      void this.audio.play().catch((error: unknown) => this.playFailed(error, generation, request));
    } catch (error) {
      this.playFailed(error, generation, request);
    }
  }

  private playFailed(error: unknown, generation: number, request: number): void {
    if (generation !== this.generation || request !== this.playRequest || isAbort(error)) return;
    this.wantPlay = false;
    this.emit({ playing: false, buffering: false, error: `无法播放：${errorMessage(error)}` });
  }

  pause(): void {
    this.wantPlay = false;
    ++this.playRequest;
    this.audio.pause();
    this.emit({ playing: false, buffering: false });
    this.save();
  }

  next(auto = false, visible: readonly string[] = []): void {
    if (!this.snapshot.queue.length) this.setQueue(visible);
    const key = nextKey(this.snapshot, auto, this.random);
    if (key) this.loadTrack(key);
    else { this.wantPlay = false; this.emit({ playing: false, buffering: false }); this.save(); }
  }

  previous(visible: readonly string[] = []): void {
    if (this.audio.currentTime > 3) { this.seek(0); return; }
    if (!this.snapshot.queue.length) this.setQueue(visible);
    const result = previousKey(this.snapshot, this.available);
    if (!result.key) { this.seek(0); return; }
    if (this.snapshot.shuffle) {
      this.emit({ history: result.history });
      this.loadTrack(result.key, true, 0, false);
    } else this.loadTrack(result.key);
  }

  seek(position: number): void {
    if (!this.snapshot.currentKey || !Number.isFinite(position)) return;
    const duration = this.snapshot.duration;
    if (!duration) return;
    try {
      this.audio.currentTime = Math.max(0, Math.min(position, duration));
      this.pendingSeek = null;
      this.emit({ position: this.audio.currentTime });
      this.save();
    } catch { this.emit({ error: '音频仍在载入，请稍后调整播放进度。' }); }
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.audio.volume = Math.max(0, Math.min(1, volume));
    this.audio.muted = this.audio.volume === 0;
    this.volumeChanged();
  }

  toggleMute(): void {
    if (this.audio.muted && this.audio.volume === 0) this.audio.volume = 0.5;
    this.audio.muted = !this.audio.muted;
    this.volumeChanged();
  }

  setShuffle(shuffle: boolean): void { this.emit({ shuffle }); this.save(); }
  setSort(sort: SortOrder): void { this.emit({ sort }); this.save(); }
  setRepeat(repeat: RepeatMode): void {
    this.audio.loop = repeat === 'one';
    this.emit({ repeat });
    this.save();
  }

  private detachSource(): void {
    ++this.generation;
    ++this.playRequest;
    this.diagnosis?.abort();
    this.sourceListeners.forEach((remove) => remove());
    this.sourceListeners = [];
  }

  private loadTrack(key: string, autoplay = true, startAt = 0, addHistory = true): void {
    if (!this.available.has(key)) return;
    this.detachSource();
    this.audio.pause();
    const old = this.snapshot;
    const history = addHistory && old.currentKey && old.currentKey !== key
      ? [...old.history, old.currentKey].slice(-200) : old.history;
    this.wantPlay = autoplay;
    this.pendingSeek = startAt > 0 ? startAt : null;
    this.emit({ currentKey: key, history, position: startAt, duration: 0, playing: false, buffering: autoplay, error: null });
    // CORS must be selected before src, including for native media range requests.
    this.audio.crossOrigin = 'anonymous';
    const url = this.client.streamUrl(key);
    this.audio.src = url;
    this.audio.loop = old.repeat === 'one';
    this.attachSource(url, this.generation);
    this.audio.load();
    if (autoplay) this.play();
    this.save();
  }

  private attachSource(url: string, generation: number): void {
    const audio = this.audio;
    const active = () => generation === this.generation && audio.getAttribute('src') === url
      && (!audio.currentSrc || audio.currentSrc === audio.src);
    const on = (name: string, callback: () => void) => {
      const handler = () => { if (active()) callback(); };
      audio.addEventListener(name, handler);
      this.sourceListeners.push(() => audio.removeEventListener(name, handler));
    };
    const progress = () => {
      if (audio.readyState < 1) return;
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      if (this.pendingSeek !== null && duration) {
        const seek = this.pendingSeek < duration - 1 ? this.pendingSeek : 0;
        try { audio.currentTime = seek; this.pendingSeek = null; } catch { return; }
      }
      this.emit({ duration, position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0 });
    };
    on('loadedmetadata', progress);
    on('durationchange', progress);
    on('timeupdate', () => {
      progress();
      if (Date.now() - this.lastSaved > 5000) { this.lastSaved = Date.now(); this.save(); }
    });
    on('play', () => {
      if (!this.wantPlay) { audio.pause(); return; }
      if (!audio.paused) this.emit({ playing: true });
    });
    on('playing', () => {
      if (!this.wantPlay) { audio.pause(); return; }
      if (!audio.paused) this.emit({ playing: true, buffering: false, error: null });
    });
    on('pause', () => {
      // A queued internal pause must not cancel a newer play() or source.
      if (!audio.paused) return;
      // Natural completion fires pause before ended; retain intent for next(true).
      if (!audio.ended) {
        this.wantPlay = false;
        ++this.playRequest;
      }
      this.emit({ playing: false, buffering: false });
      this.save();
    });
    on('waiting', () => { if (this.wantPlay) this.emit({ buffering: true }); });
    on('stalled', () => { if (this.wantPlay) this.emit({ buffering: true }); });
    on('canplay', () => { if (!audio.paused) this.emit({ buffering: false }); });
    on('ended', () => { if (audio.ended && this.wantPlay) this.next(true); });
    on('error', () => {
      if (!audio.error || audio.error.code === 1) return;
      this.wantPlay = false;
      ++this.playRequest;
      audio.pause();
      this.emit({ playing: false, buffering: false, error: '播放失败，正在检查音频连接…' });
      this.diagnosis?.abort();
      const controller = new AbortController();
      this.diagnosis = controller;
      const key = this.snapshot.currentKey!;
      void this.client.describeStreamError(key, controller.signal).then((message) => {
        if (active() && !controller.signal.aborted) this.emit({ error: `播放失败：${message}` });
      }).catch(() => { /* Superseded diagnostics never affect a newer source. */ });
    });
  }

  stop(): void {
    this.detachSource();
    this.wantPlay = false;
    this.pendingSeek = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.emit({ currentKey: null, queue: [], history: [], position: 0, duration: 0, playing: false, buffering: false, error: null });
    this.save();
  }

  switchService(client: ApiClient, service: string): void {
    this.service = service;
    this.restored = true;
    this.initial.lastKey = null;
    this.initial.lastTime = 0;
    this.available.clear();
    this.stop();
    this.client = client;
  }

  destroy(): void {
    this.save();
    this.detachSource();
    this.audio.removeEventListener('volumechange', this.volumeChanged);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.listeners.clear();
  }
}
