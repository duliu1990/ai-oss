import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { ApiClient } from '../src/api/client';
import * as auth from '../src/hooks/useAuth';
import { downloadFile, openNativeFile, openPreview, returnToFiles } from '../src/nativeFiles';

const { nativeOpen } = vi.hoisted(() => ({ nativeOpen: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: vi.fn(() => 'web') },
  registerPlugin: vi.fn(() => ({ open: nativeOpen })),
}));

const item = { key: 'docs/中文 C++ 文件.pdf', name: '中文 C++ 文件.pdf' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  nativeOpen.mockReset();
  vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
});

describe('platform file operations', () => {
  it('opens web previews in a separate tab', () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    openPreview('/?office-preview=1');
    expect(open).toHaveBeenCalledWith('/?office-preview=1', '_blank', 'noopener,noreferrer');
  });

  it('keeps native previews inside the app', () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const open = vi.spyOn(globalThis, 'open');
    openPreview('/?office-preview=1');
    expect(assign).toHaveBeenCalledWith('/?office-preview=1');
    expect(open).not.toHaveBeenCalled();
  });

  it('returns to the original folder without retaining preview parameters', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    returnToFiles('docs/工作/计划.md');
    const target = new URL(assign.mock.calls[0][0], 'http://localhost');
    expect(target.searchParams.get('prefix')).toBe('docs/工作/');
    expect(target.searchParams.has('markdown-preview')).toBe(false);
  });

  it('preserves anchor downloads on the web', async () => {
    const client = new ApiClient('');
    const url = vi.spyOn(client, 'downloadUrl').mockReturnValue('/api/files/download?key=test&download=true');
    let downloadedName = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadedName = this.download;
      expect(this.isConnected).toBe(true);
    });
    await downloadFile(client, item);
    expect(url).toHaveBeenCalledWith(item.key, true);
    expect(click).toHaveBeenCalledOnce();
    expect(downloadedName).toBe(item.name);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(nativeOpen).not.toHaveBeenCalled();
  });

  it('downloads native files through the share sheet without navigation or token URLs', async () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
    vi.spyOn(auth, 'getAuthToken').mockReturnValue('unit-test-token');
    const client = new ApiClient('');
    const url = vi.spyOn(client, 'downloadUrl');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    nativeOpen.mockResolvedValue(undefined);
    await downloadFile(client, item);
    expect(nativeOpen).toHaveBeenCalledWith({ ...item, token: 'unit-test-token', mode: 'share' });
    expect(url).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('uses the native reader for PDF files', async () => {
    vi.spyOn(auth, 'getAuthToken').mockReturnValue('unit-test-token');
    nativeOpen.mockResolvedValue(undefined);
    await openNativeFile(item, 'preview');
    expect(nativeOpen).toHaveBeenCalledWith({ ...item, token: 'unit-test-token', mode: 'preview' });
  });

  it('rejects expired sessions without calling the native plugin', async () => {
    vi.spyOn(auth, 'getAuthToken').mockReturnValue(null);
    await expect(openNativeFile(item, 'share')).rejects.toThrow('登录已过期');
    expect(nativeOpen).not.toHaveBeenCalled();
  });

  it('propagates native download failures for display', async () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
    vi.spyOn(auth, 'getAuthToken').mockReturnValue('unit-test-token');
    nativeOpen.mockRejectedValue(new Error('文件读取失败（404）。'));
    await expect(downloadFile(new ApiClient(''), item)).rejects.toThrow('404');
  });
});
