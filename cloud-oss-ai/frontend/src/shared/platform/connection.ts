import { Capacitor } from '@capacitor/core';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const CONNECTION_KEY = 'cloud-oss-ai:server';

export function validateOrigin(input: string): string {
  let value = input.trim();
  // A bare host such as 192.168.1.10:8790 means plain HTTP, the usual setup for a self-hosted server.
  if (value && !value.startsWith('/') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value) || /[@\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('请输入 HTTP 或 HTTPS 服务地址（可省略 http://），不含账号、路径、查询参数或片段。');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('服务地址无效。'); }
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('服务地址只能包含协议、主机名和可选端口。');
  }
  return url.origin;
}

export function browserStorage(): StorageLike | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

export function storedOrigin(storage?: StorageLike): string {
  try { return storage?.getItem(CONNECTION_KEY) || ''; } catch { return ''; }
}

export function saveOrigin(origin: string, storage?: StorageLike): boolean {
  try {
    if (!storage) return false;
    storage.setItem(CONNECTION_KEY, origin);
    return true;
  } catch { return false; }
}

export function initialConnection(native: boolean, preset: string, storage: StorageLike | undefined): string | null {
  // Public build-time configuration is only a native default, never a Web override.
  if (!native) return '';
  const candidate = storedOrigin(storage) || preset;
  if (!candidate) return null;
  try { return validateOrigin(candidate); } catch { return null; }
}

export const platform = {
  native: Capacitor.isNativePlatform(),
  // Empty by default: a fresh native install asks for its server instead of guessing one.
  preset: import.meta.env.VITE_API_BASE_URL || '',
};
