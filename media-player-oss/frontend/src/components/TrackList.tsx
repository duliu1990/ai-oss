import { memo } from 'react';
import type { Track } from '../api/types';
import { displayArtist, displayTitle, formatDate, formatSize, formatTime, titleOf } from '../library/metadata';
import { Icon } from './Icon';

interface Props {
  tracks: readonly Track[];
  currentKey: string | null;
  playing: boolean;
  pending: ReadonlySet<string>;
  empty: string;
  loading: boolean;
  onPlay(key: string): void;
  onFavorite(track: Track): void;
  onEdit(key: string): void;
}

export const TrackList = memo(function TrackList({ tracks, currentKey, playing, pending, empty, loading, onPlay, onFavorite, onEdit }: Props) {
  return <section className="track-card" aria-labelledby="view-title" aria-busy={loading}>
    <div className="track-head" aria-hidden="true"><span>#</span><span>曲目</span><span className="col-meta">文件</span><span className="col-date">上传时间</span><span /></div>
    <ol id="track-list" className="track-list">
      {tracks.map((track, index) => {
        const title = displayTitle(track);
        const current = currentKey === track.key;
        const info = track.info;
        const origin = [info.source, info.source_host].filter(Boolean).join(' · ');
        const duration = typeof info.duration === 'number' ? formatTime(info.duration) : '';
        return <li className={`track ${current ? 'is-current' : ''}`} data-key={track.key} key={track.key} aria-current={current ? true : undefined} onClick={() => onPlay(track.key)}>
          <span className="track-index">
            <span className="num" aria-hidden="true">{index + 1}</span>
            <span className="bars" aria-hidden="true"><i /><i /><i /></span>
            <button type="button" className="row-play" data-action="play" aria-label={`${current && playing ? '暂停' : '播放'} ${title}`} onClick={(event) => { event.stopPropagation(); onPlay(track.key); }}><Icon name={current && playing ? 'pause' : 'play'} /></button>
          </span>
          <span className="track-main"><span className={`track-title ${titleOf(track) ? '' : 'untitled'}`} title={title}>{title}</span><span className="track-artist">{displayArtist(track)}</span></span>
          <span className="col-meta" title={origin ? `${track.key}\n来源：${origin}` : track.key}>{duration || track.name} · {formatSize(track.size)}</span>
          <span className="col-date">{formatDate(track.last_modified)}</span>
          <span className="track-actions">
            <button className={`icon-button ${track.favorite ? 'is-favorite' : ''}`} type="button" data-action="favorite" aria-pressed={track.favorite} aria-label={track.favorite ? '取消喜欢' : '加入我喜欢'} disabled={pending.has(track.key)} onClick={(event) => { event.stopPropagation(); onFavorite(track); }}><Icon name={track.favorite ? 'heart-fill' : 'heart'} /></button>
            <button className="icon-button" type="button" data-action="edit" aria-label={`编辑曲名和歌手：${title}`} disabled={pending.has(track.key)} onClick={(event) => { event.stopPropagation(); onEdit(track.key); }}><Icon name="edit" /></button>
          </span>
        </li>;
      })}
    </ol>
    {!tracks.length && <p id="empty" className="empty">{empty}</p>}
  </section>;
});
