import type { ChangeEvent, DragEvent } from 'react';
import type { UploadTask } from '../hooks/useUpload';
import { formatBytes } from './FileItem';
import { Icon } from './Icon';

interface UploadPanelProps {
  dragActive: boolean;
  tasks: UploadTask[];
  onCancel: (id: string) => void;
  onClear: () => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onFiles: (files: File[]) => void;
}

const statusLabel: Record<UploadTask['status'], string> = {
  queued: '等待中',
  uploading: '上传中',
  complete: '已完成',
  error: '失败',
  cancelled: '已取消',
};

export function UploadPanel({
  dragActive,
  tasks,
  onCancel,
  onClear,
  onRemove,
  onRetry,
  onDragLeave,
  onDragOver,
  onDrop,
  onFiles,
}: UploadPanelProps) {
  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  };
  const dropOnOverlay = (event: DragEvent<HTMLElement>) => {
    event.stopPropagation();
    onDrop(event);
  };
  const active = tasks.filter((task) => task.status === 'uploading' || task.status === 'queued').length;
  return (
    <>
      <input id="file-picker" className="sr-only" multiple onChange={chooseFiles} type="file" />
      <div
        aria-hidden={!dragActive}
        className={`drop-overlay ${dragActive ? 'active' : ''}`}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={dropOnOverlay}
      >
        <div className="drop-target">
          <Icon name="upload" size={38} />
          <span className="eyebrow">DROP TO SECURE STORAGE</span>
          <strong>松开即可上传</strong>
          <p>支持多文件 · 大文件自动分片</p>
        </div>
      </div>
      {tasks.length > 0 && (
        <aside className="upload-panel" aria-label="上传任务">
          <div className="upload-panel-head">
            <div><span className="eyebrow">TRANSFER QUEUE</span><strong>{active ? `${active} 项正在上传` : '传输已结束'}</strong></div>
            {!active && <button onClick={onClear} type="button">清除</button>}
          </div>
          <div className="upload-tasks">
            {tasks.map((task) => (
              <div className={`upload-task ${task.status}`} key={task.id}>
                <div className="upload-task-line">
                  <span className="upload-file-icon">{task.status === 'complete' ? <Icon name="check" size={16} /> : <Icon name="file" size={16} />}</span>
                  <div><strong title={task.name}>{task.name}</strong><small>{formatBytes(task.size)} · {task.retrying ? '重试中...' : statusLabel[task.status]}</small></div>
                  <span className="upload-task-control">
                    {(task.status === 'uploading' || task.status === 'queued') && (
                      <button aria-label={`取消上传 ${task.name}`} onClick={() => onCancel(task.id)} type="button"><Icon name="close" size={15} /></button>
                    )}
                  </span>
                  <span className="upload-percent">{task.progress}%</span>
                </div>
                <div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div>
                {task.error && <p>{task.error}</p>}
                {(task.status === 'error' || task.status === 'cancelled') && (
                  <div className="upload-task-actions">
                    {task.status === 'error' && (
                      <button className="upload-retry" onClick={() => onRetry(task.id)} type="button"><Icon name="refresh" size={14} />重试</button>
                    )}
                    <button className="upload-remove" onClick={() => onRemove(task.id)} type="button"><Icon name="close" size={13} />移除</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>
      )}
    </>
  );
}
