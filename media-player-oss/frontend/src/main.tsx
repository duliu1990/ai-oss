import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ApiClient } from './api/client';
import { LibraryStore } from './library/store';
import { TokenStore } from './platform/auth';
import { browserStorage, initialConnection, platform } from './platform/connection';
import { RuntimeProvider } from './player/context';
import { PlayerEngine } from './player/engine';
import './style.css';

const storage = browserStorage();
const base = initialConnection(platform.native, platform.preset, storage, platform.policy);
// One token holder serves both clients, so an expired session stops listing and playback together.
const tokens = new TokenStore(base || '', storage);
// Construct exactly once outside React render/effects, including StrictMode remounts.
const audio = new Audio();
audio.id = 'audio';
audio.hidden = true;
document.body.append(audio);
const player = new PlayerEngine(audio, new ApiClient(base || '', undefined, tokens), storage, platform.native, base);
const library = new LibraryStore(player, { native: platform.native, base, policy: platform.policy, storage, tokens });
const runtime = { player, library, native: platform.native };
const root = createRoot(document.getElementById('root')!);
root.render(<StrictMode><RuntimeProvider runtime={runtime}><App /></RuntimeProvider></StrictMode>);
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
