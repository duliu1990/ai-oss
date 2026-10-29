import { useMemo } from 'react';
import type { DriveItem, SortDirection, SortField, ViewMode } from '../api/types';
import { FileItem } from './FileItem';
import { Icon } from './Icon';

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export function sortDriveItems(
  items: DriveItem[],
  field: SortField,
  direction: SortDirection,
): DriveItem[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...items].sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    let value = 0;
    if (field === 'name') value = collator.compare(left.name, right.name);
    if (field === 'size') value = left.size - right.size;
    if (field === 'last_modified') {
      value = new Date(left.lastModified).getTime() - new Date(right.lastModified).getTime();
      if (Number.isNaN(value)) value = 0;
    }
    return (value || collator.compare(left.name, right.name)) * sign;
  });
}

interface FileListProps {
  items: DriveItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  truncated: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
  view: ViewMode;
  onDelete: (item: DriveItem) => void;
  onDownload: (item: DriveItem) => void;
  onEdit: (item: DriveItem) => void;
  onLoadMore: () => void;
  onMove: (item: DriveItem) => void;
  onOpen: (item: DriveItem) => void;
  onRefresh: () => void;
  onRename: (item: DriveItem) => void;
  onSort: (field: SortField) => void;
  onView: (view: ViewMode) => void;
}

export function FileList(props: FileListProps) {
  const sorted = useMemo(
    () => sortDriveItems(props.items, props.sortField, props.sortDirection),
    [props.items, props.sortDirection, props.sortField],
  );
  const sortButton = (field: SortField, label: string, className = '') => (
    <button className={`${className} ${props.sortField === field ? 'active' : ''}`} onClick={() => props.onSort(field)} type="button">
      {label}
      {props.sortField === field && <Icon name="arrow-down" size={13} className={props.sortDirection === 'asc' ? 'ascending' : ''} />}
    </button>
  );

  return (
    <section className="file-browser" aria-busy={props.loading}>
      <div className="browser-toolbar">
        <div>
          <span className="eyebrow">INDEX / 当前目录</span>
          <strong>{props.loading ? '读取中…' : `${props.items.length} 项内容`}</strong>
        </div>
        <div className="sort-mobile">
          <label>排序
            <select value={props.sortField} onChange={(event) => props.onSort(event.target.value as SortField)}>
              <option value="name">名称</option><option value="size">大小</option><option value="last_modified">修改时间</option>
            </select>
          </label>
        </div>
        <div className="view-switch" aria-label="视图切换">
          <button aria-label="列表视图" className={props.view === 'list' ? 'active' : ''} onClick={() => props.onView('list')} type="button"><Icon name="list" size={17} /></button>
          <button aria-label="网格视图" className={props.view === 'grid' ? 'active' : ''} onClick={() => props.onView('grid')} type="button"><Icon name="grid" size={16} /></button>
        </div>
      </div>

      {props.error && (
        <div className="state-card error-state">
          <span>!</span><div><strong>暂时无法读取目录</strong><p>{props.error}</p></div>
          <button onClick={props.onRefresh} type="button"><Icon name="refresh" size={16} />重试</button>
        </div>
      )}
      {props.loading && (
        <div className={`file-items ${props.view}`}>
          {Array.from({ length: props.view === 'grid' ? 8 : 6 }, (_, index) => <div className="file-skeleton" key={index} />)}
        </div>
      )}
      {!props.loading && !props.error && sorted.length === 0 && (
        <div className="empty-state">
          <div className="empty-orbit"><Icon name="archive" size={38} /></div>
          <span className="eyebrow">NO OBJECTS HERE</span>
          <h2>这里还没有文件</h2>
          <p>拖入文件，或使用左侧的上传按钮开始整理您的私人空间。</p>
        </div>
      )}
      {!props.loading && sorted.length > 0 && (
        <div className={props.view === 'list' ? 'list-card' : undefined}>
          {props.view === 'list' && (
            <div className="list-heading">
              {sortButton('name', '名称', 'heading-name')}
              {sortButton('size', '大小')}
              {sortButton('last_modified', '修改时间')}
              <span>操作</span>
            </div>
          )}
          <div className={`file-items ${props.view}`}>
            {sorted.map((item) => (
              <FileItem
                item={item}
                key={`${item.kind}-${item.key}`}
                onDelete={props.onDelete}
                onDownload={props.onDownload}
                onEdit={props.onEdit}
                onMove={props.onMove}
                onOpen={props.onOpen}
                onRename={props.onRename}
                view={props.view}
              />
            ))}
          </div>
        </div>
      )}
      {props.truncated && (
        <button className="load-more" disabled={props.loadingMore} onClick={props.onLoadMore} type="button">
          {props.loadingMore ? '正在加载…' : '加载更多内容'}
        </button>
      )}
    </section>
  );
}
