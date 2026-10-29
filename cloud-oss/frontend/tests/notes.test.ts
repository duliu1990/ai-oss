import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mdxeditor/editor', async () => {
  const React = await import('react');
  const button = (label: string) => () => React.createElement('button', { type: 'button' }, label);
  const plugin = () => ({});
  const codeMirrorPlugin = (options: { codeBlockLanguages: Record<string, string> }) => ({
    kind: 'code-mirror',
    ...options,
  });
  const diffSourcePlugin = (options: { viewMode?: string; diffMarkdown?: string } = {}) => ({
    kind: 'diff-source',
    ...options,
  });
  const ConditionalContents = ({ options }: {
    options: Array<{ fallback?: () => React.ReactNode }>;
  }) => React.createElement(React.Fragment, null, options.find((option) => option.fallback)?.fallback?.());
  const DiffSourceToggleWrapper = ({ children }: { children: React.ReactNode }) => React.createElement(
    React.Fragment,
    null,
    children,
    button('Rich text')(),
    button('Diff mode')(),
    button('Source mode')(),
  );
  const toolbarPlugin = (options: { toolbarContents: () => React.ReactNode }) => ({
    kind: 'toolbar',
    toolbarContents: options.toolbarContents,
  });
  const MDXEditor = React.forwardRef((props: Record<string, unknown>, ref) => {
    const [value, setValue] = React.useState(String(props.markdown ?? ''));
    const valueRef = React.useRef(value);
    valueRef.current = value;
    React.useImperativeHandle(ref, () => ({
      getMarkdown: () => valueRef.current,
      setMarkdown: (markdown: string) => {
        valueRef.current = markdown;
        setValue(markdown);
      },
      insertMarkdown: () => undefined,
      focus: () => undefined,
    }));
    const plugins = props.plugins as Array<{
      kind?: string;
      toolbarContents?: () => React.ReactNode;
    }>;
    const toolbar = plugins.find((item) => item.kind === 'toolbar');
    return React.createElement('div', {
      className: props.className,
    },
      React.createElement('div', { role: 'toolbar' }, toolbar?.toolbarContents?.()),
      React.createElement('div', {
        className: props.contentEditableClassName,
        contentEditable: true,
        onInput: (event: React.FormEvent<HTMLDivElement>) => {
          const markdown = event.currentTarget.textContent ?? '';
          valueRef.current = markdown;
          setValue(markdown);
          (props.onChange as ((next: string) => void) | undefined)?.(markdown);
        },
        suppressContentEditableWarning: true,
      }, value),
    );
  });
  return {
    BlockTypeSelect: button('Block type'),
    BoldItalicUnderlineToggles: button('Bold italic underline'),
    ChangeCodeMirrorLanguage: button('Change code language'),
    CodeToggle: button('Inline code'),
    ConditionalContents,
    CreateLink: button('Create link'),
    DiffSourceToggleWrapper,
    HighlightToggle: button('Highlight'),
    InsertCodeBlock: button('Insert code block'),
    InsertFrontmatter: button('Insert frontmatter'),
    InsertImage: button('Insert image'),
    InsertTable: button('Insert table'),
    InsertThematicBreak: button('Insert thematic break'),
    ListsToggle: button('Lists'),
    MDXEditor,
    Separator: () => React.createElement('span', { role: 'separator' }),
    StrikeThroughSupSubToggles: button('Strikethrough superscript subscript'),
    UndoRedo: button('Undo redo'),
    codeBlockPlugin: plugin,
    codeMirrorPlugin,
    diffSourcePlugin,
    frontmatterPlugin: plugin,
    headingsPlugin: plugin,
    imagePlugin: plugin,
    linkDialogPlugin: plugin,
    linkPlugin: plugin,
    listsPlugin: plugin,
    markdownShortcutPlugin: plugin,
    quotePlugin: plugin,
    tablePlugin: plugin,
    thematicBreakPlugin: plugin,
    toolbarPlugin,
  };
});

import { api, ApiClient, ApiError } from '../src/api/client';
import type { NoteEntry } from '../src/api/types';
import { NotesView, formatRelativeTime } from '../src/components/NotesView';
import App from '../src/App';
import editorStyles from '../src/style.css?raw';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

function makeNote(name: string, minutesAgo = 5): NoteEntry {
  const d = new Date(Date.now() - minutesAgo * 60_000);
  return {
    key: `drive-note/${name}`,
    name,
    folder: 'drive-note/',
    size: 100,
    last_modified: d.toISOString(),
  };
}

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
    await Promise.resolve();
  });
}

async function click(button: HTMLButtonElement | null | undefined) {
  if (!button) throw new Error('Expected button was not rendered');
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

describe('formatRelativeTime', () => {
  it('formats times correctly', () => {
    const now = new Date();
    expect(formatRelativeTime(new Date(now.getTime() - 30_000).toISOString())).toBe('刚刚');
    expect(formatRelativeTime(new Date(now.getTime() - 3 * 60_000).toISOString())).toBe('3分钟前');
    expect(formatRelativeTime(new Date(now.getTime() - 2 * 3_600_000).toISOString())).toBe('2小时前');
    expect(formatRelativeTime(new Date(now.getTime() - 3 * 86_400_000).toISOString())).toBe('3天前');
    expect(formatRelativeTime(new Date(now.getTime() - 30 * 86_400_000).toISOString())).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(formatRelativeTime('invalid')).toBe('invalid');
  });
});

describe('notes API client', () => {
  it('calls GET /api/notes and validates the response', async () => {
    const notes: NoteEntry[] = [makeNote('hello.md'), makeNote('second.md')];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ prefix: 'drive-note/', notes }));
    const client = new ApiClient('', fetcher);
    const result = await client.notes();
    expect(result.prefix).toBe('drive-note/');
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0].name).toBe('hello.md');
    expect(String(fetcher.mock.calls[0][0])).toBe('/api/notes');
  });

  it('rejects malformed notes responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ notes: [{ key: 'a' }] }));
    const client = new ApiClient('', fetcher);
    await expect(client.notes()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('NotesView', () => {
  function mockNotesList(client: ApiClient, notes: NoteEntry[] = []) {
    return vi.spyOn(client, 'notes').mockResolvedValue({ prefix: 'drive-note/', notes });
  }

  it('shows loading state then renders notes list', async () => {
    const client = new ApiClient('');
    const notes = [makeNote('first.md'), makeNote('second.md')];
    mockNotesList(client, notes);
    const host = await render(createElement(NotesView, { client }));
    await settle();
    expect(host.querySelector('.notes-list')).not.toBeNull();
    const items = host.querySelectorAll('.notes-list-item');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('.note-name')?.textContent).toBe('first');
    expect(host.querySelector('.note-folder')).toBeNull();
  });

  it('shows empty state when no notes exist', async () => {
    const client = new ApiClient('');
    mockNotesList(client, []);
    const host = await render(createElement(NotesView, { client }));
    await settle();
    expect(host.querySelector('.notes-empty')).not.toBeNull();
    expect(host.textContent).toContain('还没有笔记');
  });

  it('filters notes by search query', async () => {
    const client = new ApiClient('');
    mockNotesList(client, [makeNote('alpha.md'), makeNote('beta.md'), makeNote('gamma.md')]);
    const host = await render(createElement(NotesView, { client }));
    await settle();
    expect(host.querySelectorAll('.notes-list-item')).toHaveLength(3);

    const input = host.querySelector<HTMLInputElement>('.notes-search-input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'alpha');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(host.querySelectorAll('.notes-list-item')).toHaveLength(1);
  });

  it('selects a note and shows the editor', async () => {
    const client = new ApiClient('');
    const notes = [makeNote('hello.md')];
    mockNotesList(client, notes);
    vi.spyOn(client, 'readNote').mockResolvedValue({
      key: 'drive-note/hello.md',
      content: '# Hello',
      etag: 'etag-1',
      size: 7,
      content_type: 'text/markdown',
    });
    const host = await render(createElement(NotesView, { client }));
    await settle();

    await act(async () => { host.querySelector<HTMLElement>('.notes-list-item')!.click(); await Promise.resolve(); });
    await settle();

    expect(host.querySelector('.notes-editor-header')).not.toBeNull();
    expect(host.querySelector('.notes-editor-path')?.textContent).toContain('hello.md');
    expect(host.querySelector('[contenteditable="true"]')?.textContent).toBe('# Hello');
    expect(host.textContent).toContain('已保存');
  });

  it('saves on Cmd+S and refreshes the list', async () => {
    const client = new ApiClient('');
    mockNotesList(client, [makeNote('hello.md')]);
    vi.spyOn(client, 'readNote').mockResolvedValue({
      key: 'drive-note/hello.md',
      content: '# Hello',
      etag: 'etag-1',
      size: 7,
      content_type: 'text/markdown',
    });
    const update = vi.spyOn(client, 'updateNote').mockResolvedValue({
      key: 'drive-note/hello.md',
      etag: 'etag-2',
      size: 12,
    });
    const host = await render(createElement(NotesView, { client }));
    await settle();

    await act(async () => { host.querySelector<HTMLElement>('.notes-list-item')!.click(); await Promise.resolve(); });
    await settle();

    const editable = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    act(() => {
      editable.textContent = '# Updated';
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    });
    await settle();
    expect(host.textContent).toContain('有修改');

    act(() => globalThis.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 's', metaKey: true })));
    await settle();
    expect(update).toHaveBeenCalledWith({
      key: 'drive-note/hello.md',
      content: '# Updated',
      expected_etag: 'etag-1',
    });
  });

  it('opens the create note dialog and creates a new note', async () => {
    const client = new ApiClient('');
    const notesCall = mockNotesList(client, []);
    const createNote = vi.spyOn(client, 'createNote').mockResolvedValue({
      key: 'drive-note/读书笔记.md',
      etag: 'etag-new',
      size: 0,
    });
    const host = await render(createElement(NotesView, { client }));
    await settle();

    await click(host.querySelector<HTMLButtonElement>('.notes-create-btn'));
    expect(host.querySelector('.form-dialog')).not.toBeNull();
    expect(host.querySelector('.form-dialog select')).toBeNull();
    expect(host.textContent).toContain('新建笔记');

    const input = host.querySelector<HTMLInputElement>('.form-dialog input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '读书笔记');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('.filename-preview')?.textContent).toContain('读书笔记.md');

    // Now mock the refresh to return the newly created note
    notesCall.mockResolvedValue({ prefix: 'drive-note/', notes: [makeNote('读书笔记.md')] });
    vi.spyOn(client, 'readNote').mockResolvedValue({
      key: 'drive-note/读书笔记.md',
      content: '',
      etag: 'etag-new',
      size: 0,
      content_type: 'text/markdown',
    });

    await click(host.querySelector<HTMLButtonElement>('.form-dialog button[type="submit"]'));
    await settle();
    expect(createNote).toHaveBeenCalledWith('读书笔记');
  });

  it('shows a delete confirmation and deletes a note', async () => {
    const client = new ApiClient('');
    mockNotesList(client, [makeNote('doomed.md')]);
    const deleteNote = vi.spyOn(client, 'deleteNote').mockResolvedValue({ ok: true as const });
    const host = await render(createElement(NotesView, { client }));
    await settle();

    const deleteBtn = host.querySelector<HTMLButtonElement>('.note-delete-btn')!;
    await click(deleteBtn);
    expect(host.textContent).toContain('确认删除笔记');
    expect(host.textContent).toContain('doomed.md');

    await click(Array.from(host.querySelectorAll<HTMLButtonElement>('.dialog-actions button')).find(
      (button) => button.textContent?.includes('永久删除'),
    ));
    await settle();
    expect(deleteNote).toHaveBeenCalledWith('drive-note/doomed.md');
  });

  it('shows the empty editor state when no note is selected', async () => {
    const client = new ApiClient('');
    mockNotesList(client, [makeNote('note.md')]);
    const host = await render(createElement(NotesView, { client }));
    await settle();
    expect(host.querySelector('.notes-empty-state')).not.toBeNull();
    expect(host.textContent).toContain('选择一个笔记开始编辑');
  });

  it('guards note switching when dirty', async () => {
    const client = new ApiClient('');
    const notes = [makeNote('a.md'), makeNote('b.md')];
    mockNotesList(client, notes);
    vi.spyOn(client, 'readNote').mockImplementation(async (key) => ({
      key,
      content: `Content of ${key}`,
      etag: 'etag-1',
      size: 10,
      content_type: 'text/markdown',
    }));
    const host = await render(createElement(NotesView, { client }));
    await settle();

    // Select first note
    await act(async () => { host.querySelectorAll<HTMLElement>('.notes-list-item')[0].click(); await Promise.resolve(); });
    await settle();

    // Make it dirty
    const editable = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    act(() => {
      editable.textContent = 'Modified!';
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    });
    await settle();

    // Try to switch to second note
    await act(async () => { host.querySelectorAll<HTMLElement>('.notes-list-item')[1].click(); await Promise.resolve(); });
    await settle();
    // Should show confirmation
    expect(host.textContent).toContain('放弃未保存修改');

    // Confirm
    await click(Array.from(host.querySelectorAll<HTMLButtonElement>('.dialog-actions button')).find(
      (button) => button.textContent?.includes('放弃修改'),
    ));
    await settle();
    // Should now show second note
    expect(host.querySelector('.notes-editor-path')?.textContent).toContain('b.md');
  });
});

describe('App view switching', () => {
  it('switches between files and notes sections', async () => {
    vi.spyOn(api, 'config').mockResolvedValue({ bucket: 'bucket', prefix: '', port: 8700 });
    vi.spyOn(api, 'files').mockResolvedValue({ files: [], folders: [], next_marker: null, truncated: false });
    vi.spyOn(api, 'notes').mockResolvedValue({ prefix: 'drive-note/', notes: [] });

    const host = await render(createElement(App));
    await settle();

    // Initially shows files view
    expect(host.querySelector('.workspace')).not.toBeNull();
    const navButtons = host.querySelectorAll<HTMLButtonElement>('.side-nav button');
    expect(navButtons).toHaveLength(2);
    expect(navButtons[0].textContent).toContain('轻盘');
    expect(navButtons[1].textContent).toContain('轻笔记');
    expect(navButtons[0].classList.contains('active')).toBe(true);

    // Switch to notes
    await click(navButtons[1]);
    await settle();
    expect(navButtons[1].classList.contains('active')).toBe(true);
    expect(navButtons[0].classList.contains('active')).toBe(false);
    // Workspace should be gone, notes view eventually loads
    expect(host.querySelector('.workspace')).toBeNull();

    // Switch back
    await click(navButtons[0]);
    await settle();
    expect(host.querySelector('.workspace')).not.toBeNull();
    expect(navButtons[0].classList.contains('active')).toBe(true);
  });
});
