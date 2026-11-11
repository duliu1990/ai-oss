import { StrictMode } from 'react';
import type { Root } from 'react-dom/client';
import '../shared/theme.css';
import '../shared/shared.css';
import '../modules/drive/drive.css';
import '../modules/player/player.css';
import { platform } from '../shared/platform/connection';
import { initialBase, storage, tokens } from '../shared/session';
import { ToastProvider } from '../shared/Toast';
import { PlayerApi } from '../modules/player/api/client';
import { LibraryStore } from '../modules/player/library/store';
import { RuntimeProvider } from '../modules/player/player/context';
import { PlayerEngine } from '../modules/player/player/engine';
import AppShell from './AppShell';

export function start(root: Root): void {
  // Construct exactly once outside React render/effects, including StrictMode remounts, so music
  // keeps playing while the shell switches between modules.
  const audio = new Audio();
  audio.id = 'audio';
  audio.hidden = true;
  document.body.append(audio);
  const player = new PlayerEngine(audio, new PlayerApi(initialBase || '', undefined, tokens), storage, platform.native, initialBase);
  const library = new LibraryStore(player, { native: platform.native, base: initialBase, storage, tokens });
  const runtime = { player, library, native: platform.native };
  root.render(<StrictMode><RuntimeProvider runtime={runtime}><ToastProvider><AppShell /></ToastProvider></RuntimeProvider></StrictMode>);
  void library.refresh();

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      root.unmount();
      library.dispose();
      tokens.dispose();
      player.destroy();
      audio.remove();
    });
  }
}
