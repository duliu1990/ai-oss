import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Icon } from './Icon';

export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    const dialog = ref.current;
    if (!active || !dialog) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
    ));
    const focusFirst = () => {
      const preferred = initialFocusRef?.current;
      (preferred && !preferred.matches(':disabled') ? preferred : controls()[0] ?? dialog).focus();
    };
    focusFirst();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        escapeRef.current?.();
      } else if (event.key === 'Tab') {
        const targets = controls();
        const first = targets[0] ?? dialog;
        const last = targets.at(-1) ?? dialog;
        if (!targets.length || !dialog.contains(document.activeElement)
          || (event.shiftKey && document.activeElement === first)
          || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    const keepFocusInside = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusFirst();
    };
    globalThis.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', keepFocusInside);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', keepFocusInside);
      globalThis.queueMicrotask(() => {
        if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus();
      });
    };
  }, [active, initialFocusRef, ref]);
}

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
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, open && layer === 'confirm', busy ? undefined : onClose);

  if (!open) return null;
  const backdropClass = `modal-backdrop${layer === 'confirm' ? ' modal-backdrop--confirm' : ''}`;
  return (
    <div className={backdropClass} onMouseDown={busy ? undefined : onClose} role="presentation">
      <section aria-labelledby="confirm-title" aria-modal="true" className="dialog" onMouseDown={(event) => event.stopPropagation()} ref={dialogRef} role="alertdialog" tabIndex={-1}>
        <div className={`dialog-symbol ${danger ? 'danger' : ''}`}><Icon name={danger ? 'trash' : 'archive'} size={25} /></div>
        <span className="eyebrow">CONFIRM ACTION</span>
        <h2 id="confirm-title">{title}</h2>
        <p>{message}</p>
        <div className="dialog-actions">
          <button disabled={busy} onClick={onClose} type="button">取消</button>
          <button className={danger ? 'danger-button' : 'solid-button'} disabled={busy} onClick={onConfirm} type="button">
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

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
  if (!open) return null;
  const normalized = value.trim();
  const invalid = !normalized || normalized.includes('/') || normalized === '.' || normalized === '..';
  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose} role="presentation">
      <form className="dialog form-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); if (!invalid) onSubmit(normalized); }}>
        <span className="eyebrow">ORGANIZE STORAGE</span>
        <h2>{title}</h2>
        <label>{label}<input autoFocus maxLength={255} onChange={(event) => setValue(event.target.value)} value={value} /></label>
        {value && invalid && <small className="field-error">名称不能为空，且不能包含“/”。</small>}
        <div className="dialog-actions">
          <button disabled={busy} onClick={onClose} type="button">取消</button>
          <button className="solid-button" disabled={busy || invalid} type="submit">{busy ? '处理中…' : submitLabel}</button>
        </div>
      </form>
    </div>
  );
}

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
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose} role="presentation">
      <form className="dialog form-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSubmit(destination); }}>
        <span className="eyebrow">MOVE OBJECT</span>
        <h2>移动“{itemName}”</h2>
        <label>目标目录
          <select autoFocus onChange={(event) => setDestination(event.target.value)} value={destination}>
            {destinations.map((option) => <option key={option.prefix || 'root'} value={option.prefix}>{option.label}</option>)}
          </select>
        </label>
        <p className="dialog-hint">目标列表包含根目录、当前路径的上级目录以及当前可见的文件夹。</p>
        <div className="dialog-actions">
          <button disabled={busy} onClick={onClose} type="button">取消</button>
          <button className="solid-button" disabled={busy || destinations.length === 0} type="submit">{busy ? '移动中…' : '移动'}</button>
        </div>
      </form>
    </div>
  );
}
