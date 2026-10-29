import { useEffect, useMemo, useState } from 'react';
import type { EditableExtension } from '../api/types';
import { Icon } from './Icon';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const EDITABLE_SUFFIX = /\.(?:md|txt)$/i;

export function createFileNameError(value: string): string | null {
  const name = value.trim();
  if (!name) return '请输入文件名称。';
  if (name === '.' || name === '..') return '名称不能是“.”或“..”。';
  if (name.includes('/') || name.includes('\\')) return '名称不能包含斜杠。';
  if (CONTROL_CHARACTERS.test(name)) return '名称不能包含控制字符。';
  if (EDITABLE_SUFFIX.test(name)) return '名称无需包含 .md 或 .txt 后缀。';
  return null;
}

interface CreateFileDialogProps {
  busy?: boolean;
  error?: string | null;
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, extension: EditableExtension) => void;
}

export function CreateFileDialog({
  busy = false,
  error = null,
  open,
  onClose,
  onSubmit,
}: CreateFileDialogProps) {
  const [name, setName] = useState('');
  const [extension, setExtension] = useState<EditableExtension>('md');
  useEffect(() => {
    if (open) {
      setName('');
      setExtension('md');
    }
  }, [open]);
  const normalized = name.trim();
  const validationError = useMemo(() => createFileNameError(name), [name]);
  if (!open) return null;
  const finalName = normalized ? `${normalized}.${extension}` : `未命名.${extension}`;
  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose} role="presentation">
      <form
        aria-labelledby="create-file-title"
        className="dialog form-dialog create-file-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!validationError) onSubmit(normalized, extension);
        }}
      >
        <div className="dialog-symbol"><Icon name="edit" size={25} /></div>
        <span className="eyebrow">NEW DOCUMENT</span>
        <h2 id="create-file-title">新建文件</h2>
        <label>文件名称
          <input autoFocus maxLength={250} onChange={(event) => setName(event.target.value)} placeholder="例如：项目说明" value={name} />
        </label>
        {name && validationError && <small className="field-error">{validationError}</small>}
        <label>文件类型
          <select onChange={(event) => setExtension(event.target.value as EditableExtension)} value={extension}>
            <option value="md">Markdown (.md)</option>
            <option value="txt">纯文本 (.txt)</option>
          </select>
        </label>
        <div className="filename-preview"><span>最终文件名</span><strong>{finalName}</strong></div>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button disabled={busy} onClick={onClose} type="button">取消</button>
          <button className="solid-button" disabled={busy || validationError !== null} type="submit">
            {busy ? '创建中…' : '创建并编辑'}
          </button>
        </div>
      </form>
    </div>
  );
}
