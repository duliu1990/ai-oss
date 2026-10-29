import { MDXEditor } from '@mdxeditor/editor';
import type { MDXEditorMethods } from '@mdxeditor/editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { api, errorMessage } from '../api/client';
import type { NoteEntry } from '../api/types';
import { useMdxEditor } from '../hooks/useMdxEditor';
import { useNotes } from '../hooks/useNotes';
import { createMdxEditorPlugins } from '../mdxEditorPlugins';
import { Icon } from './Icon';
import { ConfirmDialog } from './Dialogs';
import '@mdxeditor/editor/style.css';
import '../markdown-preview.css';

export function formatRelativeTime(date: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  if (Number.isNaN(then)) return date;
  const seconds = Math.round((now - then) / 1_000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  const d = new Date(then);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface NotesViewProps {
  client?: ApiClient;
}

export function NotesView({ client = api }: NotesViewProps) {
  const notesList = useNotes(client);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileEditing, setMobileEditing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NoteEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  const editorRef = useRef<MDXEditorMethods>(null);
  const latestMarkdownRef = useRef('');

  const editor = useMdxEditor({ client, enabled: selectedKey !== null, key: selectedKey ?? '', storage: 'notes' });
  const [ready, setReady] = useState(false);

  const plugins = useMemo(
    () => createMdxEditorPlugins(editor.baselineMarkdown),
    [editor.baselineMarkdown],
  );

  useEffect(() => {
    if (!editor.loading && !editor.error && selectedKey !== null) {
      latestMarkdownRef.current = editor.initialMarkdown;
      setReady(true);
    }
  }, [editor.error, editor.initialMarkdown, editor.loading, selectedKey]);

  useEffect(() => {
    setReady(false);
    setRenderError(null);
  }, [selectedKey]);

  const handleChange = useCallback((markdown: string) => {
    latestMarkdownRef.current = markdown;
    editor.setCurrentMarkdown(markdown);
  }, [editor.setCurrentMarkdown]);

  const saveCurrent = useCallback(async () => {
    const markdown = editorRef.current?.getMarkdown() ?? latestMarkdownRef.current;
    latestMarkdownRef.current = markdown;
    editor.setCurrentMarkdown(markdown);
    await editor.save(markdown);
    void notesList.refresh();
  }, [editor.save, editor.setCurrentMarkdown, notesList.refresh]);

  // Cmd/Ctrl+S
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (ready && editor.dirty && !editor.saving && !editor.missing && !editor.conflict) {
          void saveCurrent();
        }
      }
    };
    globalThis.addEventListener('keydown', handler);
    return () => globalThis.removeEventListener('keydown', handler);
  }, [editor.conflict, editor.dirty, editor.missing, editor.saving, ready, saveCurrent]);

  // Switch notes with dirty guard
  const selectNote = useCallback((key: string) => {
    if (key === selectedKey) return;
    if (editor.dirty) {
      setSwitchTarget(key);
      return;
    }
    setSelectedKey(key);
    setMobileEditing(true);
  }, [editor.dirty, selectedKey]);

  const confirmSwitch = useCallback(() => {
    if (!switchTarget) return;
    setSelectedKey(switchTarget);
    setMobileEditing(true);
    setSwitchTarget(null);
  }, [switchTarget]);

  const cancelSwitch = useCallback(() => {
    setSwitchTarget(null);
  }, []);

  // Mobile back
  const handleBack = useCallback(() => {
    if (editor.dirty) {
      setSwitchTarget('__back__');
      return;
    }
    setMobileEditing(false);
    setSelectedKey(null);
  }, [editor.dirty]);

  const confirmBack = useCallback(() => {
    setMobileEditing(false);
    setSelectedKey(null);
    setSwitchTarget(null);
  }, []);

  // Create note
  const submitCreate = async () => {
    const trimmed = createName.trim();
    if (!trimmed) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const result = await client.createNote(trimmed);
      setCreateOpen(false);
      setCreateName('');
      await notesList.refresh();
      setSelectedKey(result.key);
      setMobileEditing(true);
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      setCreateBusy(false);
    }
  };

  // Delete note
  const submitDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await client.deleteNote(deleteTarget.key);
      if (selectedKey === deleteTarget.key) {
        setSelectedKey(null);
        setMobileEditing(false);
      }
      setDeleteTarget(null);
      await notesList.refresh();
    } catch (error) {
      void error;
    } finally {
      setDeleteBusy(false);
    }
  };

  // Reload from server
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
    void notesList.refresh();
  };

  const selectedNote = notesList.notes.find((n) => n.key === selectedKey);
  const saveStateText = editor.saving ? '保存中...' : editor.dirty ? '有修改' : '已保存';

  return (
    <div className={`notes-view${mobileEditing ? ' notes-mobile-editing' : ''}`}>
      {/* Left sidebar: notes list */}
      <aside className="notes-sidebar">
        <div className="notes-sidebar-header">
          <div className="notes-search-wrap">
            <Icon name="search" size={15} />
            <input
              className="notes-search-input"
              onChange={(event) => notesList.setSearchQuery(event.target.value)}
              placeholder="搜索笔记…"
              type="search"
              value={notesList.searchQuery}
            />
          </div>
          <button className="notes-create-btn" onClick={() => { setCreateError(null); setCreateOpen(true); }} type="button">
            <Icon name="plus" size={16} />
          </button>
        </div>

        {notesList.loading && (
          <div className="notes-loading">
            <span className="notes-spinner" />
            <span>加载中…</span>
          </div>
        )}

        {notesList.error && (
          <div className="notes-error">
            <span>!</span>
            <span>{notesList.error}</span>
          </div>
        )}

        {!notesList.loading && !notesList.error && notesList.filteredNotes.length === 0 && (
          <div className="notes-empty">
            <Icon name="note" size={40} />
            <p>{notesList.searchQuery ? '未找到匹配的笔记' : '还没有笔记'}</p>
            {!notesList.searchQuery && (
              <button className="notes-empty-create" onClick={() => { setCreateError(null); setCreateOpen(true); }} type="button">
                新建笔记
              </button>
            )}
          </div>
        )}

        <div className="notes-list" role="listbox">
          {notesList.filteredNotes.map((note) => (
            <div
              aria-selected={note.key === selectedKey}
              className={`notes-list-item${note.key === selectedKey ? ' active' : ''}`}
              key={note.key}
              onClick={() => selectNote(note.key)}
              role="option"
              tabIndex={0}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') selectNote(note.key); }}
            >
              <div className="note-info">
                <span className="note-name">{note.name.replace(/\.md$/i, '')}</span>
                <span className="note-time">{formatRelativeTime(note.last_modified)}</span>
              </div>
              <button
                aria-label={`删除 ${note.name}`}
                className="note-delete-btn"
                onClick={(event) => { event.stopPropagation(); setDeleteTarget(note); }}
                type="button"
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Right pane: editor */}
      <section className="notes-editor-pane">
        {mobileEditing && (
          <button className="notes-back-btn" onClick={handleBack} type="button">
            <Icon name="chevron" size={18} />
            <span>返回</span>
          </button>
        )}

        {selectedKey === null && (
          <div className="notes-empty-state">
            <Icon name="note" size={56} />
            <h2>选择一个笔记开始编辑</h2>
            <p>在左侧列表选择一个笔记，或新建一个。</p>
          </div>
        )}

        {selectedKey !== null && (
          <>
            <div className="notes-editor-header">
              <span className="notes-editor-path">{selectedNote?.key ?? selectedKey}</span>
              <span className={`notes-save-state${editor.dirty ? ' is-dirty' : ''}`}>{saveStateText}</span>
              <span className="notes-shortcut-hint">{navigator.platform?.includes('Mac') ? '⌘S' : 'Ctrl+S'}</span>
              <button
                className="notes-editor-save-btn"
                disabled={!ready || !editor.dirty || editor.saving || editor.missing || editor.conflict}
                onClick={() => void saveCurrent()}
                type="button"
              >
                <Icon name="check" size={14} /><span>保存</span>
              </button>
            </div>

            <div className="notes-editor-body">
              {editor.loading && !ready && (
                <div className="notes-editor-loading">
                  <span className="notes-spinner" />
                  <span>正在读取…</span>
                </div>
              )}

              {!editor.loading && !ready && editor.error && (
                <div className="notes-editor-error">
                  <span>!</span>
                  <p>{editor.error}</p>
                </div>
              )}

              {ready && (
                renderError ? (
                  <div className="notes-editor-error">
                    <span>!</span>
                    <p>{renderError}</p>
                  </div>
                ) : (
                  <MDXEditor
                    className="markdown-mdx-editor notes-mdx-editor mdxeditor-full-height"
                    contentEditableClassName="markdown-reader-content"
                    markdown={editor.initialMarkdown}
                    onChange={handleChange}
                    onError={() => setRenderError('文档包含无法安全解析的 Markdown 语法。')}
                    plugins={plugins}
                    ref={editorRef}
                    spellCheck={false}
                    suppressHtmlProcessing
                  />
                )
              )}

              {editor.error && !editor.conflict && !editor.missing && ready && (
                <div className="notes-save-error">{editor.error}</div>
              )}
            </div>
          </>
        )}
      </section>

      {/* Conflict overlay */}
      {editor.conflict && (
        <div className="markdown-editor-overlay" role="presentation">
          <section aria-modal="true" className="markdown-editor-dialog" role="alertdialog">
            <span className="markdown-dialog-kicker">VERSION CONFLICT</span>
            <h2>文件已在其他位置更新</h2>
            <p>本地修改仍然保留。重新加载会丢弃本地修改；强制保存会覆盖远端版本。</p>
            <div className="markdown-dialog-actions">
              <button disabled={editor.saving} onClick={() => void reloadFromServer()} type="button">重新加载</button>
              <button className="danger" disabled={editor.saving} onClick={() => void forceSave()} type="button">强制保存</button>
              <button disabled={editor.saving} onClick={editor.dismissConflict} type="button">取消</button>
            </div>
          </section>
        </div>
      )}

      {/* Missing overlay */}
      {editor.missing && (
        <div className="markdown-editor-overlay" role="presentation">
          <section aria-modal="true" className="markdown-editor-dialog" role="alertdialog">
            <span className="markdown-dialog-kicker">FILE NOT FOUND</span>
            <h2>文件已被删除</h2>
            <p>保存目标已不存在，但当前编辑内容仍完整保留。</p>
            <div className="markdown-dialog-actions">
              <button onClick={() => { setSelectedKey(null); setMobileEditing(false); }} type="button">返回列表</button>
            </div>
          </section>
        </div>
      )}

      {/* Switch confirmation */}
      <ConfirmDialog
        confirmLabel="放弃修改"
        danger
        message="当前笔记有未保存的修改，切换后修改将丢失。"
        onClose={cancelSwitch}
        onConfirm={switchTarget === '__back__' ? confirmBack : confirmSwitch}
        open={switchTarget !== null}
        title="放弃未保存修改？"
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        busy={deleteBusy}
        confirmLabel="永久删除"
        danger
        message={`将永久删除"${deleteTarget?.name ?? ''}"，此操作不可恢复。`}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void submitDelete()}
        open={deleteTarget !== null}
        title="确认删除笔记？"
      />

      {/* Create dialog */}
      {createOpen && (
        <div className="modal-backdrop" onMouseDown={createBusy ? undefined : () => setCreateOpen(false)} role="presentation">
          <form
            className="dialog form-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}
          >
            <span className="eyebrow">NEW NOTE</span>
            <h2>新建笔记</h2>
            <label>
              笔记名称
              <input
                autoFocus
                maxLength={200}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="例如：读书笔记"
                value={createName}
              />
            </label>
            <div className="filename-preview">
              <span>FILENAME</span>
              <strong>{createName.trim() || '笔记名称'}.md</strong>
            </div>
            {createError && <p className="dialog-error">{createError}</p>}
            <div className="dialog-actions">
              <button disabled={createBusy} onClick={() => setCreateOpen(false)} type="button">取消</button>
              <button className="solid-button" disabled={createBusy || !createName.trim()} type="submit">
                {createBusy ? '创建中…' : '创建笔记'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
