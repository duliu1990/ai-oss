import { useEffect, useState } from 'react';
import { Dialog } from '../Dialog';

interface TextDialogProps {
  busy?: boolean;
  initialValue?: string;
  label: string;
  open: boolean;
  submitLabel: string;
  title: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
}

/** Asks for one object name; names may not contain "/" or be "." / "..". */
export function TextDialog({
  busy = false,
  initialValue = '',
  label,
  open,
  submitLabel,
  title,
  onClose,
  onSubmit,
}: TextDialogProps) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => { if (open) setValue(initialValue); }, [initialValue, open]);
  const normalized = value.trim();
  const invalid = !normalized || normalized.includes('/') || normalized === '.' || normalized === '..';
  return (
    <Dialog
      busy={busy}
      className="form-dialog"
      eyebrow="ORGANIZE STORAGE"
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); if (!invalid) onSubmit(normalized); }}
      open={open}
      title={title}
    >
      <label>{label}<input maxLength={255} onChange={(event) => setValue(event.target.value)} value={value} /></label>
      {value && invalid && <small className="field-error">名称不能为空，且不能包含“/”。</small>}
      <div className="dialog-actions">
        <button disabled={busy} onClick={onClose} type="button">取消</button>
        <button className="solid-button" disabled={busy || invalid} type="submit">{busy ? '处理中…' : submitLabel}</button>
      </div>
    </Dialog>
  );
}
