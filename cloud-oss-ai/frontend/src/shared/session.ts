import { TokenStore } from './auth/tokens';
import { browserStorage, initialConnection, platform } from './platform/connection';

// One storage, one starting server and one token store for the whole page, so the drive client,
// the player and the preview windows all see the same session.
export const storage = browserStorage();
export const initialBase = initialConnection(platform.native, platform.preset, storage);
export const tokens = new TokenStore(initialBase ?? '', storage);
