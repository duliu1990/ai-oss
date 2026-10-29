import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { api, errorMessage, isAbort } from './api/client';
import type { ConfigResponse, DriveItem, EditableExtension, FileEntry, SortDirection, SortField, ViewMode } from './api/types';
import { fileToDriveItem, folderToDriveItem } from './api/types';
import { Breadcrumb, breadcrumbSegments } from './components/Breadcrumb';
import { CreateFileDialog } from './components/CreateFileDialog';
import { ConfirmDialog, MoveDialog, TextDialog } from './components/Dialogs';
import type { MoveDestination } from './components/Dialogs';
import { EditModal } from './components/EditModal';
import { isEditableFile } from './components/FileItem';
import { FileList } from './components/FileList';
import { Icon } from './components/Icon';
import { Layout } from './components/Layout';
import type { ActiveSection } from './components/Layout';
import { PreviewModal } from './components/PreviewModal';
import { SearchBar } from './components/SearchBar';
import { UploadPanel } from './components/UploadPanel';
import { useFiles } from './hooks/useFiles';
import { useUpload } from './hooks/useUpload';
import { isOfficeFile, officePreviewUrl } from './officePreview';

type ConfirmState =
  | { kind: 'delete'; item: DriveItem }
  | { kind: 'overwrite'; name: string }
  | null;
type TextDialogState = { kind: 'create' } | { kind: 'rename'; item: DriveItem } | null;

function normalizePrefix(value: string): string {
  const normalized = value.split('/').filter(Boolean).join('/');
  return normalized ? `${normalized}/` : '';
}

function initialPrefix(): string {
  try { return normalizePrefix(new URLSearchParams(globalThis.location.search).get('prefix') ?? ''); }
  catch { return ''; }
}

function parentPrefix(key: string): string {
  const parts = key.replace(/\/$/, '').split('/');
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : '';
}

function initialView(): ViewMode {
  try { return globalThis.localStorage.getItem('cabinet:view') === 'grid' ? 'grid' : 'list'; }
  catch { return 'list'; }
}

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('files');
  const [prefix, setPrefix] = useState(initialPrefix);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [view, setViewState] = useState<ViewMode>(initialView);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<DriveItem | null>(null);
  const [editor, setEditor] = useState<DriveItem | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorReplacement, setEditorReplacement] = useState<DriveItem | null>(null);
  const [createFileOpen, setCreateFileOpen] = useState(false);
  const [createFileError, setCreateFileError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [textDialog, setTextDialog] = useState<TextDialogState>(null);
  const [moveItem, setMoveItem] = useState<DriveItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const overwriteResolver = useRef<((answer: boolean) => void) | null>(null);

  // Lazy-loaded NotesView
  const [NotesViewComponent, setNotesViewComponent] = useState<React.ComponentType<{ client?: typeof api }> | null>(null);
  useEffect(() => {
    if (activeSection === 'notes' && !NotesViewComponent) {
      void import('./components/NotesView').then(({ NotesView }) => {
        setNotesViewComponent(() => NotesView);
      });
    }
  }, [activeSection, NotesViewComponent]);

  const switchSection = useCallback((section: ActiveSection) => {
    if (section === activeSection) return;
    if (section === 'notes' && editor && editorDirty) {
      // Show confirm before switching to notes if editor has unsaved content
      setEditorReplacement(null);
    }
    setActiveSection(section);
  }, [activeSection, editor, editorDirty]);

  const listing = useFiles(api, prefix);
  const uploader = useUpload(api, listing.refresh);
  const items = useMemo(() => [
    ...listing.folders.map(folderToDriveItem),
    ...listing.files.map(fileToDriveItem),
  ], [listing.files, listing.folders]);
  const currentTitle = breadcrumbSegments(prefix).at(-1)?.label ?? '根目录';

  const notify = useCallback((message: string) => setToast(message), []);
  const closePreview = useCallback(() => setPreview(null), []);
  const closeEditor = useCallback(() => {
    setEditor(null);
    setEditorDirty(false);
    setEditorReplacement(null);
  }, []);
  const requestEditor = useCallback((item: DriveItem) => {
    if (editor?.key === item.key) return;
    if (editor && editorDirty) {
      setEditorReplacement(item);
      return;
    }
    setEditor(item);
    setEditorDirty(false);
    setEditorReplacement(null);
  }, [editor, editorDirty]);
  const confirmEditorReplacement = useCallback(() => {
    if (!editorReplacement) return;
    setEditor(editorReplacement);
    setEditorDirty(false);
    setEditorReplacement(null);
  }, [editorReplacement]);

  useEffect(() => {
    const controller = new AbortController();
    api.config(controller.signal).then(setConfig).catch((error: unknown) => {
      if (!isAbort(error)) notify(errorMessage(error));
    });
    return () => controller.abort();
  }, [notify]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = globalThis.setTimeout(() => setToast(null), 3200);
    return () => globalThis.clearTimeout(timer);
  }, [toast]);

  const navigate = useCallback((nextPrefix: string, replace = false) => {
    const normalized = normalizePrefix(nextPrefix);
    const url = new URL(globalThis.location.href);
    if (normalized) url.searchParams.set('prefix', normalized);
    else url.searchParams.delete('prefix');
    globalThis.history[replace ? 'replaceState' : 'pushState']({}, '', url);
    setPrefix(normalized);
    setQuery('');
    setSearchResults([]);
  }, []);

  useEffect(() => {
    const onPopState = () => setPrefix(initialPrefix());
    globalThis.addEventListener('popstate', onPopState);
    return () => globalThis.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults([]);
      setSearching(false);
      return undefined;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = globalThis.setTimeout(() => {
      api.search(trimmed, prefix, controller.signal)
        .then((result) => setSearchResults(result.results))
        .catch((error: unknown) => { if (!isAbort(error)) notify(errorMessage(error)); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 280);
    return () => {
      globalThis.clearTimeout(timer);
      controller.abort();
    };
  }, [notify, prefix, query]);

  const setView = (next: ViewMode) => {
    setViewState(next);
    try { globalThis.localStorage.setItem('cabinet:view', next); } catch { /* Preferences are optional. */ }
  };

  const setSort = (field: SortField) => {
    if (field === sortField) setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
    else {
      setSortField(field);
      setSortDirection(field === 'name' ? 'asc' : 'desc');
    }
  };

  const openItem = (item: DriveItem) => {
    if (item.isDir) {
      navigate(item.key);
      return;
    }
    if (isEditableFile(item)) {
      requestEditor(item);
      return;
    }
    if (isOfficeFile(item)) {
      globalThis.open(officePreviewUrl(item), '_blank', 'noopener,noreferrer');
      return;
    }
    setPreview(item);
  };

  const download = (item: DriveItem) => {
    const link = document.createElement('a');
    link.href = api.downloadUrl(item.key, true);
    link.download = item.name;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  };

  const askOverwrite = useCallback((name: string) => new Promise<boolean>((resolve) => {
    overwriteResolver.current = resolve;
    setConfirm({ kind: 'overwrite', name });
  }), []);

  const addFiles = useCallback((files: File[]) => {
    if (!files.length) return;
    const names = new Set(items.map((item) => item.name));
    void uploader.enqueue(files, prefix, names, askOverwrite);
  }, [askOverwrite, items, prefix, uploader]);

  const closeConfirm = () => {
    if (confirm?.kind === 'overwrite') {
      overwriteResolver.current?.(false);
      overwriteResolver.current = null;
    }
    setConfirm(null);
  };

  const confirmAction = async () => {
    if (!confirm) return;
    if (confirm.kind === 'overwrite') {
      overwriteResolver.current?.(true);
      overwriteResolver.current = null;
      setConfirm(null);
      return;
    }
    setBusy(true);
    try {
      if (confirm.item.isDir) {
        const result = await api.deleteFolder(confirm.item.key);
        notify(`已删除文件夹及其中 ${result.deleted} 项内容。`);
      } else {
        await api.deleteFile(confirm.item.key);
        notify('文件已删除。');
      }
      setConfirm(null);
      await listing.refresh();
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const submitCreateFile = async (name: string, extension: EditableExtension) => {
    setBusy(true);
    setCreateFileError(null);
    try {
      const result = await api.createFile({ prefix, name, extension });
      const finalName = `${name}.${extension}`;
      setCreateFileOpen(false);
      requestEditor({
        kind: 'file',
        key: result.key,
        name: finalName,
        size: result.size,
        lastModified: new Date().toISOString(),
        isDir: false,
      });
      notify(`“${finalName}”已创建。`);
      void listing.refresh();
    } catch (error) {
      setCreateFileError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const submitTextDialog = async (value: string) => {
    if (!textDialog) return;
    setBusy(true);
    try {
      if (textDialog.kind === 'create') {
        await api.createFolder(`${prefix}${value}/`);
        notify(`文件夹“${value}”已创建。`);
      } else {
        await api.rename(textDialog.item.key, value);
        notify(`已重命名为“${value}”。`);
      }
      setTextDialog(null);
      await listing.refresh();
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const moveDestinations = useMemo(() => {
    const destinations: MoveDestination[] = breadcrumbSegments(prefix)
      .filter((segment) => segment.prefix !== prefix)
      .map((segment) => ({ label: segment.prefix ? `/${segment.prefix}` : '/ 根目录', prefix: segment.prefix }));
    for (const folder of listing.folders) {
      if (folder.prefix !== moveItem?.key) destinations.push({ label: `/${folder.prefix}`, prefix: folder.prefix });
    }
    return [...new Map(destinations.map((destination) => [destination.prefix, destination])).values()];
  }, [listing.folders, moveItem?.key, prefix]);

  const submitMove = async (destination: string) => {
    if (!moveItem) return;
    setBusy(true);
    try {
      await api.move(moveItem.key, destination);
      notify(`“${moveItem.name}”已移动。`);
      setMoveItem(null);
      await listing.refresh();
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const selectSearchResult = (result: FileEntry) => {
    navigate(parentPrefix(result.key));
  };

  const openPicker = () => document.querySelector<HTMLInputElement>('#file-picker')?.click();
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  };
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const deleteMessage = confirm?.kind === 'delete'
    ? confirm.item.isDir
      ? `将递归删除“${confirm.item.name}”以及其中所有内容。此操作不可恢复。`
      : `将永久删除“${confirm.item.name}”。此操作不可恢复。`
    : '';

  return (
    <>
      <Layout
        activeSection={activeSection}
        backgroundInert={editor !== null}
        config={config}
        header={(
          <>
            {activeSection === 'files' && (
              <>
                <SearchBar onChange={setQuery} onSelect={selectSearchResult} query={query} results={searchResults} searching={searching} />
                <button aria-label="刷新目录" className="header-action" onClick={() => void listing.refresh()} type="button"><Icon name="refresh" size={18} /><span>刷新</span></button>
              </>
            )}
          </>
        )}
        onGoRoot={() => { setActiveSection('files'); navigate(''); }}
        onSwitchSection={switchSection}
        onUpload={openPicker}
      >
      {activeSection === 'files' && (
      <section className="workspace" onDragEnter={onDragOver} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
        <div className="directory-head">
          <div>
            <Breadcrumb onNavigate={navigate} prefix={prefix} />
            <h1>{currentTitle}</h1>
            <p>在这里管理、预览和传输您的私人文件。</p>
          </div>
          <div className="directory-actions">
            <button onClick={() => { setCreateFileError(null); setCreateFileOpen(true); }} type="button"><Icon name="edit" size={17} />新建文件</button>
            <button onClick={() => setTextDialog({ kind: 'create' })} type="button"><Icon name="plus" size={17} />新建文件夹</button>
            <button className="solid-button" onClick={openPicker} type="button"><Icon name="upload" size={17} />上传</button>
          </div>
        </div>
        <FileList
          error={listing.error}
          items={items}
          loading={listing.loading}
          loadingMore={listing.loadingMore}
          onDelete={(item) => setConfirm({ kind: 'delete', item })}
          onDownload={download}
          onEdit={requestEditor}
          onLoadMore={listing.loadMore}
          onMove={setMoveItem}
          onOpen={openItem}
          onRefresh={() => void listing.refresh()}
          onRename={(item) => setTextDialog({ kind: 'rename', item })}
          onSort={setSort}
          onView={setView}
          sortDirection={sortDirection}
          sortField={sortField}
          truncated={listing.truncated}
          view={view}
        />
        <UploadPanel
          dragActive={dragActive}
          onCancel={uploader.cancel}
          onClear={uploader.clearFinished}
          onRemove={uploader.remove}
          onRetry={uploader.retry}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onFiles={addFiles}
          tasks={uploader.tasks}
        />
      </section>
      )}
      {activeSection === 'notes' && NotesViewComponent && <NotesViewComponent client={api} />}
      {activeSection === 'notes' && !NotesViewComponent && (
        <div className="notes-loading" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 60px)' }}>
          <span className="notes-spinner" />
          <span>加载中…</span>
        </div>
      )}
      <PreviewModal client={api} item={preview} onClose={closePreview} onDownload={download} onNotify={notify} />
      <CreateFileDialog
        busy={busy}
        error={createFileError}
        onClose={() => { setCreateFileOpen(false); setCreateFileError(null); }}
        onSubmit={(name, extension) => void submitCreateFile(name, extension)}
        open={createFileOpen}
      />
      <ConfirmDialog
        busy={busy}
        confirmLabel={confirm?.kind === 'overwrite' ? '覆盖上传' : '永久删除'}
        danger={confirm?.kind === 'delete'}
        message={confirm?.kind === 'overwrite' ? `“${confirm.name}”已存在。继续上传将覆盖同名文件。` : deleteMessage}
        onClose={closeConfirm}
        onConfirm={() => void confirmAction()}
        open={confirm !== null}
        title={confirm?.kind === 'overwrite' ? '覆盖同名文件？' : '确认删除？'}
      />
      <TextDialog
        busy={busy}
        initialValue={textDialog?.kind === 'rename' ? textDialog.item.name : ''}
        label={textDialog?.kind === 'rename' ? '新的名称' : '文件夹名称'}
        onClose={() => setTextDialog(null)}
        onSubmit={(value) => void submitTextDialog(value)}
        open={textDialog !== null}
        submitLabel={textDialog?.kind === 'rename' ? '保存名称' : '创建文件夹'}
        title={textDialog?.kind === 'rename' ? `重命名“${textDialog.item.name}”` : '新建文件夹'}
      />
      <MoveDialog
        busy={busy}
        destinations={moveDestinations}
        itemName={moveItem?.name ?? ''}
        onClose={() => setMoveItem(null)}
        onSubmit={(destination) => void submitMove(destination)}
        open={moveItem !== null}
      />
      {toast && <div aria-live="polite" className="toast"><Icon name="check" size={18} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast(null)} type="button"><Icon name="close" size={15} /></button></div>}
      </Layout>
      <EditModal
        client={api}
        item={editor}
        onCancelReplacement={() => setEditorReplacement(null)}
        onClose={closeEditor}
        onConfirmReplacement={confirmEditorReplacement}
        onDirtyChange={setEditorDirty}
        onMissing={() => { notify('文件已不存在。'); closeEditor(); void listing.refresh(); }}
        onSaved={(result) => {
          listing.updateFileMetadata(result.key, result.size, new Date().toISOString());
          void listing.refresh();
        }}
        replacement={editorReplacement}
      />
    </>
  );
}
