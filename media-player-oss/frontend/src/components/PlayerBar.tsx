import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { RepeatMode, Track } from '../api/types';
import { displayArtist, displayTitle, formatTime } from '../library/metadata';
import { usePlayer, useRuntime } from '../player/context';
import { Icon } from './Icon';

export const repeatLabels: Record<RepeatMode, string> = { all: '列表循环', one: '单曲循环', off: '顺序播放（不循环）' };
const modes: RepeatMode[] = ['all', 'one', 'off'];
const fill = (percent: number): CSSProperties => ({ '--fill': `${percent}%` } as CSSProperties);

function Seek({ position, duration, onSeek }: { position: number; duration: number; onSeek(value: number): void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const value = Math.min(draft ?? position, duration || 0);
  const commit = (next: number) => { onSeek(next); setDraft(null); };
  return <div className="progress">
    <span id="time-current" className="time">{formatTime(draft ?? position)}</span>
    <input id="seek" className="range" type="range" min="0" max={duration} step="0.1" value={value} disabled={!duration}
      aria-label="播放进度" aria-valuetext={`${formatTime(value)} / ${formatTime(duration)}`} style={fill(duration ? value / duration * 100 : 0)}
      onChange={(event) => setDraft(Number(event.target.value))}
      onPointerUp={(event) => commit(Number(event.currentTarget.value))}
      onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commit(Number(event.currentTarget.value)); }}
      onBlur={(event) => { if (draft !== null) commit(Number(event.currentTarget.value)); }}
      onPointerCancel={() => setDraft(null)} />
    <span id="time-total" className="time">{formatTime(duration)}</span>
  </div>;
}

interface Props { track?: Track; keys: readonly string[]; pending: boolean; onFavorite(track: Track): void; onMessage(message: string): void }
export function PlayerBar({ track, keys, pending, onFavorite, onMessage }: Props) {
  const { player } = useRuntime();
  const state = usePlayer();
  const level = state.muted ? 0 : state.volume;
  const hasQueue = !!state.currentKey || keys.length > 0 || state.queue.length > 0;
  const repeat = () => {
    const mode = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
    player.setRepeat(mode);
    onMessage(repeatLabels[mode]);
  };
  return <footer className="player" aria-label="播放控制">
    <div className="now">
      <span className="disc" id="disc" aria-hidden="true"><Icon name="note" /></span>
      <div className="now-text">
        <strong id="now-title" title={track ? displayTitle(track) : undefined}>{track ? displayTitle(track) : '未在播放'}</strong>
        <span id="now-artist">{state.buffering ? '正在缓冲…' : track ? displayArtist(track) : '从列表中选择一首歌'}</span>
      </div>
      <button id="now-favorite" className={`icon-button ${track?.favorite ? 'is-favorite' : ''}`} type="button" aria-label={track?.favorite ? '取消喜欢' : '加入我喜欢'} aria-pressed={!!track?.favorite} disabled={!track || pending} onClick={() => track && onFavorite(track)}><Icon name={track?.favorite ? 'heart-fill' : 'heart'} /></button>
    </div>
    <div className="transport">
      <div className="buttons">
        <button id="shuffle" className="icon-button toggle" type="button" aria-label="随机播放" title="随机播放" aria-pressed={state.shuffle} onClick={() => player.setShuffle(!state.shuffle)}><Icon name="shuffle" /></button>
        <button id="prev" className="icon-button" type="button" aria-label="上一首" disabled={!hasQueue} onClick={() => player.previous(keys)}><Icon name="prev" /></button>
        <button id="play" className="play-button" type="button" aria-label={state.playing || state.buffering ? '暂停' : '播放'} disabled={!hasQueue} onClick={() => player.toggle(keys)}><Icon name={state.playing || state.buffering ? 'pause' : 'play'} /></button>
        <button id="next" className="icon-button" type="button" aria-label="下一首" disabled={!hasQueue} onClick={() => player.next(false, keys)}><Icon name="next" /></button>
        <button id="repeat" className="icon-button toggle" type="button" aria-label={repeatLabels[state.repeat]} title={repeatLabels[state.repeat]} data-mode={state.repeat} onClick={repeat}><Icon name="repeat" /><span className="repeat-one" aria-hidden="true">1</span></button>
      </div>
      <Seek key={state.currentKey || 'idle'} position={state.position} duration={state.duration} onSeek={(value) => player.seek(value)} />
    </div>
    <div className="volume">
      <button id="mute" className="icon-button" type="button" aria-label={state.muted ? '取消静音' : '静音'} onClick={() => player.toggleMute()}><Icon name={level === 0 ? 'muted' : 'volume'} /></button>
      <input id="volume" className="range" type="range" min="0" max="1" step="0.01" value={level} aria-label="音量" aria-valuetext={`${Math.round(level * 100)}%`} style={fill(level * 100)} onChange={(event) => player.setVolume(Number(event.target.value))} />
    </div>
    <span className="sr-only" role="status">{state.buffering ? '正在缓冲' : state.playing ? '正在播放' : '已暂停'}</span>
  </footer>;
}
