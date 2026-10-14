'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * توست خفيف — موفر سياق + `useToast()`، تظهر أسفل (يمين في RTL) وتنزلق بـ framer-motion.
 */
export type ToastKind = 'success' | 'error' | 'info' | 'warning';

type ToastItem = { id: number; kind: ToastKind; title: string; description?: string };

type ToastContextValue = {
  toast: (kind: ToastKind, title: string, description?: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const ICONS: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 size={19} className="text-ok" />,
  error: <XCircle size={19} className="text-danger" />,
  info: <Info size={19} className="text-info" />,
  warning: <TriangleAlert size={19} className="text-warn" />,
};

const BORDERS: Record<ToastKind, string> = {
  success: 'border-s-emerald-500',
  error: 'border-s-red-500',
  info: 'border-s-blue-500',
  warning: 'border-s-amber-500',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);

  const toast = useCallback(
    (kind: ToastKind, title: string, description?: string) => {
      const id = nextId.current++;
      setItems((current) => [...current.slice(-3), { id, kind, title, description }]);
      window.setTimeout(() => dismiss(id), 4600);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed z-[90] bottom-4 end-4 flex flex-col gap-2 w-[min(22rem,calc(100vw-2rem))]" dir="rtl">
        <AnimatePresence>
          {items.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className={`flex items-start gap-2.5 rounded-xl border border-line border-s-4 bg-surface px-3.5 py-3 shadow-4 ${BORDERS[item.kind]}`}
              role="status"
            >
              <span className="mt-0.5 flex-none">{ICONS[item.kind]}</span>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[13px] font-bold text-ink">{item.title}</p>
                {item.description ? <p className="m-0 mt-0.5 text-[12px] text-muted">{item.description}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="grid place-items-center size-6 rounded-md text-muted hover:bg-surface-3 hover:text-ink-2 flex-none"
                aria-label="إغلاق"
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
