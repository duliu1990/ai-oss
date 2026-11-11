import { Dialog } from '../Dialog';
import { Icon } from '../Icon';

interface ConfirmDialogProps {
  busy?: boolean;
  confirmLabel?: string;
  danger?: boolean;
  layer?: 'default' | 'confirm';
  message: string;
  open: boolean;
  title: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  busy = false,
  confirmLabel = '确认',
  danger = false,
  layer = 'default',
  message,
  open,
  title,
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog
      busy={busy}
      eyebrow="CONFIRM ACTION"
      layer={layer}
      leading={<div className={`dialog-symbol ${danger ? 'danger' : ''}`}><Icon name={danger ? 'trash' : 'archive'} size={25} /></div>}
      onClose={onClose}
      open={open}
      role="alertdialog"
      title={title}
    >
      <p>{message}</p>
      <div className="dialog-actions">
        <button disabled={busy} onClick={onClose} type="button">取消</button>
        <button className={danger ? 'danger-button' : 'solid-button'} disabled={busy} onClick={onConfirm} type="button">
          {busy ? '处理中…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
