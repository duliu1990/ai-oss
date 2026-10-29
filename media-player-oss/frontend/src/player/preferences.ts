import type { RepeatMode, SortOrder } from '../api/types';
import type { StorageLike } from '../platform/connection';

export const STORE_KEY = 'media-player-oss';
export interface Preferences {
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  sort: SortOrder;
  lastKey: string | null;
  lastTime: number;
  service?: string | null;
}

export const defaults: Preferences = {
  volume: 0.8, muted: false, shuffle: false, repeat: 'all', sort: 'recent', lastKey: null, lastTime: 0,
};

export function readPreferences(storage?: StorageLike): Preferences {
  try {
    const data: unknown = JSON.parse(storage?.getItem(STORE_KEY) || 'null');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...defaults };
    const p = data as Record<string, unknown>;
    return {
      volume: typeof p.volume === 'number' && Number.isFinite(p.volume) ? Math.min(1, Math.max(0, p.volume)) : 0.8,
      muted: p.muted === true, shuffle: p.shuffle === true,
      repeat: p.repeat === 'one' || p.repeat === 'off' ? p.repeat : 'all',
      sort: p.sort === 'title' || p.sort === 'artist' ? p.sort : 'recent',
      lastKey: typeof p.lastKey === 'string' ? p.lastKey : null,
      lastTime: typeof p.lastTime === 'number' && Number.isFinite(p.lastTime) ? Math.max(0, p.lastTime) : 0,
      service: typeof p.service === 'string' ? p.service : null,
    };
  } catch { return { ...defaults }; }
}

export function writePreferences(prefs: Preferences, storage?: StorageLike): void {
  try { storage?.setItem(STORE_KEY, JSON.stringify(prefs)); } catch {
    // Storage restrictions must not interrupt foreground playback.
  }
}
