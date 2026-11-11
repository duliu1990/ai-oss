import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import type { Track } from '../api/types';
import { displayArtist, displayTitle } from '../library/metadata';
import { usePlayer, useRuntime } from '../player/context';
import { Icon } from '../../../shared/Icon';
import { cycleRepeat, repeatLabels, Seek } from './PlayerBar';

/** Vertical travel (px) a swipe needs before it changes track. */
export const SWIPE_DISTANCE = 64;

type Direction = 'up' | 'down';
interface Props { track?: Track; keys: readonly string[]; pending: boolean; onFavorite(track: Track): void; onMessage(message: string): void; onClose(): void }

/** App-layout player sheet: swipe the stage up for the next track and down for the previous one. */
export function FullPlayer({ track, keys, pending, onFavorite, onMessage, onClose }: Props) {
  const { player } = useRuntime();
  const state = usePlayer();
  const hasQueue = !!state.currentKey || keys.length > 0 || state.queue.length > 0;
  const close = useRef<HTMLButtonElement>(null);
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState(0);
  // Remembers which track the swipe left so the slide-in only plays when the track actually changed.
  const [enter, setEnter] = useState<{ direction: Direction; from: string | null } | null>(null);
  const entering = enter && enter.from !== state.currentKey ? enter.direction : null;

  useEffect(() => {
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      // Hand focus back to the bar button that opened the sheet.
      document.getElementById('now-expand')?.focus();
    };
  }, [onClose]);

  const change = (direction: Direction) => {
    if (!hasQueue) return;
    setEnter({ direction, from: state.currentKey });
    // A swipe always changes track; only the button rewinds a track that is past 3 s.
    if (direction === 'up') player.next(false, keys);
    else player.previous(keys, false);
  };
  const reset = () => { start.current = null; setDrag(0); };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.target as Element).closest('button, input')) return;
    start.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    if (!origin || origin.id !== event.pointerId) return;
    const dy = event.clientY - origin.y;
    setDrag(Math.abs(dy) > Math.abs(event.clientX - origin.x) ? dy * 0.5 : 0);
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    reset();
    if (!origin || origin.id !== event.pointerId) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (Math.abs(dy) >= SWIPE_DISTANCE && Math.abs(dy) > Math.abs(dx) * 1.2) change(dy < 0 ? 'up' : 'down');
  };

  const title = track ? displayTitle(track) : '未在播放';
  return <div className="full-player" id="full-player" role="dialog" aria-modal="true" aria-label="正在播放">
    <header className="full-head">
      <button ref={close} id="full-close" className="icon-button" type="button" aria-label="收起播放页" onClick={onClose}><Icon name="chevron-down" /></button>
      <span className="full-eyebrow">NOW PLAYING</span>
      <span className="full-head-spacer" aria-hidden="true" />
    </header>
    <div className="full-stage" id="full-stage" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={reset}
      style={{ '--drag': `${drag}px` } as CSSProperties} data-dragging={drag !== 0 || undefined}>
      <div key={state.currentKey || 'idle'} className={`full-now ${entering ? `enter-${entering}` : ''}`} onAnimationEnd={() => setEnter(null)}>
        <div className="full-art" aria-hidden="true"><span className="full-vinyl"><Icon name="music" /></span></div>
        <div className="full-meta">
          <div className="full-text">
            <strong id="full-title" title={title}>{title}</strong>
            <span id="full-artist">{state.buffering ? '正在缓冲…' : track ? displayArtist(track) : '从列表中选择一首歌'}</span>
          </div>
          <button id="full-favorite" className={`icon-button ${track?.favorite ? 'is-favorite' : ''}`} type="button" aria-label={track?.favorite ? '取消喜欢' : '加入我喜欢'} aria-pressed={!!track?.favorite} disabled={!track || pending} onClick={() => track && onFavorite(track)}><Icon name={track?.favorite ? 'heart-fill' : 'heart'} /></button>
        </div>
      </div>
      <p className="full-hint" aria-hidden="true">上滑下一首 · 下滑上一首</p>
    </div>
    <div className="full-controls">
      <Seek key={state.currentKey || 'idle'} idPrefix="full-" position={state.position} duration={state.duration} onSeek={(value) => player.seek(value)} />
      <div className="full-buttons">
        <button id="full-shuffle" className="icon-button player-toggle" type="button" aria-label="随机播放" aria-pressed={state.shuffle} onClick={() => player.setShuffle(!state.shuffle)}><Icon name="shuffle" /></button>
        <button id="full-prev" className="icon-button" type="button" aria-label="上一首" disabled={!hasQueue} onClick={() => player.previous(keys)}><Icon name="prev" /></button>
        <button id="full-play" className="play-button" type="button" aria-label={state.playing || state.buffering ? '暂停' : '播放'} disabled={!hasQueue} onClick={() => player.toggle(keys)}><Icon name={state.playing || state.buffering ? 'pause' : 'play'} /></button>
        <button id="full-next" className="icon-button" type="button" aria-label="下一首" disabled={!hasQueue} onClick={() => player.next(false, keys)}><Icon name="next" /></button>
        <button id="full-repeat" className="icon-button player-toggle" type="button" aria-label={repeatLabels[state.repeat]} data-mode={state.repeat} onClick={() => cycleRepeat(player, state.repeat, onMessage)}><Icon name="repeat" /><span className="repeat-one" aria-hidden="true">1</span></button>
      </div>
    </div>
  </div>;
}
