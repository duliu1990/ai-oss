import type { LibraryView, SortOrder, Track } from '../api/types';

export const titleOf = (track: Track): string => track.title || track.info?.title || '';
export const artistOf = (track: Track): string => track.artist || track.info?.artist || '';
export const displayArtist = (track: Track): string => artistOf(track) || '未知歌手';

export function displayTitle(track: Track): string {
  if (titleOf(track)) return titleOf(track);
  const base = track.name.split('/').pop() || track.name;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return /^[0-9a-f]{32}$/i.test(stem) ? `未命名音频 ${stem.slice(0, 6)}` : stem;
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export function visibleTracks(tracks: readonly Track[], view: LibraryView, query: string, sort: SortOrder): Track[] {
  const text = query.trim().toLowerCase();
  const list = tracks.filter((track) => (view !== 'favorites' || track.favorite)
    && (!text || [displayTitle(track), artistOf(track), track.name].some((value) => value.toLowerCase().includes(text))));
  if (sort === 'title') list.sort((a, b) => collator.compare(displayTitle(a), displayTitle(b)));
  if (sort === 'artist') list.sort((a, b) => Number(!artistOf(a)) - Number(!artistOf(b))
    || collator.compare(artistOf(a), artistOf(b)) || collator.compare(displayTitle(a), displayTitle(b)));
  return list;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}/`;
  return `${year}${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
