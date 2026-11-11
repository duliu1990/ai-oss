import { Capacitor, registerPlugin } from '@capacitor/core';
import { api } from './api/client';
import type { DriveApi } from './api/client';
import type { DriveItem } from './api/types';
import { tokens } from '../../shared/session';

interface CloudFilesPlugin {
  // The server is chosen at runtime, so the bridge receives it per call and validates it natively.
  open(options: { key: string; name: string; token: string; origin: string; mode: 'share' | 'preview' }): Promise<void>;
}

const cloudFiles = registerPlugin<CloudFilesPlugin>('CloudFiles');

export function isNativeIOS(): boolean {
  return Capacitor.getPlatform() === 'ios';
}

export function openPreview(url: string): void {
  if (isNativeIOS()) globalThis.location.assign(url);
  else globalThis.open(url, '_blank', 'noopener,noreferrer');
}

export function returnToFiles(key: string): void {
  const prefix = key.slice(0, key.lastIndexOf('/') + 1);
  globalThis.location.assign(`/?${new URLSearchParams({ prefix })}#/files`);
}

export async function openNativeFile(
  item: Pick<DriveItem, 'key' | 'name'>,
  mode: 'share' | 'preview',
  client: DriveApi = api,
): Promise<void> {
  const token = tokens.token();
  if (!token) throw new Error('登录已过期，请重新登录。');
  await cloudFiles.open({ key: item.key, name: item.name, token, origin: client.base, mode });
}

export async function downloadFile(client: DriveApi, item: Pick<DriveItem, 'key' | 'name'>): Promise<void> {
  if (isNativeIOS()) {
    await openNativeFile(item, 'share', client);
    return;
  }
  const link = document.createElement('a');
  link.href = client.downloadUrl(item.key, true);
  link.download = item.name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}
