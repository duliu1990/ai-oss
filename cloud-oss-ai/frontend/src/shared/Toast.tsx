import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

const SUCCESS_MS = 3200;
const ERROR_MS = 6000;

export interface NotifyOptions {
  error?: boolean;
}

export type Notify = (message: string, options?: NotifyOptions) => void;

interface ToastState {
  id: number;
  message: string;
  error: boolean;
}

const ToastContext = createContext<Notify | null>(null);

/** One toast slot for the whole app; a newer message replaces the visible one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const notify = useCallback<Notify>((message, options) => {
    setToast((current) => ({ id: (current?.id ?? 0) + 1, message, error: options?.error ?? false }));
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = globalThis.setTimeout(() => setToast(null), toast.error ? ERROR_MS : SUCCESS_MS);
    return () => globalThis.clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      {toast && (
        <div
          aria-live={toast.error ? 'assertive' : 'polite'}
          className={`toast${toast.error ? ' error' : ''}`}
          id="toast"
          key={toast.id}
          role={toast.error ? 'alert' : 'status'}
        >
          <Icon name={toast.error ? 'close' : 'check'} size={18} />
          <span>{toast.message}</span>
          <button aria-label="关闭提示" onClick={() => setToast(null)} type="button"><Icon name="close" size={15} /></button>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): { notify: Notify } {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error('useToast must be used inside ToastProvider');
  return { notify };
}
