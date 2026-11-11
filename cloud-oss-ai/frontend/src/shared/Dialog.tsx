import { useEffect, useId, useRef } from 'react';
import type { FormEvent, ReactNode, RefObject } from 'react';

/**
 * Keeps keyboard focus inside an open dialog, closes it on Escape and hands focus back to the
 * element that opened it. Escape is captured before any page-level shortcut sees it.
 */
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

interface DialogProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** While busy the dialog stays open: backdrop clicks and Escape are ignored. */
  busy?: boolean;
  /** False for dialogs the user must complete, such as choosing a first server. */
  dismissible?: boolean;
  eyebrow?: string;
  /** Rendered above the eyebrow, e.g. the confirmation symbol. */
  leading?: ReactNode;
  /** `confirm` stacks above an open editor. */
  layer?: 'default' | 'confirm';
  role?: 'dialog' | 'alertdialog';
  className?: string;
  id?: string;
  titleId?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Present for form dialogs: the panel renders as a <form> and Enter submits it. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  busy = false,
  dismissible = true,
  eyebrow,
  leading,
  layer = 'default',
  role = 'dialog',
  className,
  id,
  titleId,
  initialFocusRef,
  onSubmit,
}: DialogProps) {
  const generatedId = useId();
  const headingId = titleId ?? `${generatedId}-title`;
  const panelRef = useRef<HTMLElement>(null);
  const closable = dismissible && !busy;
  useDialogFocus(panelRef, open, closable ? onClose : undefined, initialFocusRef);

  if (!open) return null;
  const backdropClass = `modal-backdrop${layer === 'confirm' ? ' modal-backdrop--confirm' : ''}`;
  const panelClass = `dialog${className ? ` ${className}` : ''}`;
  const content = <>
    {leading}
    {eyebrow && <span className="eyebrow">{eyebrow}</span>}
    <h2 id={headingId}>{title}</h2>
    {children}
  </>;
  const shared = {
    'aria-labelledby': headingId,
    'aria-modal': true,
    className: panelClass,
    id,
    onMouseDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
    role,
    tabIndex: -1,
  } as const;
  return (
    <div className={backdropClass} onMouseDown={closable ? onClose : undefined} role="presentation">
      {onSubmit
        ? <form {...shared} onSubmit={onSubmit} ref={panelRef as RefObject<HTMLFormElement>}>{content}</form>
        : <section {...shared} ref={panelRef}>{content}</section>}
    </div>
  );
}
