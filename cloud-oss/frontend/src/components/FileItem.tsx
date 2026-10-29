import type { DriveItem, ViewMode } from '../api/types';
import { Icon } from './Icon';
import type { IconName } from './Icon';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'yaml', 'yml', 'xml', 'csv', 'log', 'ini', 'toml']);
const OFFICE_ICONS: Record<string, IconName> = { docx: 'word', xlsx: 'sheet', pptx: 'slides' };

export function extension(name: string): string {
  return name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
}

export function isEditableFile(item: Pick<DriveItem, 'isDir' | 'name'>): boolean {
  return !item.isDir && (extension(item.name) === 'md' || extension(item.name) === 'txt');
}

export function fileIcon(item: DriveItem): IconName {
  if (item.isDir) return 'folder';
  const ext = extension(item.name);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (ext === 'pdf') return 'pdf';
  return OFFICE_ICONS[ext] ?? 'file';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return bytes === 0 ? '0 B' : '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatDate(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

interface FileItemProps {
  item: DriveItem;
  view: ViewMode;
  onDelete: (item: DriveItem) => void;
  onDownload: (item: DriveItem) => void;
  onEdit: (item: DriveItem) => void;
  onMove: (item: DriveItem) => void;
  onOpen: (item: DriveItem) => void;
  onRename: (item: DriveItem) => void;
}

export function FileItem({ item, view, onDelete, onDownload, onEdit, onMove, onOpen, onRename }: FileItemProps) {
  const stop = (callback: () => void) => (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    callback();
  };
  return (
    <article className={`file-item ${view} ${item.isDir ? 'directory' : ''}`}>
      <button
        aria-label={`${item.isDir ? '打开文件夹' : isEditableFile(item) ? '编辑文件' : '预览文件'} ${item.name}`}
        className="file-open"
        onClick={() => onOpen(item)}
        type="button"
      >
        <span className={`file-glyph type-${fileIcon(item)}`}><Icon name={fileIcon(item)} size={view === 'grid' ? 42 : 24} /></span>
        <span className="file-identity">
          <strong title={item.name}>{item.name}</strong>
          {view === 'grid' && <small>{item.isDir ? '文件夹' : formatBytes(item.size)}</small>}
        </span>
        {view === 'list' && <span className="file-size">{item.isDir ? '—' : formatBytes(item.size)}</span>}
        {view === 'list' && <time className="file-date">{formatDate(item.lastModified)}</time>}
      </button>
      <div className="file-actions">
        {isEditableFile(item) && (
          <button aria-label={`编辑 ${item.name}`} className="action-edit" data-tooltip="编辑" onClick={stop(() => onEdit(item))} type="button">
            <Icon name="edit" size={17} />
          </button>
        )}
        {!item.isDir && (
          <button aria-label={`下载 ${item.name}`} className="action-download" data-tooltip="下载" onClick={stop(() => onDownload(item))} type="button">
            <Icon name="download" size={17} />
          </button>
        )}
        <button aria-label={`移动 ${item.name}`} className="action-move" data-tooltip="移动" onClick={stop(() => onMove(item))} type="button">
          <Icon name="move" size={17} />
        </button>
        <button aria-label={`重命名 ${item.name}`} className="action-rename" data-tooltip="重命名" onClick={stop(() => onRename(item))} type="button">
          <Icon name="rename" size={17} />
        </button>
        <button aria-label={`删除 ${item.name}`} className="action-delete danger" data-tooltip="删除" onClick={stop(() => onDelete(item))} type="button">
          <Icon name="trash" size={17} />
        </button>
      </div>
    </article>
  );
}
