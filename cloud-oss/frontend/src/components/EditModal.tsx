import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import type { DriveItem, FileWriteResponse } from '../api/types';
import { MAX_EDIT_BYTES, useEditor, utf8Bytes } from '../hooks/useEditor';
import { renderMarkdownSafe } from '../markdown';
import { markdownPreviewUrl } from '../markdownPreview';
import { ConfirmDialog, useDialogFocus } from './Dialogs';
import { extension, formatBytes } from './FileItem';
import { Icon } from './Icon';

type MobileTab = 'edit' | 'preview';

interface EditModalProps {
  client: ApiClient;
  item: DriveItem | null;
  replacement?: DriveItem | null;
  onCancelReplacement?: () => void;
  onClose: () => void;
  onConfirmReplacement?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onMissing: () => void;
  onSaved?: (result: FileWriteResponse) => void;
}

const STATUS_LABELS = {
  loading: '加载中…',
  dirty: '未保存',
  saving: '保存中…',
  saved: '已保存',
  error: '错误',
} as const;

function MarkdownPreview({ source }: { source: string }) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    renderMarkdownSafe(source)
      .then((value) => { if (active) setHtml(value); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [source]);
  if (loading) return <div className="markdown-loading">正在生成安全预览…</div>;
  return <article className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function EditorContent({
  client,
  item,
  replacement = null,
  onCancelReplacement,
  onClose,
  onConfirmReplacement,
  onDirtyChange,
  onMissing,
  onSaved,
}: EditModalProps & { item: DriveItem }) {
  const editor = useEditor({ client, keyValue: item.key, onMissing, onSaved });
  const [mobileTab, setMobileTab] = useState<MobileTab>('edit');
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);
  const [confirmMissingClose, setConfirmMissingClose] = useState(false);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const markdown = extension(item.name) === 'md';
  const size = utf8Bytes(editor.content);
  const canSave = editor.dirty && editor.status !== 'loading' && !editor.saving && !editor.missing;
  const confirmationOpen = confirmClose || confirmForce || confirmMissingClose || Boolean(replacement);
  const editorCovered = Boolean(editor.conflictEtag || editor.missing || confirmationOpen);
  const displayedStatus = editor.saving ? 'saving' : editor.status;
  const editorRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conflictRef = useRef<HTMLElement>(null);
  const missingRef = useRef<HTMLElement>(null);

  const requestClose = () => {
    if (editor.dirty) setConfirmClose(true);
    else onClose();
  };

  useDialogFocus(editorRef, !editorCovered, requestClose, textareaRef);
  useDialogFocus(conflictRef, Boolean(editor.conflictEtag) && !confirmationOpen);
  useDialogFocus(missingRef, editor.missing && !confirmationOpen);

  useEffect(() => {
    if (!editorCovered && editor.status !== 'loading') textareaRef.current?.focus();
  }, [editor.status, editorCovered]);

  useEffect(() => {
    onDirtyChange?.(editor.dirty);
    return () => onDirtyChange?.(false);
  }, [editor.dirty, onDirtyChange]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (canSave && !editorCovered) void editor.save();
      }
    };
    globalThis.addEventListener('keydown', saveShortcut);
    return () => globalThis.removeEventListener('keydown', saveShortcut);
  }, [canSave, editor.save, editorCovered]);

  const copyContent = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(editor.content);
      setCopyMessage('内容已复制。');
    } catch {
      setCopyMessage('复制失败，请手动选择编辑器内容进行复制。');
    }
  };

  return (
    <>
      <div
        aria-hidden={editorCovered ? true : undefined}
        className={`modal-backdrop editor-backdrop${editorCovered ? ' editor-backdrop--covered' : ''}`}
        inert={editorCovered ? true : undefined}
        onMouseDown={editorCovered ? undefined : requestClose}
        role="presentation"
      >
        <section
          aria-labelledby="editor-title"
          aria-modal="true"
          className={`edit-modal edit-modal--${markdown ? 'markdown' : 'text'}`}
          data-dirty={editor.dirty}
          data-save-state={editor.missing ? 'missing' : displayedStatus}
          data-saving={editor.saving}
          onMouseDown={(event) => event.stopPropagation()}
          ref={editorRef}
          role="dialog"
          tabIndex={-1}
        >
          <header className="edit-head">
            <div className="edit-title-wrap">
              <span className={`edit-type edit-type-${markdown ? 'md' : 'txt'}`}>{markdown ? 'MD' : 'TXT'}</span>
              <div><span className="eyebrow">DOCUMENT EDITOR</span><h2 id="editor-title">{item.name}</h2></div>
            </div>
            <div className="edit-actions">
              <button aria-busy={editor.saving} className="editor-save" data-saving={editor.saving} disabled={!canSave} onClick={() => void editor.save()} type="button"><Icon name="check" size={16} />保存</button>
              <button aria-label="关闭编辑器" className="icon-button" onClick={requestClose} type="button"><Icon name="close" size={18} /></button>
            </div>
          </header>
          {markdown && (
            <div className="editor-tabs" role="tablist" aria-label="编辑器视图">
              <button aria-selected={mobileTab === 'edit'} className={mobileTab === 'edit' ? 'active' : ''} onClick={() => setMobileTab('edit')} role="tab" type="button">编辑</button>
              <button aria-selected={mobileTab === 'preview'} className={mobileTab === 'preview' ? 'active' : ''} onClick={() => setMobileTab('preview')} role="tab" type="button">预览</button>
            </div>
          )}
          <div className={`editor-stage ${markdown ? 'markdown-editor' : 'text-editor'}`}>
            <div className={`editor-pane editor-input-pane ${mobileTab === 'edit' ? 'active' : ''}`}>
              <textarea
                aria-label={`编辑 ${item.name}`}
                data-dirty={editor.dirty}
                data-save-state={editor.missing ? 'missing' : displayedStatus}
                disabled={editor.status === 'loading'}
                onChange={(event) => editor.setContent(event.target.value)}
                placeholder={editor.status === 'loading' ? '正在加载内容…' : markdown ? '# 开始写作' : '开始输入文本…'}
                ref={textareaRef}
                spellCheck={false}
                value={editor.content}
              />
            </div>
            {markdown && (
              <div className={`editor-pane editor-preview-pane ${mobileTab === 'preview' ? 'active' : ''}`}>
                <div className="editor-preview-head">
                  <span>安全预览</span>
                  <button
                    aria-label={`在新标签页全屏编辑 ${item.name}`}
                    className="markdown-full-preview"
                    onClick={() => window.open(markdownPreviewUrl(item), '_blank', 'noopener,noreferrer')}
                    title="全屏编辑"
                    type="button"
                  >
                    <Icon name="fullscreen" size={14} />全屏编辑 <span aria-hidden="true">↗</span>
                  </button>
                </div>
                <MarkdownPreview source={editor.content} />
              </div>
            )}
          </div>
          <footer className="edit-footer">
            <span className={size > MAX_EDIT_BYTES ? 'byte-limit' : ''}>{formatBytes(size)} UTF-8</span>
            <span className="edit-path" title={item.key}>/{item.key}</span>
            <span aria-live="polite" className={`editor-status status-${displayedStatus}`}>
              <i />{editor.message || STATUS_LABELS[displayedStatus]}
            </span>
          </footer>
        </section>
      </div>
      {editor.conflictEtag && (
        <div
          aria-hidden={confirmationOpen ? true : undefined}
          className={`modal-backdrop conflict-backdrop${confirmationOpen ? ' conflict-backdrop--covered' : ''}`}
          inert={confirmationOpen ? true : undefined}
          role="presentation"
        >
          <section aria-labelledby="conflict-title" aria-modal="true" className="dialog conflict-dialog" ref={conflictRef} role="alertdialog" tabIndex={-1}>
            <div className="dialog-symbol danger"><Icon name="refresh" size={25} /></div>
            <span className="eyebrow">VERSION CONFLICT</span>
            <h2 id="conflict-title">文件已在其他位置更新</h2>
            <p>您的本地内容仍然保留。重新加载会读取远端版本；强制覆盖将用本地内容替换远端版本。</p>
            <div className="dialog-actions conflict-actions">
              <button disabled={editor.saving} onClick={() => void editor.reload()} type="button">重新加载</button>
              <button className="danger-button" disabled={editor.saving} onClick={() => { setConfirmClose(false); setConfirmForce(true); }} type="button">强制覆盖</button>
            </div>
          </section>
        </div>
      )}
      {editor.missing && (
        <div
          aria-hidden={confirmationOpen ? true : undefined}
          className={`modal-backdrop missing-backdrop${confirmationOpen ? ' conflict-backdrop--covered' : ''}`}
          inert={confirmationOpen ? true : undefined}
          role="presentation"
        >
          <section aria-labelledby="missing-title" aria-modal="true" className="dialog missing-dialog" ref={missingRef} role="alertdialog" tabIndex={-1}>
            <div className="dialog-symbol danger"><Icon name="archive" size={25} /></div>
            <span className="eyebrow">FILE NOT FOUND</span>
            <h2 id="missing-title">文件已不存在</h2>
            <p>保存目标已被删除，但您的本地内容仍完整保留。请先复制内容，再决定是否关闭编辑器。</p>
            {copyMessage && <p aria-live="polite" className={`recovery-message${copyMessage.startsWith('复制失败') ? ' error' : ''}`}>{copyMessage}</p>}
            <div className="dialog-actions missing-actions">
              <button onClick={() => void copyContent()} type="button">复制内容</button>
              <button className="danger-button" onClick={() => setConfirmMissingClose(true)} type="button">关闭编辑器</button>
            </div>
          </section>
        </div>
      )}
      <ConfirmDialog
        confirmLabel="放弃更改"
        layer="confirm"
        danger
        message="当前文件包含尚未保存的更改。关闭后这些内容将丢失。"
        onClose={() => setConfirmClose(false)}
        onConfirm={onClose}
        open={confirmClose}
        title="放弃未保存的更改？"
      />
      <ConfirmDialog
        busy={editor.saving}
        confirmLabel="确认强制覆盖"
        layer="confirm"
        danger
        message="此操作会永久覆盖远端较新的内容，且无法撤销。请确认您确实要以当前本地内容为准。"
        onClose={() => setConfirmForce(false)}
        onConfirm={() => { setConfirmForce(false); void editor.save(true); }}
        open={confirmForce}
        title="再次确认强制覆盖？"
      />
      <ConfirmDialog
        confirmLabel="确认关闭"
        layer="confirm"
        danger
        message="关闭后，本地保留的内容将丢失。请确认您已经复制了需要恢复的内容。"
        onClose={() => setConfirmMissingClose(false)}
        onConfirm={onClose}
        open={confirmMissingClose}
        title="关闭编辑器并放弃本地内容？"
      />
      <ConfirmDialog
        confirmLabel="放弃并切换"
        layer="confirm"
        danger
        message={`切换到“${replacement?.name ?? ''}”将丢失当前文件尚未保存的更改。`}
        onClose={() => onCancelReplacement?.()}
        onConfirm={() => onConfirmReplacement?.()}
        open={Boolean(replacement)}
        title="离开当前文件？"
      />
    </>
  );
}

export function EditModal(props: EditModalProps) {
  if (!props.item) return null;
  return <EditorContent {...props} item={props.item} key={props.item.key} />;
}
