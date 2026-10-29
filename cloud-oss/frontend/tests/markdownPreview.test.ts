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
      codeBlockLanguages?: Record<string, string>;
      diffMarkdown?: string;
    }>;
    const toolbar = plugins.find((item) => item.kind === 'toolbar');
    const codeMirror = plugins.find((item) => item.kind === 'code-mirror');
    const diffSource = plugins.find((item) => item.kind === 'diff-source');
    return React.createElement('div', {
      className: props.className,
      'data-code-languages': JSON.stringify(codeMirror?.codeBlockLanguages ?? {}),
      'data-diff-markdown': diffSource?.diffMarkdown ?? '',
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

import { ApiClient, ApiError } from '../src/api/client';
import { MarkdownPreviewApp } from '../src/MarkdownPreviewApp';
import { isSafeMarkdownLink, markdownPreviewRequest, rootApplication } from '../src/markdownPreview';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

async function renderEditor(client: ApiClient, search = '?markdown-preview=1&key=docs%2Fguide.md&name=Guide.md') {
  root = createRoot(container!);
  await act(async () => {
    root?.render(createElement(MarkdownPreviewApp, { client, search }));
    await Promise.resolve();
  });
  return container!;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function editContent(host: HTMLElement, markdown: string) {
  const editable = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
  act(() => {
    editable.textContent = markdown;
    editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
}

function clickButton(host: HTMLElement, label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes(label));
  expect(button, `button containing ${label}`).toBeDefined();
  act(() => button?.click());
}

const response = (content: string, etag = 'etag-1') => ({
  key: 'docs/guide.md',
  content,
  content_type: 'text/markdown; charset=utf-8',
  etag,
  size: content.length,
});

const saved = (content: string, etag = 'etag-2') => ({
  key: 'docs/guide.md',
  etag,
  size: content.length,
});

describe('Markdown editor routing and safety helpers', () => {
  it('keeps the compatible Markdown route and validates Markdown keys', () => {
    expect(rootApplication('?markdown-preview=1')).toBe('markdown-preview');
    expect(rootApplication('?office-preview=1&markdown-preview=1')).toBe('office-preview');
    expect(rootApplication('?key=docs%2Fguide.md')).toBe('app');
    expect(markdownPreviewRequest('?key=folder%2Fsafe.MD&name=阅读.md')).toEqual({
      key: 'folder/safe.MD', name: '阅读.md', valid: true,
    });
    expect(markdownPreviewRequest('?key=folder%2Fplain.txt&name=plain.txt').valid).toBe(false);
  });

  it('allows only safe link protocols', () => {
    expect(isSafeMarkdownLink('https://example.com/docs')).toBe(true);
    expect(isSafeMarkdownLink('mailto:hello@example.com')).toBe(true);
    expect(isSafeMarkdownLink('javascript:alert(1)')).toBe(false);
    expect(isSafeMarkdownLink('data:text/html,pwned')).toBe(false);
  });
});

describe('MarkdownPreviewApp editing', () => {
  it('loads unchanged Markdown into an editable surface with the full toolbar and download', async () => {
    const client = new ApiClient('');
    let resolveLoad!: (value: ReturnType<typeof response>) => void;
    vi.spyOn(client, 'editFile').mockReturnValue(new Promise((resolve) => { resolveLoad = resolve; }));
    const host = await renderEditor(client, '?markdown-preview=1&key=docs%2Fguide.md&name=产品指南.md');
    expect(host.textContent).toContain('正在读取 Markdown');
    expect(document.title).toBe('产品指南.md');

    const markdown = '# Release title\n\n<script>alert(1)</script>\n\nBody';
    await act(async () => {
      resolveLoad(response(markdown));
      await Promise.resolve();
    });
    await settle();

    expect(host.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(host.querySelector('[contenteditable="true"]')?.textContent).toBe(markdown);
    const mdxEditor = host.querySelector<HTMLElement>('.markdown-mdx-editor')!;
    expect(mdxEditor.classList).toContain('mdxeditor-full-height');
    expect(mdxEditor.dataset.diffMarkdown).toBe(markdown);
    expect(JSON.parse(mdxEditor.dataset.codeLanguages ?? '{}')).toMatchObject({
      '': 'Plain text',
      md: 'Markdown',
      tsx: 'TypeScript (React)',
    });
    expect(host.querySelector('script')).toBeNull();
    for (const label of [
      'Undo redo',
      'Bold italic underline',
      'Inline code',
      'Highlight',
      'Strikethrough superscript subscript',
      'Lists',
      'Block type',
      'Create link',
      'Insert image',
      'Insert table',
      'Insert thematic break',
      'Insert code block',
      'Insert frontmatter',
      'Rich text',
      'Diff mode',
      'Source mode',
    ]) {
      expect(host.textContent).toContain(label);
    }
    expect(host.querySelectorAll('[role="separator"]')).toHaveLength(8);
    const download = host.querySelector<HTMLAnchorElement>('.markdown-preview-download')!;
    expect(download.getAttribute('href')).toBe('/api/files/download?key=docs%2Fguide.md&download=true');
    expect(download.download).toBe('产品指南.md');
  });

  it('marks edits dirty and clears dirty state after a successful save', async () => {
    const client = new ApiClient('');
    vi.spyOn(client, 'editFile').mockResolvedValue(response('# Original'));
    const update = vi.spyOn(client, 'updateFile').mockResolvedValue(saved('# Changed'));
    const host = await renderEditor(client);
    await settle();

    editContent(host, '# Changed');
    expect(host.textContent).toContain('有修改');
    clickButton(host, '保存修改');
    await settle();

    expect(update).toHaveBeenCalledWith({ key: 'docs/guide.md', content: '# Changed', expected_etag: 'etag-1' });
    expect(host.textContent).toContain('已保存');
    expect(host.querySelector<HTMLElement>('.markdown-mdx-editor')?.dataset.diffMarkdown).toBe('# Changed');
    expect(host.querySelector<HTMLButtonElement>('.markdown-preview-save')?.disabled).toBe(true);
  });

  it('saves the current editor Markdown with Cmd/Ctrl+S', async () => {
    const client = new ApiClient('');
    vi.spyOn(client, 'editFile').mockResolvedValue(response('# Original'));
    const update = vi.spyOn(client, 'updateFile').mockResolvedValue(saved('# Shortcut'));
    const host = await renderEditor(client);
    await settle();
    editContent(host, '# Shortcut');

    act(() => globalThis.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 's', metaKey: true })));
    await settle();
    expect(update).toHaveBeenCalledWith({ key: 'docs/guide.md', content: '# Shortcut', expected_etag: 'etag-1' });
  });

  it('shows a conflict and can force-save the preserved local content', async () => {
    const client = new ApiClient('');
    vi.spyOn(client, 'editFile').mockResolvedValue(response('# Original'));
    const update = vi.spyOn(client, 'updateFile')
      .mockRejectedValueOnce(new ApiError('conflict', 412, { current_etag: 'etag-remote' }))
      .mockResolvedValueOnce(saved('# Local', 'etag-3'));
    const host = await renderEditor(client);
    await settle();
    editContent(host, '# Local');
    clickButton(host, '保存修改');
    await settle();

    expect(host.textContent).toContain('文件已在其他位置更新');
    clickButton(host, '强制保存');
    await settle();
    expect(update).toHaveBeenLastCalledWith({
      key: 'docs/guide.md', content: '# Local', expected_etag: 'etag-1', force: true,
    });
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('reloads the remote version after a conflict and updates the editor', async () => {
    const client = new ApiClient('');
    vi.spyOn(client, 'editFile')
      .mockResolvedValueOnce(response('# Original'))
      .mockResolvedValueOnce(response('# Remote', 'etag-remote'));
    vi.spyOn(client, 'updateFile').mockRejectedValue(new ApiError('conflict', 412, { current_etag: 'etag-remote' }));
    const host = await renderEditor(client);
    await settle();
    editContent(host, '# Local');
    clickButton(host, '保存修改');
    await settle();
    clickButton(host, '重新加载');
    await settle();

    expect(host.querySelector('[contenteditable="true"]')?.textContent).toBe('# Remote');
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.textContent).toContain('已保存');
  });

  it('shows deleted-file recovery and copies the local content after a save 404', async () => {
    const client = new ApiClient('');
    vi.spyOn(client, 'editFile').mockResolvedValue(response('# Original'));
    vi.spyOn(client, 'updateFile').mockRejectedValue(new ApiError('missing', 404));
    const host = await renderEditor(client);
    await settle();
    editContent(host, '# Recover me');
    clickButton(host, '保存修改');
    await settle();

    expect(host.textContent).toContain('文件已被删除');
    clickButton(host, '复制内容');
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('# Recover me');
    expect(host.textContent).toContain('内容已复制');
  });

  it('protects dirty work with beforeunload and removes protection after saving', async () => {
    const client = new ApiClient('');
    vi.spyOn(client, 'editFile').mockResolvedValue(response('# Original'));
    vi.spyOn(client, 'updateFile').mockResolvedValue(saved('# Changed'));
    const host = await renderEditor(client);
    await settle();
    editContent(host, '# Changed');
    await settle();

    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    globalThis.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
    clickButton(host, '保存修改');
    await settle();
    const savedEvent = new Event('beforeunload', { cancelable: true });
    globalThis.dispatchEvent(savedEvent);
    expect(savedEvent.defaultPrevented).toBe(false);
  });

  it('renders invalid-route and load-error states', async () => {
    const invalidClient = new ApiClient('');
    const invalid = await renderEditor(invalidClient, '?markdown-preview=1&key=docs%2Fguide.txt&name=guide.txt');
    expect(invalid.textContent).toContain('仅支持 .md 文件全屏编辑');
    act(() => root?.unmount());
    root = null;
    container!.replaceChildren();

    const failingClient = new ApiClient('');
    vi.spyOn(failingClient, 'editFile').mockRejectedValue(new ApiError('无法连接文件服务，请检查网络和服务状态。'));
    const failed = await renderEditor(failingClient);
    await settle();
    expect(failed.querySelector('.markdown-preview-error')?.textContent).toContain('无法连接文件服务');
  });

  it('aborts and ignores a pending load after unmount', async () => {
    const client = new ApiClient('');
    let signal: AbortSignal | undefined;
    let resolveLoad!: (value: ReturnType<typeof response>) => void;
    vi.spyOn(client, 'editFile').mockImplementation((_key, requestSignal) => {
      signal = requestSignal;
      return new Promise((resolve) => { resolveLoad = resolve; });
    });
    await renderEditor(client);
    act(() => root?.unmount());
    root = null;
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolveLoad(response('# Late result'));
      await Promise.resolve();
    });
    expect(container?.textContent).toBe('');
  });
});
