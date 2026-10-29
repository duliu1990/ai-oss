import type { RepeatMode } from '../api/types';

export interface QueueState {
  queue: readonly string[];
  history: readonly string[];
  currentKey: string | null;
  shuffle: boolean;
  repeat: RepeatMode;
}

export function nextKey(state: QueueState, auto = false, random: () => number = Math.random): string | null {
  const { queue, history, currentKey, shuffle, repeat } = state;
  if (!queue.length) return null;
  if (auto && repeat === 'one' && currentKey && queue.includes(currentKey)) return currentKey;
  // Preserve the original behavior: shuffle keeps choosing even with repeat off.
  if (shuffle && queue.length > 1) {
    const recent = new Set(history.slice(-Math.floor(queue.length / 2)));
    if (currentKey) recent.add(currentKey);
    const pool = queue.filter((key) => !recent.has(key));
    const choices = pool.length ? pool : queue.filter((key) => key !== currentKey);
    return choices[Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)))];
  }
  const index = currentKey ? queue.indexOf(currentKey) : -1;
  if (index + 1 < queue.length) return queue[index + 1];
  return !auto || repeat === 'all' ? queue[0] : null;
}

export function previousKey(state: QueueState, available: ReadonlySet<string>): { key: string | null; history: string[] } {
  const history = [...state.history];
  if (state.shuffle) {
    while (history.length) {
      const key = history.pop()!;
      if (available.has(key)) return { key, history };
    }
    return { key: null, history };
  }
  const index = state.currentKey ? state.queue.indexOf(state.currentKey) : -1;
  return { key: state.queue[index > 0 ? index - 1 : state.queue.length - 1] || null, history };
}
