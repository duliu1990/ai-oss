import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { Track } from '../api/types';
import { displayTitle } from '../library/metadata';
import type { PlayerEngine } from './engine';

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}

export function useForegroundControls(player: PlayerEngine, visible: readonly string[], search: RefObject<HTMLInputElement | null>, track: Track | undefined, playing: boolean): void {
  useEffect(() => {
    document.body.classList.toggle('is-playing', playing);
    document.title = track ? `${playing ? '▶ ' : ''}${displayTitle(track)} · 轻听` : '轻听 · OSS 音乐播放器';
    return () => { document.body.classList.remove('is-playing'); };
  }, [track, playing]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLElement) || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (document.querySelector('dialog[open]')) return;
      const target = event.target;
      const range = target instanceof HTMLInputElement && target.type === 'range';
      const typing = !!target.closest('input, select, textarea, [contenteditable]');
      if (event.key === '/' && !typing) { event.preventDefault(); search.current?.focus(); return; }
      if (typing && !(range && event.key === ' ')) return;
      if (event.key === ' ' && !target.closest('button')) {
        event.preventDefault();
        if (!event.repeat) player.toggle(visible);
      } else if (!range && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        if (!player.getSnapshot().currentKey) return;
        event.preventDefault();
        player.seek(player.getSnapshot().position + (event.key === 'ArrowRight' ? 5 : -5));
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [player, visible, search]);

  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') player.save(); };
    window.addEventListener('pagehide', player.save);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', player.save);
      document.removeEventListener('visibilitychange', hidden);
      player.save();
    };
  }, [player]);
  // Native background, lock-screen and offline integrations are intentionally not registered.
}
