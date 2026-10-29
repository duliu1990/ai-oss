import { Capacitor } from '@capacitor/core';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ConnectionPolicy { development: boolean; production: boolean; allowHttp: boolean }
export const CONNECTION_KEY = 'media-player-oss:server';

export function validateOrigin(input: string, policy: ConnectionPolicy): string {
  const value = input.trim();
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value) || /[@\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('请输入完整的 HTTPS 服务地址，不含账号、路径、查询参数或片段。');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('服务地址无效。'); }
  const httpAllowed = policy.development && !policy.production && policy.allowHttp;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && httpAllowed)) {
    throw new Error('服务地址必须使用 HTTPS。HTTP 仅限显式启用的开发环境。');
  }
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

export function initialConnection(native: boolean, preset: string, storage: StorageLike | undefined, policy: ConnectionPolicy): string | null {
  // Public build-time configuration is only a native default, never a Web override.
  if (!native) return '';
  const candidate = storedOrigin(storage) || preset;
  if (!candidate) return null;
  try { return validateOrigin(candidate, policy); } catch { return null; }
}

export const platform = {
  native: Capacitor.isNativePlatform(),
  policy: {
    development: import.meta.env.DEV,
    production: import.meta.env.PROD,
    allowHttp: import.meta.env.VITE_ALLOW_HTTP_DEV === 'true',
  } satisfies ConnectionPolicy,
  preset: import.meta.env.VITE_API_BASE_URL || '',
};
