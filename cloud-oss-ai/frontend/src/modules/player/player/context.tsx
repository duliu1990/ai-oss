import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { LibraryStore } from '../library/store';
import type { PlayerEngine } from './engine';

export interface Runtime { player: PlayerEngine; library: LibraryStore; native: boolean }
const RuntimeContext = createContext<Runtime | null>(null);

export function RuntimeProvider({ runtime, children }: { runtime: Runtime; children: ReactNode }) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('Player runtime is unavailable');
  return runtime;
}

export function usePlayer() {
  const { player } = useRuntime();
  return useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
}

export function useLibrary() {
  const { library } = useRuntime();
  return useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
}
