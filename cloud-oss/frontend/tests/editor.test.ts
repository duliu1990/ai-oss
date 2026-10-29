import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { api, ApiClient, ApiError } from '../src/api/client';
import type { DriveItem, FileEntry } from '../src/api/types';
import { CreateFileDialog, createFileNameError } from '../src/components/CreateFileDialog';
import { ConfirmDialog } from '../src/components/Dialogs';
import { EditModal } from '../src/components/EditModal';
import { renderMarkdownSafe } from '../src/markdown';
import editorStyles from '../src/style.css?raw';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const editableItem = (name = 'notes.md'): DriveItem => ({
  kind: 'file',
  key: `docs/${name}`,
  name,
  size: 12,
  lastModified: '2026-01-01T00:00:00Z',
  isDir: false,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let stylesheet: HTMLStyleElement | null = null;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  stylesheet = document.createElement('style');
  stylesheet.textContent = editorStyles;
  document.head.append(stylesheet);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  stylesheet?.remove();
  stylesheet = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(element: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
    await Promise.resolve();
  });
  return container;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  });
}

async function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement | null | undefined) {
  if (!button) throw new Error('Expected button was not rendered');
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function layerIndex(element: Element) {
  // Read declared layer tokens because jsdom does not perform browser stacking/hit testing.
  const rules = Array.from(stylesheet!.sheet!.cssRules).filter((rule): rule is CSSStyleRule => 'selectorText' in rule);
  const zIndex = rules.filter((rule) => element.matches(rule.selectorText) && rule.style.getPropertyValue('z-index'))
    .at(-1)?.style.getPropertyValue('z-index') ?? '';
  expect(zIndex, `Missing layer declaration for ${element.className}`).not.toBe('');
  const variable = /^var\((--[\w-]+)\)$/.exec(zIndex)?.[1];
  const value = variable ? rules.find((rule) => rule.selectorText === ':root')?.style.getPropertyValue(variable) : zIndex;
  expect(Number.isFinite(Number(value)), `Invalid layer declaration: ${zIndex}`).toBe(true);
  return Number(value);
}

async function keydown(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

function mockEditor(client: ApiClient, name = 'notes.md', content = '# Initial') {
  const edit = vi.spyOn(client, 'editFile').mockResolvedValue({
    key: `docs/${name}`,
    content,
    etag: 'etag-1',
    size: content.length,
    content_type: name.endsWith('.md') ? 'text/markdown' : 'text/plain',
  });
  const update = vi.spyOn(client, 'updateFile').mockResolvedValue({
    key: `docs/${name}`,
    etag: 'etag-2',
    size: content.length,
  });
  return { edit, update };
}

describe('CreateFileDialog', () => {
  it('validates names, previews the final filename, and submits normalized data', async () => {
    expect(createFileNameError('')).toBeTruthy();
    expect(createFileNameError('.')).toBeTruthy();
    expect(createFileNameError('../x')).toBeTruthy();
    expect(createFileNameError('bad\u0001name')).toBeTruthy();
    expect(createFileNameError('notes.md')).toContain('后缀');
    expect(createFileNameError('notes.txt')).toContain('后缀');
    expect(createFileNameError('notes')).toBeNull();

    const submit = vi.fn();
    const host = await render(createElement(CreateFileDialog, {
      open: true,
      onClose: vi.fn(),
      onSubmit: submit,
    }));
    const name = host.querySelector<HTMLInputElement>('input');
    const select = host.querySelector<HTMLSelectElement>('select');
    if (!name || !select) throw new Error('Create controls were not rendered');

    await inputValue(name, '  release-notes  ');
    await act(async () => {
      select.value = 'txt';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelector('.filename-preview')?.textContent).toContain('release-notes.txt');
    await click(host.querySelector<HTMLButtonElement>('button[type="submit"]'));
    expect(submit).toHaveBeenCalledWith('release-notes', 'txt');
  });
});

describe('editor API contract', () => {
  it('uses the fixed create/edit URLs and bodies and preserves conflict status/body', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ key: 'docs/a.md', etag: 'one', size: 0 }, 201))
      .mockResolvedValueOnce(json({ key: 'docs/a.md', content: '# A', etag: 'one', size: 3, content_type: 'text/markdown' }))
      .mockResolvedValueOnce(json({ detail: 'conflict', current_etag: 'two' }, 412));
    const client = new ApiClient('', fetcher);

    await client.createFile({ prefix: 'docs/', name: 'a', extension: 'md' });
    await client.editFile('docs/a.md');
    await expect(client.updateFile({ key: 'docs/a.md', content: '# B', expected_etag: 'one' }))
      .rejects.toMatchObject({ status: 412, body: { current_etag: 'two' } });

    expect(fetcher.mock.calls[0][0]).toBe('/api/files/create');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ prefix: 'docs/', name: 'a', extension: 'md' }) });
    expect(new URL(String(fetcher.mock.calls[1][0]), 'https://drive.test').searchParams.get('key')).toBe('docs/a.md');
    expect(fetcher.mock.calls[2][0]).toBe('/api/files/edit');
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ key: 'docs/a.md', content: '# B', expected_etag: 'one' }) });
  });
});

describe('editor dispatch', () => {
  it('opens md/txt in the editor while other text extensions remain read-only previews', async () => {
    const files: FileEntry[] = ['notes.md', 'plain.txt', 'data.json'].map((name) => ({
      key: `docs/${name}`,
      name,
      size: 10,
      last_modified: '2026-01-01T00:00:00Z',
      is_dir: false,
    }));
    vi.spyOn(api, 'config').mockResolvedValue({ bucket: 'bucket', prefix: '', port: 8700 });
    vi.spyOn(api, 'files').mockResolvedValue({ files, folders: [], next_marker: null, truncated: false });
    vi.spyOn(api, 'editFile').mockImplementation(async (key) => ({ key, content: 'editable', etag: 'one', size: 8, content_type: 'text/plain' }));
    vi.spyOn(api, 'text').mockResolvedValue('{"readOnly":true}');
    const host = await render(createElement(App));
    await settle();

    await click(host.querySelector<HTMLButtonElement>('button[aria-label="编辑文件 notes.md"]'));
    await settle();
    expect(host.querySelector('.edit-modal')).not.toBeNull();
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="关闭编辑器"]'));

    await click(host.querySelector<HTMLButtonElement>('button[aria-label="编辑文件 plain.txt"]'));
    await settle();
    expect(host.querySelector('.edit-modal')).not.toBeNull();
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="关闭编辑器"]'));

    await click(host.querySelector<HTMLButtonElement>('button[aria-label="预览文件 data.json"]'));
    await settle();
    expect(host.querySelector('.preview-modal')).not.toBeNull();
    expect(host.querySelector('.text-preview')?.textContent).toContain('readOnly');
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="编辑 notes.md"]')).not.toBeNull();
  });
});

describe('EditModal state and recovery', () => {
  it('opens only Markdown full editors in a new isolated tab with encoded file data', async () => {
    const client = new ApiClient('');
    const name = 'road map #&?.md';
    mockEditor(client, name);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const host = await render(createElement(EditModal, {
      client,
      item: editableItem(name),
      onClose: vi.fn(),
      onMissing: vi.fn(),
    }));
    await settle();

    const fullPreview = host.querySelector<HTMLButtonElement>('.markdown-full-preview');
    expect(fullPreview?.textContent).toContain('全屏编辑');
    expect(fullPreview?.title).toBe('全屏编辑');
    await click(fullPreview);
    expect(open).toHaveBeenCalledWith(
      '/?markdown-preview=1&key=docs%2Froad+map+%23%26%3F.md&name=road+map+%23%26%3F.md',
      '_blank',
      'noopener,noreferrer',
    );

    act(() => root?.unmount());
    root = createRoot(container!);
    const textClient = new ApiClient('');
    mockEditor(textClient, 'plain.txt');
    await act(async () => {
      root?.render(createElement(EditModal, {
        client: textClient,
        item: editableItem('plain.txt'),
        onClose: vi.fn(),
        onMissing: vi.fn(),
      }));
      await Promise.resolve();
    });
    await settle();
    expect(host.querySelector('.markdown-full-preview')).toBeNull();
  });

  it('loads, becomes dirty, saves with Cmd/Ctrl+S, and confirms dirty close', async () => {
    const client = new ApiClient('');
    const { update } = mockEditor(client);
    const onClose = vi.fn();
    const host = await render(createElement(EditModal, {
      client,
      item: editableItem(),
      onClose,
      onMissing: vi.fn(),
    }));
    await settle();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('Editor textarea was not rendered');
    expect(textarea.value).toBe('# Initial');
    expect(host.querySelector('.status-saved')?.textContent).toContain('已保存');

    await inputValue(textarea, '# Changed');
    expect(host.querySelector('.status-dirty')?.textContent).toContain('未保存');
    const shortcut = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
    await act(async () => { globalThis.dispatchEvent(shortcut); await Promise.resolve(); });
    expect(shortcut.defaultPrevented).toBe(true);
    expect(update).toHaveBeenCalledWith({ key: 'docs/notes.md', content: '# Changed', expected_etag: 'etag-1' });
    expect(host.querySelector('.status-saved')?.textContent).toContain('已保存');

    await inputValue(textarea, '# Unsaved');
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="关闭编辑器"]'));
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain('放弃未保存的更改');
  });

  it('keeps local content after 412 and network errors, supports force confirmation and retry', async () => {
    const client = new ApiClient('');
    mockEditor(client);
    const update = vi.spyOn(client, 'updateFile')
      .mockRejectedValueOnce(new ApiError('conflict', 412, { detail: 'conflict', current_etag: 'remote-2' }))
      .mockResolvedValueOnce({ key: 'docs/notes.md', etag: 'forced', size: 7 })
      .mockRejectedValueOnce(new ApiError('offline'))
      .mockResolvedValueOnce({ key: 'docs/notes.md', etag: 'retry', size: 8 });
    const host = await render(createElement(EditModal, {
      client,
      item: editableItem(),
      onClose: vi.fn(),
      onMissing: vi.fn(),
    }));
    await settle();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('Editor textarea was not rendered');
    await inputValue(textarea, '# Local');
    await click(host.querySelector<HTMLButtonElement>('.editor-save'));
    expect(textarea.value).toBe('# Local');
    expect(host.textContent).toContain('文件已在其他位置更新');

    await click(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '强制覆盖'));
    expect(host.textContent).toContain('再次确认强制覆盖');
    await click(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '确认强制覆盖'));
    await settle();
    expect(update).toHaveBeenNthCalledWith(2, expect.objectContaining({ force: true, content: '# Local' }));

    await inputValue(textarea, '# Offline');
    await click(host.querySelector<HTMLButtonElement>('.editor-save'));
    expect(textarea.value).toBe('# Offline');
    expect(host.querySelector('.status-error')?.textContent).toContain('offline');
    await click(host.querySelector<HTMLButtonElement>('.editor-save'));
    await settle();
    expect(update).toHaveBeenCalledTimes(4);
    expect(host.querySelector('.status-saved')).not.toBeNull();
  });

  it.each(['notes.md', 'plain.txt'])('puts force:true from the top confirmation into the PUT body for %s', async (name) => {
    const item = editableItem(name);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ key: item.key, content: 'Initial', etag: 'one', size: 7, content_type: 'text/plain' }))
      .mockResolvedValueOnce(json({ detail: 'conflict', current_etag: 'two' }, 412))
      .mockResolvedValueOnce(json({ key: item.key, etag: 'forced', size: 10 }));
    const onClose = vi.fn();
    const host = await render(createElement(EditModal, { client: new ApiClient('', fetcher), item, onClose, onMissing: vi.fn() }));
    await settle();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await inputValue(textarea, 'Local copy');
    await click(host.querySelector<HTMLButtonElement>('.editor-save'));
    await click(host.querySelector<HTMLButtonElement>('.conflict-actions .danger-button'));

    const editor = host.querySelector<HTMLElement>('.editor-backdrop')!;
    const conflict = host.querySelector<HTMLElement>('.conflict-backdrop')!;
    const confirm = host.querySelector<HTMLElement>('.modal-backdrop--confirm')!;
    expect(confirm).not.toBeNull();
    expect(confirm.previousElementSibling).toBe(conflict);
    expect(layerIndex(confirm)).toBeGreaterThan(layerIndex(conflict));
    expect(layerIndex(conflict)).toBeGreaterThan(layerIndex(editor));
    expect(getComputedStyle(confirm).pointerEvents).toBe('auto');
    expect(getComputedStyle(confirm.querySelector('.dialog')!).pointerEvents).toBe('auto');
    expect(getComputedStyle(editor).pointerEvents).toBe('none');
    expect(getComputedStyle(conflict).pointerEvents).toBe('none');
    expect(editor.hasAttribute('inert')).toBe(true);
    expect(conflict.hasAttribute('inert')).toBe(true);
    expect(conflict.getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(host.querySelectorAll('.modal-backdrop')).filter((layer) => !layer.hasAttribute('inert'))).toEqual([confirm]);

    const [cancel, approve] = Array.from(confirm.querySelectorAll<HTMLButtonElement>('button'));
    expect(document.activeElement).toBe(cancel);
    expect((await keydown('Tab', { shiftKey: true })).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(approve);
    expect((await keydown('Tab')).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
    expect((await keydown('s', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => confirm.querySelector('.dialog')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(host.querySelector('.modal-backdrop--confirm')).toBe(confirm);
    await click(approve);
    await settle();
    expect(fetcher.mock.calls[2][0]).toBe('/api/files/edit');
    expect(fetcher.mock.calls[2][1]?.method).toBe('PUT');
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      key: item.key, content: 'Local copy', expected_etag: 'one', force: true,
    });
    expect(host.querySelector('.conflict-dialog')).toBeNull();
    expect(host.querySelector('.modal-backdrop--confirm')).toBeNull();
    expect(textarea.value).toBe('Local copy');
    expect(host.querySelector('.status-saved')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(['button', 'Escape', 'backdrop'])('returns to the conflict without saving after cancelling via %s', async (method) => {
    const client = new ApiClient('');
    const { update } = mockEditor(client);
    update.mockRejectedValue(new ApiError('conflict', 412, { current_etag: 'remote' }));
    const onClose = vi.fn();
    const host = await render(createElement(EditModal, { client, item: editableItem(), onClose, onMissing: vi.fn() }));
    await settle();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await inputValue(textarea, '# Keep local');
    await click(host.querySelector<HTMLButtonElement>('.editor-save'));
    const conflict = host.querySelector<HTMLElement>('.conflict-backdrop')!;
    await click(conflict.querySelector<HTMLButtonElement>('.danger-button'));
    const confirm = host.querySelector<HTMLElement>('.modal-backdrop--confirm')!;

    if (method === 'button') await click(confirm.querySelector<HTMLButtonElement>('button'));
    else if (method === 'Escape') expect((await keydown('Escape')).defaultPrevented).toBe(true);
    else await act(async () => confirm.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));

    expect(host.querySelector('.modal-backdrop--confirm')).toBeNull();
    expect(host.querySelector('.conflict-backdrop')).toBe(conflict);
    expect(conflict.hasAttribute('inert')).toBe(false);
    expect(conflict.hasAttribute('aria-hidden')).toBe(false);
    expect(getComputedStyle(conflict).pointerEvents).not.toBe('none');
    expect(conflict.contains(document.activeElement)).toBe(true);
    expect(textarea.value).toBe('# Keep local');
    expect(update).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.editor-backdrop')?.hasAttribute('inert')).toBe(true);
    expect((await keydown('Escape')).defaultPrevented).toBe(true);
    expect(host.querySelector('.conflict-backdrop')).toBe(conflict);
    expect((await keydown('s', { metaKey: true })).defaultPrevented).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => host.querySelector('.editor-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(host.querySelector('.modal-backdrop--confirm')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps only the confirmation interactive if a pending save returns 412 during dirty-close confirmation', async () => {
    const client = new ApiClient('');
    const { update } = mockEditor(client);
    let rejectSave!: (error: ApiError) => void;
    update.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject; }));
    const onClose = vi.fn();
    const host = await render(createElement(EditModal, { client, item: editableItem(), onClose, onMissing: vi.fn() }));
    await settle();
    await inputValue(host.querySelector<HTMLTextAreaElement>('textarea')!, '# Pending');
    await click(host.querySelector<HTMLButtonElement>('.editor-save'));
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="关闭编辑器"]'));
    const confirm = host.querySelector<HTMLElement>('.modal-backdrop--confirm')!;
    await act(async () => {
      rejectSave(new ApiError('conflict', 412, { current_etag: 'remote' }));
      await Promise.resolve();
    });
    const conflict = host.querySelector<HTMLElement>('.conflict-backdrop')!;
    expect(conflict.hasAttribute('inert')).toBe(true);
    expect(getComputedStyle(conflict).pointerEvents).toBe('none');
    expect(confirm.contains(document.activeElement)).toBe(true);
    expect(host.querySelectorAll('.modal-backdrop--confirm')).toHaveLength(1);
    await keydown('Escape');
    expect(host.querySelector('.modal-backdrop--confirm')).toBeNull();
    expect(conflict.hasAttribute('inert')).toBe(false);
    expect(conflict.contains(document.activeElement)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('does not cancel a busy nested confirmation with backdrop clicks or Escape', async () => {
    const onClose = vi.fn();
    const host = await render(createElement(ConfirmDialog, {
      busy: true, layer: 'confirm', open: true, title: 'Busy', message: 'Saving', onClose, onConfirm: vi.fn(),
    }));
    const confirm = host.querySelector<HTMLElement>('.modal-backdrop--confirm')!;
    expect(document.activeElement).toBe(confirm.querySelector('.dialog'));
    expect((await keydown('Escape')).defaultPrevented).toBe(true);
    await act(async () => confirm.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps default confirmations at the unchanged global modal layer', async () => {
    const host = await render(createElement(ConfirmDialog, {
      open: true, title: 'Delete', message: 'Delete file', onClose: vi.fn(), onConfirm: vi.fn(),
    }));
    expect(host.querySelector('.modal-backdrop--confirm')).toBeNull();
    expect(layerIndex(host.querySelector('.modal-backdrop')!)).toBe(100);
  });

  it('reloads after conflict and closes through the missing-file callback on 404', async () => {
    const client = new ApiClient('');
    const edit = vi.spyOn(client, 'editFile')
      .mockResolvedValueOnce({ key: 'docs/notes.md', content: 'local base', etag: 'one', size: 10, content_type: 'text/markdown' })
      .mockResolvedValueOnce({ key: 'docs/notes.md', content: 'remote copy', etag: 'two', size: 11, content_type: 'text/markdown' });
    vi.spyOn(client, 'updateFile').mockRejectedValue(new ApiError('conflict', 412, { current_etag: 'two' }));
    const host = await render(createElement(EditModal, {
      client,
      item: editableItem(),
      onClose: vi.fn(),
      onMissing: vi.fn(),
    }));
    await settle();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('Editor textarea was not rendered');
    await inputValue(textarea, 'my local copy');
    await click(host.querySelector<HTMLButtonElement>('.editor-save'));
    await click(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '重新加载'));
    await settle();
    expect(edit).toHaveBeenCalledTimes(2);
    expect(textarea.value).toBe('remote copy');

    act(() => root?.unmount());
    root = null;
    const missingClient = new ApiClient('');
    vi.spyOn(missingClient, 'editFile').mockRejectedValue(new ApiError('gone', 404));
    const onMissing = vi.fn();
    root = createRoot(container!);
    await act(async () => {
      root?.render(createElement(EditModal, { client: missingClient, item: editableItem('gone.txt'), onClose: vi.fn(), onMissing }));
      await Promise.resolve();
    });
    await settle();
    expect(onMissing).toHaveBeenCalledOnce();
  });

  it('traps focus, makes the application background inert, and restores the opener', async () => {
    const files: FileEntry[] = ['notes.md', 'second.md'].map((name) => ({
      key: `docs/${name}`, name, size: 10, last_modified: '2026-01-01T00:00:00Z', is_dir: false,
    }));
    vi.spyOn(api, 'config').mockResolvedValue({ bucket: 'bucket', prefix: '', port: 8700 });
    vi.spyOn(api, 'files').mockResolvedValue({ files, folders: [], next_marker: null, truncated: false });
    let resolveEdit!: () => void;
    const edit = vi.spyOn(api, 'editFile').mockImplementation((key) => new Promise((resolve) => {
      resolveEdit = () => resolve({
        key, content: 'First', etag: 'one', size: 5, content_type: 'text/markdown',
      });
    }));
    const host = await render(createElement(App));
    await settle();
    const opener = host.querySelector<HTMLButtonElement>('button[aria-label="编辑文件 notes.md"]')!;
    opener.focus();
    await click(opener);

    const shell = host.querySelector<HTMLElement>('.app-shell')!;
    const closeButton = host.querySelector<HTMLButtonElement>('button[aria-label="关闭编辑器"]')!;
    expect(shell.hasAttribute('inert')).toBe(true);
    expect(shell.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(closeButton);
    await act(async () => { resolveEdit(); await Promise.resolve(); });
    await settle();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(document.activeElement).toBe(textarea);
    expect((await keydown('Tab')).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeButton);
    expect((await keydown('Tab', { shiftKey: true })).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea);

    const blocked = host.querySelector<HTMLButtonElement>('button[aria-label="编辑文件 second.md"]')!;
    blocked.focus();
    expect(document.activeElement).toBe(textarea);
    await keydown('Enter');
    expect(edit).toHaveBeenCalledTimes(1);

    await click(closeButton);
    await settle();
    expect(host.querySelector('.edit-modal')).toBeNull();
    expect(shell.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('guards a programmatic file switch and keeps the dirty buffer when cancelled', async () => {
    const files: FileEntry[] = ['notes.md', 'second.md'].map((name) => ({
      key: `docs/${name}`, name, size: 10, last_modified: '2026-01-01T00:00:00Z', is_dir: false,
    }));
    vi.spyOn(api, 'config').mockResolvedValue({ bucket: 'bucket', prefix: '', port: 8700 });
    vi.spyOn(api, 'files').mockResolvedValue({ files, folders: [], next_marker: null, truncated: false });
    const edit = vi.spyOn(api, 'editFile').mockImplementation(async (key) => ({
      key, content: key.includes('second') ? 'Second' : 'First', etag: 'one', size: 5, content_type: 'text/markdown',
    }));
    const host = await render(createElement(App));
    await settle();
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="编辑文件 notes.md"]'));
    await settle();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await inputValue(textarea, 'Unsaved buffer');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="编辑文件 second.md"]')!.click();
      await Promise.resolve();
    });
    await settle();
    const switchConfirm = host.querySelector<HTMLElement>('.modal-backdrop--confirm')!;
    expect(switchConfirm.textContent).toContain('离开当前文件');
    expect(edit).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('Unsaved buffer');
    await click(switchConfirm.querySelector<HTMLButtonElement>('button'));
    expect(host.querySelector('.modal-backdrop--confirm')).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>('textarea')).toBe(textarea);
    expect(textarea.value).toBe('Unsaved buffer');
  });

  it('keeps a save-time 404 buffer in the App DOM and offers copy plus confirmed close recovery', async () => {
    const file: FileEntry = {
      key: 'docs/notes.md', name: 'notes.md', size: 12, last_modified: '2026-01-01T00:00:00Z', is_dir: false,
    };
    vi.spyOn(api, 'config').mockResolvedValue({ bucket: 'bucket', prefix: '', port: 8700 });
    vi.spyOn(api, 'files').mockResolvedValue({ files: [file], folders: [], next_marker: null, truncated: false });
    vi.spyOn(api, 'editFile').mockResolvedValue({
      key: file.key, content: '# Initial', etag: 'etag-1', size: 9, content_type: 'text/markdown',
    });
    vi.spyOn(api, 'updateFile').mockRejectedValue(new ApiError('gone', 404, { detail: 'Object not found.' }));
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const host = await render(createElement(App));
    await settle();
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="编辑文件 notes.md"]'));
    await settle();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await inputValue(textarea, 'Recover this local buffer');
    await click(host.querySelector<HTMLButtonElement>('.editor-save'));
    await settle();

    expect(textarea.value).toBe('Recover this local buffer');
    expect(host.querySelector('.missing-dialog')?.textContent).toContain('文件已不存在');
    expect(host.querySelector('.edit-modal')?.getAttribute('data-save-state')).toBe('missing');
    expect(host.querySelector('.edit-modal')?.getAttribute('data-dirty')).toBe('true');
    expect(textarea.dataset.saveState).toBe('missing');
    expect(host.querySelector('.file-item')?.textContent).toContain('notes.md');
    const copyButton = Array.from(host.querySelectorAll<HTMLButtonElement>('.missing-actions button'))
      .find((button) => button.textContent === '复制内容');
    await click(copyButton);
    expect(writeText).toHaveBeenCalledWith('Recover this local buffer');
    expect(host.textContent).toContain('内容已复制');
    await click(copyButton);
    expect(host.textContent).toContain('复制失败');

    const recoveryClose = Array.from(host.querySelectorAll<HTMLButtonElement>('.missing-actions button'))
      .find((button) => button.textContent === '关闭编辑器');
    await click(recoveryClose);
    expect(host.textContent).toContain('关闭编辑器并放弃本地内容');
    const confirm = host.querySelector<HTMLElement>('.modal-backdrop--confirm')!;
    await click(confirm.querySelector<HTMLButtonElement>('button'));
    expect(host.querySelector('.edit-modal')).not.toBeNull();
    expect(textarea.value).toBe('Recover this local buffer');
    await click(recoveryClose);
    await click(host.querySelector<HTMLButtonElement>('.modal-backdrop--confirm .danger-button'));
    expect(host.querySelector('.edit-modal')).toBeNull();
  });

  it('single-flights saves and keeps edits made during the request dirty', async () => {
    const client = new ApiClient('');
    const { update } = mockEditor(client, 'notes.md', 'Initial');
    let resolveSave!: (value: { key: string; etag: string; size: number }) => void;
    update
      .mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve; }))
      .mockResolvedValueOnce({ key: 'docs/notes.md', etag: 'etag-3', size: 14 });
    const host = await render(createElement(EditModal, {
      client, item: editableItem(), onClose: vi.fn(), onMissing: vi.fn(),
    }));
    await settle();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await inputValue(textarea, 'First snapshot');
    const firstShortcut = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
    const repeatedShortcut = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      globalThis.dispatchEvent(firstShortcut);
      globalThis.dispatchEvent(repeatedShortcut);
      await Promise.resolve();
    });
    expect(firstShortcut.defaultPrevented).toBe(true);
    expect(repeatedShortcut.defaultPrevented).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.status-saving')).not.toBeNull();
    expect(host.querySelector('.edit-modal')?.getAttribute('data-save-state')).toBe('saving');
    expect(host.querySelector('.edit-modal')?.getAttribute('data-saving')).toBe('true');
    expect(host.querySelector<HTMLButtonElement>('.editor-save')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector<HTMLButtonElement>('.editor-save')?.disabled).toBe(true);
    expect(textarea.disabled).toBe(false);

    await inputValue(textarea, 'Changed while saving');
    await act(async () => {
      resolveSave({ key: 'docs/notes.md', etag: 'etag-2', size: 14 });
      await Promise.resolve();
    });
    await settle();
    expect(textarea.value).toBe('Changed while saving');
    expect(host.querySelector('.status-dirty')?.textContent).toContain('未保存');
    expect(host.querySelector<HTMLButtonElement>('.editor-save')?.disabled).toBe(false);

    await click(host.querySelector<HTMLButtonElement>('.editor-save'));
    await settle();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith({
      key: 'docs/notes.md', content: 'Changed while saving', expected_etag: 'etag-2',
    });
    expect(host.querySelector('.status-saved')).not.toBeNull();
    expect(host.querySelector('.edit-modal')?.getAttribute('data-save-state')).toBe('saved');
    expect(host.querySelector('.edit-modal')?.getAttribute('data-saving')).toBe('false');
  });

  it('updates directory metadata and preserves it across a stale background refresh', async () => {
    const file: FileEntry = {
      key: 'docs/notes.md', name: 'notes.md', size: 7, last_modified: '2026-01-01T00:00:00Z', is_dir: false,
    };
    vi.spyOn(api, 'config').mockResolvedValue({ bucket: 'bucket', prefix: '', port: 8700 });
    let resolveRefresh!: (value: { files: FileEntry[]; folders: []; next_marker: null; truncated: false }) => void;
    const files = vi.spyOn(api, 'files')
      .mockResolvedValueOnce({ files: [file], folders: [], next_marker: null, truncated: false })
      .mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
    vi.spyOn(api, 'editFile').mockResolvedValue({
      key: file.key, content: 'Initial', etag: 'one', size: 7, content_type: 'text/markdown',
    });
    vi.spyOn(api, 'updateFile').mockResolvedValue({ key: file.key, etag: 'two', size: 15 });
    const host = await render(createElement(App));
    await settle();
    const opener = host.querySelector<HTMLButtonElement>('button[aria-label="编辑文件 notes.md"]')!;
    opener.focus();
    await click(opener);
    await settle();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await inputValue(textarea, 'Updated content');
    await click(host.querySelector<HTMLButtonElement>('.editor-save'));
    await settle();

    expect(files).toHaveBeenCalledTimes(2);
    expect(opener.closest('.file-item')?.textContent).toContain('15 B');
    expect(opener.isConnected).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Updated content');
    expect(host.querySelector('.status-saved')).not.toBeNull();
    await act(async () => {
      resolveRefresh({ files: [file], folders: [], next_marker: null, truncated: false });
      await Promise.resolve();
    });
    await settle();
    expect(opener.closest('.file-item')?.textContent).toContain('15 B');
    expect(opener.isConnected).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Updated content');
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="关闭编辑器"]'));
    await settle();
    expect(document.activeElement).toBe(opener);
  });

  it('uses explicit type classes for three-row TXT and four-row Markdown mobile layouts', async () => {
    const client = new ApiClient('');
    mockEditor(client, 'plain.txt', 'Plain');
    const host = await render(createElement(EditModal, {
      client,
      item: editableItem('plain.txt'),
      onClose: vi.fn(),
      onMissing: vi.fn(),
    }));
    await settle();
    const modal = host.querySelector<HTMLElement>('.edit-modal--text')!;
    expect(modal).not.toBeNull();
    expect(Array.from(modal.children).map((child) => child.className)).toEqual([
      'edit-head', 'editor-stage text-editor', 'edit-footer',
    ]);
    expect(modal.querySelector('.editor-tabs')).toBeNull();
    expect(editorStyles).toMatch(/\.edit-modal--text\s*\{[^}]*grid-template-rows:\s*64px minmax\(0, 1fr\) 38px/);
    expect(editorStyles).toMatch(/\.edit-modal--markdown\s*\{[^}]*grid-template-rows:\s*64px 42px minmax\(0, 1fr\) 38px/);
  });

  it('switches Markdown mobile tabs', async () => {
    const client = new ApiClient('');
    mockEditor(client);
    const host = await render(createElement(EditModal, {
      client,
      item: editableItem(),
      onClose: vi.fn(),
      onMissing: vi.fn(),
    }));
    await settle();
    const modal = host.querySelector<HTMLElement>('.edit-modal--markdown')!;
    expect(Array.from(modal.children).map((child) => child.className)).toEqual([
      'edit-head', 'editor-tabs', 'editor-stage markdown-editor', 'edit-footer',
    ]);
    const tabs = host.querySelectorAll<HTMLButtonElement>('.editor-tabs button');
    expect(tabs[0].classList.contains('active')).toBe(true);
    await click(tabs[1]);
    expect(tabs[1].classList.contains('active')).toBe(true);
    expect(host.querySelector('.editor-preview-pane')?.classList.contains('active')).toBe(true);
  });
});

describe('safe Markdown rendering', () => {
  it('removes active content and renders normal headings and lists', async () => {
    const html = await renderMarkdownSafe(`
# Safe title

- one
- two

<script>alert(1)</script>
<img src="x" onerror="alert(2)">
<a href="javascript:alert(3)" onclick="alert(4)">unsafe</a>
<a href="https://example.com">safe</a>
`);
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('h1')?.textContent).toBe('Safe title');
    expect(host.querySelectorAll('li')).toHaveLength(2);
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('[onerror], [onclick]')).toBeNull();
    expect(host.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(host.querySelector('a[href="https://example.com"]')).toMatchObject({ target: '_blank', rel: 'noopener noreferrer' });
  });
});
