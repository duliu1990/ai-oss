import type { StorageLike } from './connection';

// Each server origin gets its own entry: a token minted by one service is worthless at another.
const TOKEN_PREFIX = 'media-player-oss:token:';
// Treat a token that is about to lapse as already gone, so playback never starts on a dying one.
const EXPIRY_GUARD_MS = 30_000;

export function tokenKey(base: string): string {
  // The Web build always talks to its own origin and stores under a single stable key.
  return `${TOKEN_PREFIX}${base || 'self'}`;
}

function payloadExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  // JWT uses base64url; atob only accepts standard base64 with padding.
  const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const claims: unknown = JSON.parse(atob(padded));
    if (typeof claims !== 'object' || claims === null) return null;
    const exp = (claims as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** A token is usable only when it parses and still has headroom before expiry. */
export function isTokenUsable(token: string, now = Date.now()): boolean {
  const expiry = payloadExpiry(token);
  return expiry !== null && expiry > now + EXPIRY_GUARD_MS;
}

export function readToken(base: string, storage?: StorageLike): string | null {
  try {
    const token = storage?.getItem(tokenKey(base));
    if (!token) return null;
    if (isTokenUsable(token)) return token;
    // Drop a stale token instead of sending it and collecting a 401 on every request.
    storage?.removeItem(tokenKey(base));
    return null;
  } catch {
    return null;
  }
}

export function saveToken(base: string, token: string, storage?: StorageLike): void {
  try { storage?.setItem(tokenKey(base), token); } catch { /* Private mode storage is optional. */ }
}

export function clearToken(base: string, storage?: StorageLike): void {
  try { storage?.removeItem(tokenKey(base)); } catch { /* Nothing to clean up. */ }
}

/**
 * Holds the token of the service in use and notifies listeners whenever it appears or goes away.
 * Both the library client and the player client read through this one instance, so a session that
 * expires mid-playback is dropped everywhere at once.
 */
export class TokenStore {
  private current: string | null;
  private listeners = new Set<() => void>();

  constructor(private origin: string, private readonly storage?: StorageLike) {
    this.current = readToken(origin, storage);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  token = (): string | null => this.current;

  /** The server rejected this token, so stop presenting it and let the UI ask for a login. */
  onUnauthorized = (): void => { this.replace(null); };

  save(token: string): void {
    saveToken(this.origin, token, this.storage);
    this.replace(token);
  }

  clear(): void {
    clearToken(this.origin, this.storage);
    this.replace(null);
  }

  /** Follow a service switch: each origin keeps its own token, so the old one stays on disk. */
  rebind(origin: string): void {
    this.origin = origin;
    this.replace(readToken(origin, this.storage));
  }

  dispose(): void {
    this.listeners.clear();
  }

  private replace(token: string | null): void {
    if (token === this.current) return;
    this.current = token;
    this.listeners.forEach((listener) => listener());
  }
}
