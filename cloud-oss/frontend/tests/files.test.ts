import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import App from '../src/App';
import { api, ApiClient, ApiError, endpoint } from '../src/api/client';
import type { DriveItem, FileEntry } from '../src/api/types';
import { breadcrumbSegments } from '../src/components/Breadcrumb';
import { fileIcon } from '../src/components/FileItem';
import { sortDriveItems } from '../src/components/FileList';
import { PreviewModal, previewType } from '../src/components/PreviewModal';
import {
  assertOfficeFileSize,
  assertXlsxZipSignature,
  calculateContainSize,
  DOCX_RENDER_OPTIONS,
  MAX_OFFICE_FILE_BYTES,
  observePptxContainLayout,
  officePreviewRequest,
  officePreviewUrl,
  workbookToSpreadsheetData,
} from '../src/officePreview';
import {
  CHUNK_SIZE,
  CHUNK_THRESHOLD,
  PART_RETRY_DELAYS,
  uploadPartWithRetry,
} from '../src/hooks/useUpload';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

function item(name: string, changes: Partial<DriveItem> = {}): DriveItem {
  return {
    kind: 'file',
    key: `docs/${name}`,
    name,
    size: 100,
    lastModified: '2026-01-01T00:00:00Z',
    isDir: false,
    ...changes,
  };
}

let appRoot: Root | null = null;
let appContainer: HTMLDivElement | null = null;
let previewRoot: Root | null = null;
let previewContainer: HTMLDivElement | null = null;
let fullscreenElement: Element | null = null;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  fullscreenElement = null;
  if (appRoot) act(() => appRoot?.unmount());
  appRoot = null;
  appContainer?.remove();
  appContainer = null;
  if (previewRoot) act(() => previewRoot?.unmount());
  previewRoot = null;
  previewContainer?.remove();
  previewContainer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderApp(files: FileEntry[] = []) {
  vi.spyOn(api, 'config').mockResolvedValue({ bucket: 'mock-bucket', prefix: '', port: 8700 });
  vi.spyOn(api, 'files').mockResolvedValue({
    files,
    folders: [],
    next_marker: null,
    truncated: false,
  });
  const upload = vi.spyOn(api, 'upload').mockImplementation(async (file, key) => ({ key, size: file.size }));
  appContainer = document.createElement('div');
  document.body.append(appContainer);
  appRoot = createRoot(appContainer);
  await act(async () => {
    appRoot?.render(createElement(App));
    await Promise.resolve();
  });
  return { container: appContainer, upload };
}

function mockDataTransfer(files: File[]): DataTransfer {
  return { files, dropEffect: 'none' } as unknown as DataTransfer;
}

async function dropFiles(target: Element, files: File[]): Promise<Event> {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: mockDataTransfer(files) });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

async function chooseFiles(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

function renderPreview(name: string) {
  const onClose = vi.fn();
  const onDownload = vi.fn();
  const onNotify = vi.fn();
  const exitFullscreen = vi.fn(async () => {
    fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: exitFullscreen,
  });
  previewContainer = document.createElement('div');
  document.body.append(previewContainer);
  previewRoot = createRoot(previewContainer);
  act(() => {
    previewRoot?.render(createElement(PreviewModal, {
      client: new ApiClient(''),
      item: item(name),
      onClose,
      onDownload,
      onNotify,
    }));
  });
  return { container: previewContainer, exitFullscreen, onClose, onDownload, onNotify };
}

describe('ApiClient', () => {
  it('uses globalThis as the native fetch receiver and applies secure request defaults', async () => {
    const respond = vi.fn<typeof fetch>().mockResolvedValue(json({ bucket: 'private', prefix: 'vault/', port: 8700 }));
    function browserFetch(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return respond(...args);
    }
    vi.stubGlobal('fetch', browserFetch);
    await expect(new ApiClient('').config()).resolves.toEqual({ bucket: 'private', prefix: 'vault/', port: 8700 });
    expect(respond).toHaveBeenCalledWith('/api/config', expect.objectContaining({
      credentials: 'omit',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    }));
  });

  it('encodes keys and validates file listing responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({
      files: [{ key: '中文/a #1.pdf', name: 'a #1.pdf', size: 42, last_modified: '2026-01-01', is_dir: false }],
      folders: [{ prefix: '中文/sub/', name: 'sub' }],
      next_marker: null,
      truncated: false,
    }));
    const client = new ApiClient('', fetcher);
    const listing = await client.files('中文/');
    expect(listing.files[0].size).toBe(42);
    expect(String(fetcher.mock.calls[0][0])).toContain('%E4%B8%AD%E6%96%87%2F');
    expect(new URL(client.downloadUrl('中文/a +#1.pdf', true), 'https://drive.test').searchParams.get('key')).toBe('中文/a +#1.pdf');
    expect(endpoint('', '/api/files', { key: 'a&b' })).toBe('/api/files?key=a%26b');
  });

  it('rejects malformed success payloads and preserves API errors', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ bucket: 'missing-port', prefix: '' }))
      .mockResolvedValueOnce(json({ detail: '拒绝访问' }, 403));
    const client = new ApiClient('', fetcher);
    await expect(client.config()).rejects.toBeInstanceOf(ApiError);
    await expect(client.config()).rejects.toMatchObject({ message: '拒绝访问', status: 403 });
  });
});

describe('upload entry interactions', () => {
  it('uploads one overlay-dropped file once without bubbling into the workspace handler', async () => {
    const { container, upload } = await renderApp();
    const overlay = container.querySelector('.drop-overlay');
    if (!overlay) throw new Error('Drop overlay was not rendered');

    const event = await dropFiles(overlay, [new File(['one'], 'one.txt', { type: 'text/plain' })]);

    expect(event.defaultPrevented).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.upload-task')).toHaveLength(1);
  });

  it('creates exactly three tasks and uploads for a three-file overlay drop', async () => {
    const { container, upload } = await renderApp();
    const overlay = container.querySelector('.drop-overlay');
    if (!overlay) throw new Error('Drop overlay was not rendered');
    const files = ['one.txt', 'two.txt', 'three.txt']
      .map((name) => new File([name], name, { type: 'text/plain' }));

    await dropFiles(overlay, files);

    expect(upload).toHaveBeenCalledTimes(3);
    expect(container.querySelectorAll('.upload-task')).toHaveLength(3);
  });

  it('uploads a file selected from the picker exactly once', async () => {
    const { container, upload } = await renderApp();
    const picker = container.querySelector<HTMLInputElement>('#file-picker');
    if (!picker) throw new Error('File picker was not rendered');

    await chooseFiles(picker, [new File(['picked'], 'picked.txt', { type: 'text/plain' })]);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.upload-task')).toHaveLength(1);
  });

  it('still uploads once when a file is dropped on the workspace', async () => {
    const { container, upload } = await renderApp();
    const workspace = container.querySelector('.workspace');
    if (!workspace) throw new Error('Workspace was not rendered');

    await dropFiles(workspace, [new File(['workspace'], 'workspace.txt', { type: 'text/plain' })]);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.upload-task')).toHaveLength(1);
  });
});

describe('Office preview dispatch', () => {
  const officeFiles: FileEntry[] = ['report.docx', 'budget.xlsx', 'briefing.pptx'].map((name) => ({
    key: `团队文档/${name}`,
    name,
    size: 128,
    last_modified: '2026-01-01T00:00:00Z',
    is_dir: false,
  }));

  it('opens each supported Office format in a dedicated new tab', async () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    const { container } = await renderApp(officeFiles);
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.file-open'));

    for (const button of buttons) {
      act(() => button.click());
    }

    expect(open).toHaveBeenCalledTimes(3);
    for (const file of officeFiles) {
      const expected = `/?${new URLSearchParams({ 'office-preview': '1', key: file.key, name: file.name }).toString()}`;
      expect(open).toHaveBeenCalledWith(expected, '_blank', 'noopener,noreferrer');
    }
  });

  it('keeps legacy Office formats in the existing modal and assigns distinct modern-format icons', async () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    const legacy: FileEntry = {
      key: 'archive/legacy.doc',
      name: 'legacy.doc',
      size: 64,
      last_modified: '2026-01-01T00:00:00Z',
      is_dir: false,
    };
    const { container } = await renderApp([legacy]);

    act(() => container.querySelector<HTMLButtonElement>('.file-open')?.click());

    expect(open).not.toHaveBeenCalled();
    expect(container.querySelector('.preview-unknown')).not.toBeNull();
    expect(fileIcon(item('report.docx'))).toBe('word');
    expect(fileIcon(item('budget.xlsx'))).toBe('sheet');
    expect(fileIcon(item('briefing.pptx'))).toBe('slides');
    expect(fileIcon(item('legacy.doc'))).toBe('file');
  });
});

describe('PPTX contain layout', () => {
  it('uses the width limit while preserving the slide aspect ratio', () => {
    expect(calculateContainSize(800, 800, 1600, 900)).toEqual({
      height: 450,
      scale: 0.5,
      width: 800,
    });
  });

  it('uses the height limit while preserving the slide aspect ratio', () => {
    const fitted = calculateContainSize(1200, 500, 1600, 900);

    expect(fitted.scale).toBeCloseTo(5 / 9);
    expect(fitted.width).toBeCloseTo(888.89, 2);
    expect(fitted.height).toBe(500);
  });

  it('guards against unavailable stage and slide dimensions', () => {
    expect(calculateContainSize(0, 500, 960, 540)).toEqual({ height: 0, scale: 0, width: 0 });
    expect(calculateContainSize(800, 0, 960, 540)).toEqual({ height: 0, scale: 0, width: 0 });
    expect(calculateContainSize(800, 500, 0, 0)).toEqual({ height: 0, scale: 0, width: 0 });
  });

  it('lays out slides inserted after the initial frame, responds to resize, and cleans up observers', () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    let mutationCallback: MutationCallback | undefined;
    const resizeObserve = vi.fn();
    const resizeDisconnect = vi.fn();
    const mutationObserve = vi.fn();
    const mutationDisconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      disconnect = resizeDisconnect;
      observe = resizeObserve;
      unobserve = vi.fn();
    });
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) {
        mutationCallback = callback;
      }

      disconnect = mutationDisconnect;
      observe = mutationObserve;
      takeRecords = vi.fn(() => []);
    });

    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    const cancelFrame = vi.fn((id: number) => frames.delete(id));
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const flushFrames = () => {
      const pending = Array.from(frames.values());
      frames.clear();
      pending.forEach((callback) => callback(0));
    };

    let stageWidth = 1200;
    let stageHeight = 500;
    const stage = document.createElement('div');
    Object.defineProperties(stage, {
      clientHeight: { configurable: true, get: () => stageHeight },
      clientWidth: { configurable: true, get: () => stageWidth },
    });
    const host = document.createElement('div');
    const dispose = observePptxContainLayout(stage, host);
    expect(resizeObserve).toHaveBeenCalledWith(stage);
    expect(mutationObserve).toHaveBeenCalledWith(host, { childList: true, subtree: true });
    flushFrames();
    expect(host.querySelectorAll('.office-pptx-page')).toHaveLength(0);

    const wrapper = document.createElement('div');
    wrapper.className = 'pptx-preview-wrapper';
    host.append(wrapper);
    for (let index = 0; index < 2; index += 1) {
      const slide = document.createElement('div');
      slide.className = `pptx-preview-slide-wrapper pptx-preview-slide-wrapper-${index}`;
      slide.style.width = '960px';
      slide.style.height = '540px';
      wrapper.append(slide);
    }
    mutationCallback?.([], {} as MutationObserver);
    flushFrames();

    let pages = host.querySelectorAll<HTMLElement>('.office-pptx-page');
    expect(pages).toHaveLength(2);
    expect(wrapper.classList.contains('office-pptx-pages')).toBe(true);
    expect(Number.parseFloat(pages[0].style.width)).toBeCloseTo(888.89, 2);
    expect(pages[0].style.height).toBe('500px');

    stageWidth = 800;
    stageHeight = 800;
    resizeCallback?.([], {} as ResizeObserver);
    flushFrames();
    pages = host.querySelectorAll<HTMLElement>('.office-pptx-page');
    expect(pages).toHaveLength(2);
    expect(pages[0].style.width).toBe('800px');
    expect(pages[0].style.height).toBe('450px');
    expect(host.querySelectorAll<HTMLElement>('.pptx-preview-slide-wrapper')[1].style.transform)
      .toBe('scale(0.8333333333333334)');

    mutationCallback?.([], {} as MutationObserver);
    dispose();
    expect(resizeDisconnect).toHaveBeenCalledOnce();
    expect(mutationDisconnect).toHaveBeenCalledOnce();
    expect(cancelFrame).toHaveBeenCalledOnce();
    expect(frames).toHaveLength(0);
  });
});

describe('Office preview security and spreadsheet conversion', () => {
  it('disables DOCX altChunk rendering', () => {
    expect(DOCX_RENDER_OPTIONS).toMatchObject({ renderAltChunks: false });
  });

  it('preserves a non-A1 used-range offset and absolute merge coordinates', () => {
    const sheet: XLSX.WorkSheet = {
      '!ref': 'C5:D5',
      '!merges': [XLSX.utils.decode_range('C5:D5')],
      C5: { t: 's', v: '保留在 C5' },
      D5: { t: 's', v: '' },
    };
    const [converted] = workbookToSpreadsheetData({
      SheetNames: ['偏移工作表'],
      Sheets: { 偏移工作表: sheet },
    }, XLSX.utils);

    expect(converted.rows).toMatchObject({
      4: { cells: { 2: { text: '保留在 C5' } } },
    });
    expect(converted.merges).toEqual(['C5:D5']);
  });

  it('keeps common Excel error cells as readable error text', () => {
    const sheet: XLSX.WorkSheet = {
      '!ref': 'A1:C1',
      A1: { t: 'e', v: 0x07 },
      B1: { t: 'e', v: 0x17 },
      C1: { t: 'e', v: 0x2a },
    };
    const [converted] = workbookToSpreadsheetData({
      SheetNames: ['错误值'],
      Sheets: { 错误值: sheet },
    }, XLSX.utils);

    expect(converted.rows).toMatchObject({
      0: {
        cells: {
          0: { text: '#DIV/0!' },
          1: { text: '#REF!' },
          2: { text: '#N/A' },
        },
      },
    });
  });

  it('preserves the exact OSS key through preview query and download URL encoding', () => {
    const key = ' 目录/中文 + 100% & #.xlsx';
    const previewUrl = officePreviewUrl({ key, name: '显示名称.xlsx' });
    const request = officePreviewRequest(new URL(previewUrl, 'https://drive.test').search);
    const downloadUrl = new URL(api.downloadUrl(request.key), 'https://drive.test');

    expect(request.key).toBe(key);
    expect(downloadUrl.searchParams.get('key')).toBe(key);
  });

  it('rejects oversized files and non-ZIP XLSX input before parsing', () => {
    expect(() => assertOfficeFileSize(MAX_OFFICE_FILE_BYTES)).not.toThrow();
    expect(() => assertOfficeFileSize(MAX_OFFICE_FILE_BYTES + 1)).toThrow('25 MiB');
    expect(() => assertXlsxZipSignature(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer)).not.toThrow();
    expect(() => assertXlsxZipSignature(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0]).buffer)).toThrow('OOXML');
  });
});

describe('multipart upload retries', () => {
  it('retries a failed part three times with exponential backoff', async () => {
    vi.useFakeTimers();
    const upload = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockRejectedValueOnce(new Error('third failure'))
      .mockResolvedValue('etag');
    const controller = new AbortController();

    const result = uploadPartWithRetry(upload, controller.signal);
    await Promise.resolve();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(PART_RETRY_DELAYS).toEqual([1_000, 2_000, 4_000]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(upload).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(upload).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(result).resolves.toBe('etag');
    expect(upload).toHaveBeenCalledTimes(4);
  });

  it('stops a pending retry immediately when cancelled', async () => {
    vi.useFakeTimers();
    const upload = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('network failure'));
    const controller = new AbortController();

    const result = uploadPartWithRetry(upload, controller.signal);
    await Promise.resolve();
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

describe('PDF preview fullscreen', () => {
  it('shows fullscreen only for PDF while preserving same-origin preview, download, and close actions', async () => {
    const pdf = renderPreview('manual.pdf');
    expect(pdf.container.querySelector('.fullscreen-button')?.textContent).toContain('全屏');
    expect(pdf.container.querySelector('iframe')?.getAttribute('src')).toBe('/api/files/download?key=docs%2Fmanual.pdf');

    const actions = Array.from(pdf.container.querySelectorAll<HTMLButtonElement>('.preview-actions button'));
    actions.find((button) => button.textContent?.includes('下载'))?.click();
    await act(async () => { actions.find((button) => button.getAttribute('aria-label') === '关闭预览')?.click(); });
    expect(pdf.onDownload).toHaveBeenCalledWith(expect.objectContaining({ name: 'manual.pdf' }));
    expect(pdf.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not show fullscreen for a non-PDF preview', () => {
    const image = renderPreview('cover.webp');
    expect(image.container.querySelector('.fullscreen-button')).toBeNull();
  });

  it('targets the modal, follows fullscreenchange, exits on a second click, and recovers after Esc', async () => {
    const preview = renderPreview('manual.pdf');
    const modal = preview.container.querySelector<HTMLElement>('.preview-modal');
    const button = preview.container.querySelector<HTMLButtonElement>('.fullscreen-button');
    if (!modal || !button) throw new Error('PDF fullscreen controls were not rendered');
    const requestFullscreen = vi.fn(async () => { fullscreenElement = modal; });
    Object.defineProperty(modal, 'requestFullscreen', { configurable: true, value: requestFullscreen });

    await act(async () => { button.click(); await Promise.resolve(); });
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(fullscreenElement).toBe(modal);
    act(() => document.dispatchEvent(new Event('fullscreenchange')));
    expect(button.textContent).toContain('退出全屏');

    await act(async () => { button.click(); await Promise.resolve(); });
    expect(preview.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(button.textContent).toContain('全屏');

    await act(async () => { button.click(); await Promise.resolve(); });
    act(() => document.dispatchEvent(new Event('fullscreenchange')));
    act(() => globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(preview.onClose).not.toHaveBeenCalled();
    fullscreenElement = null;
    act(() => document.dispatchEvent(new Event('fullscreenchange')));
    expect(button.textContent).toContain('全屏');
  });

  it('uses the application notification path when fullscreen is unavailable or rejected', async () => {
    const preview = renderPreview('manual.pdf');
    const modal = preview.container.querySelector<HTMLElement>('.preview-modal');
    const button = preview.container.querySelector<HTMLButtonElement>('.fullscreen-button');
    if (!modal || !button) throw new Error('PDF fullscreen controls were not rendered');
    Object.defineProperty(modal, 'requestFullscreen', { configurable: true, value: undefined });

    await act(async () => { button.click(); await Promise.resolve(); });
    expect(preview.onNotify).toHaveBeenCalledWith('当前浏览器不支持全屏阅读。');

    preview.onNotify.mockClear();
    const requestFullscreen = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(modal, 'requestFullscreen', { configurable: true, value: requestFullscreen });
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(preview.onNotify).toHaveBeenCalledWith('无法进入全屏阅读，请检查浏览器权限后重试。');
    expect(preview.onClose).not.toHaveBeenCalled();
  });
});

describe('file navigation helpers', () => {
  it('builds clickable cumulative breadcrumb prefixes', () => {
    expect(breadcrumbSegments('projects/2026/assets/')).toEqual([
      { label: '根目录', prefix: '' },
      { label: 'projects', prefix: 'projects/' },
      { label: '2026', prefix: 'projects/2026/' },
      { label: 'assets', prefix: 'projects/2026/assets/' },
    ]);
  });

  it('keeps folders first while sorting naturally by name, size, and date', () => {
    const values = [
      item('file10.txt', { size: 10, lastModified: '2026-01-01' }),
      item('Folder', { kind: 'folder', key: 'Folder/', isDir: true, size: 0, lastModified: '' }),
      item('file2.txt', { size: 20, lastModified: '2026-02-01' }),
    ];
    expect(sortDriveItems(values, 'name', 'asc').map((value) => value.name)).toEqual(['Folder', 'file2.txt', 'file10.txt']);
    expect(sortDriveItems(values, 'size', 'desc').map((value) => value.name)).toEqual(['Folder', 'file2.txt', 'file10.txt']);
    expect(sortDriveItems(values, 'last_modified', 'desc').map((value) => value.name)).toEqual(['Folder', 'file2.txt', 'file10.txt']);
  });

  it('maps supported extensions and locks multipart sizing at five MiB', () => {
    expect(previewType('cover.WEBP')).toBe('image');
    expect(previewType('notes.md')).toBe('text');
    expect(previewType('recording.flac')).toBe('audio');
    expect(previewType('archive.zip')).toBe('unknown');
    expect(CHUNK_SIZE).toBe(5 * 1024 * 1024);
    expect(CHUNK_THRESHOLD).toBe(CHUNK_SIZE);
  });
});
