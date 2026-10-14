'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { cn } from '../lib/cn';

/**
 * Toast — the one notification channel.
 *
 * Toasts are rendered into a portal-free fixed layer inside the provider, so
 * they inherit the `.dark` class from `<html>` like everything else and never
 * need their own colour logic. `role="status"` for success/info and
 * `role="alert"` for danger means a screen reader announces them without the
 * visitor having to hunt.
 */

export type ToastTone = 'success' | 'info' | 'warning' | 'danger';

export type Toast = {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  /** Milliseconds before it disappears; `0` keeps it until dismissed. */
  duration?: number;
};

const TONE_STYLE: Record<ToastTone, { box: string; icon: ReactNode }> = {
  success: {
    box: 'border-ok-line bg-ok-soft text-ok-ink',
    icon: <CheckCircle2 size={17} className="text-ok" aria-hidden />,
  },
  info: {
    box: 'border-info-line bg-info-soft text-info-ink',
    icon: <Info size={17} className="text-info" aria-hidden />,
  },
  warning: {
    box: 'border-warn-line bg-warn-soft text-warn-ink',
    icon: <AlertTriangle size={17} className="text-warn" aria-hidden />,
  },
  danger: {
    box: 'border-danger-line bg-danger-soft text-danger-ink',
    icon: <XCircle size={17} className="text-danger" aria-hidden />,
  },
};

type ToastContextValue = {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      counter += 1;
      const id = `toast-${counter}`;
      const duration = toast.duration ?? (toast.tone === 'danger' ? 7000 : 4000);
      setToasts((current) => [...current.slice(-3), { ...toast, id, duration }]);
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4"
        aria-live="polite"
        aria-atomic="false"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              role={toast.tone === 'danger' ? 'alert' : 'status'}
              className={cn(
                'pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border p-3 shadow-4 backdrop-blur',
                TONE_STYLE[toast.tone].box,
              )}
            >
              <span className="mt-px flex-none">{TONE_STYLE[toast.tone].icon}</span>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[13px] font-bold">{toast.title}</p>
                {toast.description ? (
                  <p className="m-0 mt-0.5 text-[12px] leading-relaxed opacity-90">
                    {toast.description}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="إغلاق التنبيه"
                className="grid size-6 flex-none place-items-center rounded-sm opacity-70 transition-opacity duration-150 hover:opacity-100"
              >
                <X size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
