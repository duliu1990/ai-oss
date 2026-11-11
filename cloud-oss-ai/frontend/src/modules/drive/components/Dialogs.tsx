import { useEffect, useState } from 'react';
import { Dialog } from '../../../shared/Dialog';

// The generic dialogs are shared across modules; drive code keeps importing them from here.
export { useDialogFocus } from '../../../shared/Dialog';
export { ConfirmDialog } from '../../../shared/dialogs/ConfirmDialog';
export { TextDialog } from '../../../shared/dialogs/TextDialog';

export interface MoveDestination {
  label: string;
  prefix: string;
}

interface MoveDialogProps {
  busy?: boolean;
  destinations: MoveDestination[];
  itemName: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (destination: string) => void;
}

export function MoveDialog({ busy = false, destinations, itemName, open, onClose, onSubmit }: MoveDialogProps) {
  const [destination, setDestination] = useState('');
  useEffect(() => { if (open) setDestination(destinations[0]?.prefix ?? ''); }, [destinations, open]);
  return (
    <Dialog
      busy={busy}
      className="form-dialog"
      eyebrow="MOVE OBJECT"
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); onSubmit(destination); }}
      open={open}
      title={`移动“${itemName}”`}
    >
      <label>目标目录
        <select onChange={(event) => setDestination(event.target.value)} value={destination}>
          {destinations.map((option) => <option key={option.prefix || 'root'} value={option.prefix}>{option.label}</option>)}
        </select>
      </label>
      <p className="dialog-hint">目标列表包含根目录、当前路径的上级目录以及当前可见的文件夹。</p>
      <div className="dialog-actions">
        <button disabled={busy} onClick={onClose} type="button">取消</button>
        <button className="solid-button" disabled={busy || destinations.length === 0} type="submit">{busy ? '移动中…' : '移动'}</button>
      </div>
    </Dialog>
  );
}
