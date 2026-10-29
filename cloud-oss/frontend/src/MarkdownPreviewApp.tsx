import { MDXEditor } from '@mdxeditor/editor';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from './api/client';
import { api } from './api/client';
import { Icon } from './components/Icon';
import { useMdxEditor } from './hooks/useMdxEditor';
import { markdownPreviewRequest } from './markdownPreview';
import { createMdxEditorPlugins } from './mdxEditorPlugins';
import '@mdxeditor/editor/style.css';
import './markdown-preview.css';

interface MarkdownPreviewAppProps {
  client?: ApiClient;
  search?: string;
}

export function MarkdownPreviewApp({ client = api, search = globalThis.location.search }: MarkdownPreviewAppProps) {
  const request = useMemo(() => markdownPreviewRequest(search), [search]);
  const editor = useMdxEditor({ client, enabled: request.valid, key: request.key });
  const editorRef = useRef<MDXEditorMethods>(null);
  const latestMarkdownRef = useRef('');
  const [closeHint, setCloseHint] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const plugins = useMemo(
    () => createMdxEditorPlugins(editor.baselineMarkdown),
    [editor.baselineMarkdown],
  );

  useEffect(() => {
    document.title = request.name;
    setReady(false);
    setRenderError(null);
  }, [request]);

  useEffect(() => {
    if (!editor.loading && !editor.error && request.valid) {
      latestMarkdownRef.current = editor.initialMarkdown;
      setReady(true);
    }
  }, [editor.error, editor.initialMarkdown, editor.loading, request.valid]);

  const handleChange = useCallback((markdown: string) => {
    latestMarkdownRef.current = markdown;
    editor.setCurrentMarkdown(markdown);
  }, [editor.setCurrentMarkdown]);

  const saveCurrent = useCallback(async () => {
    const markdown = editorRef.current?.getMarkdown() ?? latestMarkdownRef.current;
    latestMarkdownRef.current = markdown;
    editor.setCurrentMarkdown(markdown);
    await editor.save(markdown);
  }, [editor.save, editor.setCurrentMarkdown]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (ready && editor.dirty && !editor.saving && !editor.missing && !editor.conflict) {
          void saveCurrent();
        }
      }
    };
    globalThis.addEventListener('keydown', saveShortcut);
    return () => globalThis.removeEventListener('keydown', saveShortcut);
  }, [editor.conflict, editor.dirty, editor.missing, editor.saving, ready, saveCurrent]);

  const reloadFromServer = async () => {
    const markdown = await editor.reloadFromServer();
    if (markdown === null) return;
    latestMarkdownRef.current = markdown;
    editorRef.current?.setMarkdown(markdown);
    setRenderError(null);
  };

  const forceSave = async () => {
    const markdown = editorRef.current?.getMarkdown() ?? latestMarkdownRef.current;
    latestMarkdownRef.current = markdown;
    await editor.forceSave(markdown);
  };

  const copyCurrent = async () => {
    const markdown = editorRef.current?.getMarkdown() ?? latestMarkdownRef.current;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyMessage('内容已复制。');
    } catch {
      setCopyMessage('复制失败，请在编辑区中手动选择内容。');
    }
  };

  const closePreview = () => {
    window.close();
    setCloseHint(true);
  };

  const saveLabel = editor.saving ? '保存中…' : editor.dirty ? '保存修改' : '已保存';
  const invalidMessage = request.key.length === 0 ? '缺少文件地址，无法开始编辑。' : '仅支持 .md 文件全屏编辑。';
  const initialLoadError = !editor.loading && !ready && editor.error;

  return (
    <main className="markdown-preview-shell" data-dirty={editor.dirty}>
      <header className="markdown-preview-head">
        <div className="markdown-preview-mark" aria-hidden="true">MD</div>
        <div className="markdown-preview-heading">
          <span>MARKDOWN · 编辑</span>
          <h1 title={request.name}>{request.name}</h1>
        </div>
        <div className="markdown-preview-actions">
          <span aria-live="polite" className={`markdown-save-state${editor.dirty ? ' is-dirty' : ''}`}>
            {editor.saving ? '保存中' : editor.dirty ? '有修改' : '已保存'}
          </span>
          <button
            aria-busy={editor.saving}
            className="markdown-preview-save"
            disabled={!ready || !editor.dirty || editor.saving || editor.missing || editor.conflict}
            onClick={() => void saveCurrent()}
            type="button"
          >
            <Icon name="check" size={16} /><span>{saveLabel}</span>
          </button>
          <a
            aria-disabled={request.key.length === 0}
            className="markdown-preview-download"
            download={request.name}
            href={request.key.length > 0 ? client.downloadUrl(request.key, true) : undefined}
            rel="noopener noreferrer"
            target="_blank"
          >
            <Icon name="download" size={16} /><span>下载原文件</span>
          </a>
          <button className="markdown-preview-close" onClick={closePreview} type="button">
            <Icon name="close" size={16} /><span>关闭窗口</span>
          </button>
        </div>
      </header>

      <section aria-busy={editor.loading} className="markdown-preview-canvas">
        {!request.valid && (
          <div aria-live="assertive" className="markdown-preview-state markdown-preview-error">
            <span className="markdown-preview-error-symbol">!</span>
            <strong>暂时无法编辑此文件</strong>
            <p>{invalidMessage}</p>
          </div>
        )}
        {request.valid && editor.loading && !ready && (
          <div aria-live="polite" className="markdown-preview-state">
            <span className="markdown-preview-loader" />
            <strong>正在读取 Markdown…</strong>
            <p>文件只在当前页面读取，不会生成外部分享链接。</p>
          </div>
        )}
        {request.valid && initialLoadError && (
          <div aria-live="assertive" className="markdown-preview-state markdown-preview-error">
            <span className="markdown-preview-error-symbol">!</span>
            <strong>暂时无法编辑此文件</strong>
            <p>{editor.error}</p>
          </div>
        )}
        {ready && (
          <div className="markdown-reader-card">
            {renderError ? (
              <div aria-live="assertive" className="markdown-inline-error">{renderError}</div>
            ) : (
              <MDXEditor
                className="markdown-mdx-editor mdxeditor-full-height"
                contentEditableClassName="markdown-reader-content"
                markdown={editor.initialMarkdown}
                onChange={handleChange}
                onError={() => setRenderError('文档包含无法安全解析的 Markdown 语法。')}
                plugins={plugins}
                ref={editorRef}
                spellCheck={false}
                suppressHtmlProcessing
              />
            )}
            {editor.error && !editor.conflict && !editor.missing && (
              <div aria-live="assertive" className="markdown-save-error">{editor.error}</div>
            )}
          </div>
        )}
      </section>

      <footer className="markdown-preview-foot">
        <span>轻存储 Markdown 编辑器</span>
        <span>{closeHint ? '如果窗口未关闭，请关闭此标签页或使用浏览器返回。' : '自动保护未保存修改 · 原始 HTML 与 MDX/JSX 不执行'}</span>
      </footer>

      {editor.conflict && (
        <div className="markdown-editor-overlay" role="presentation">
          <section aria-labelledby="markdown-conflict-title" aria-modal="true" className="markdown-editor-dialog" role="alertdialog">
            <span className="markdown-dialog-kicker">VERSION CONFLICT</span>
            <h2 id="markdown-conflict-title">文件已在其他位置更新</h2>
            <p>本地修改仍然保留。重新加载会丢弃本地修改；强制保存会覆盖远端版本。</p>
            <div className="markdown-dialog-actions">
              <button disabled={editor.saving} onClick={() => void reloadFromServer()} type="button">重新加载</button>
              <button className="danger" disabled={editor.saving} onClick={() => void forceSave()} type="button">强制保存</button>
              <button disabled={editor.saving} onClick={editor.dismissConflict} type="button">取消</button>
            </div>
          </section>
        </div>
      )}

      {editor.missing && (
        <div className="markdown-editor-overlay" role="presentation">
          <section aria-labelledby="markdown-missing-title" aria-modal="true" className="markdown-editor-dialog" role="alertdialog">
            <span className="markdown-dialog-kicker">FILE NOT FOUND</span>
            <h2 id="markdown-missing-title">文件已被删除</h2>
            <p>保存目标已不存在，但当前编辑内容仍完整保留。您可以先复制内容再关闭页面。</p>
            {copyMessage && <p aria-live="polite" className="markdown-copy-message">{copyMessage}</p>}
            <div className="markdown-dialog-actions">
              <button onClick={() => void copyCurrent()} type="button">复制内容</button>
              <button onClick={closePreview} type="button">关闭窗口</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
