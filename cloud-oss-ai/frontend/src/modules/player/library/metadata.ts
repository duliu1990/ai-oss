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
