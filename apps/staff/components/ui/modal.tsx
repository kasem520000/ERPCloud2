'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

/**
 * نافذة حوارية / درج جانبي — خلفية ضبابية، والنافذة تكبر من 0.95→1 بينما ينزلق
 * الدراج من الحافة (يمين في RTL). Esc والنقر خارجاً يغلقان.
 */
type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
};

const WIDTHS = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' };

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: ModalProps) {
  useEscape(open, onClose);
  useBodyLock(open);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[70] grid place-items-center p-4 bg-inverse backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            className={`w-full ${WIDTHS[size]} bg-surface rounded-2xl shadow-5 overflow-hidden border border-line`}
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            role="dialog"
            aria-modal="true"
          >
            <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-line">
              <div className="min-w-0">
                <h3 className="m-0 text-[15px] font-bold text-ink">{title}</h3>
                {description ? <p className="m-0 mt-0.5 text-xs text-muted">{description}</p> : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="grid place-items-center size-8 rounded-lg text-muted hover:bg-surface-3 hover:text-ink-2 transition-colors duration-150 flex-none"
                aria-label="إغلاق"
              >
                <X size={17} />
              </button>
            </header>
            <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">{children}</div>
            {footer ? (
              <footer className="px-5 py-3 bg-surface-2 border-t border-line flex items-center justify-start gap-2">
                {footer}
              </footer>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

type DrawerProps = ModalProps & { /** 'end' ينزلق من الحافة النهائية (يسار في RTL). */ side?: 'start' | 'end' };

export function Drawer({ open, onClose, title, description, children, footer, size = 'md', side = 'end' }: DrawerProps) {
  useEscape(open, onClose);
  useBodyLock(open);

  const fromX = side === 'end' ? '-100%' : '100%';

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[70] bg-inverse backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.aside
            className={`absolute inset-y-0 ${side === 'end' ? 'end-0' : 'start-0'} w-full ${
              size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : 'max-w-md'
            } bg-surface shadow-5 border-s border-line flex flex-col`}
            initial={{ opacity: 0.4, x: fromX }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0.4, x: fromX }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            role="dialog"
            aria-modal="true"
          >
            <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line">
              <div className="min-w-0">
                <h3 className="m-0 text-[15px] font-bold text-ink">{title}</h3>
                {description ? <p className="m-0 mt-0.5 text-xs text-muted">{description}</p> : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="grid place-items-center size-8 rounded-lg text-muted hover:bg-surface-3 hover:text-ink-2 transition-colors duration-150 flex-none"
                aria-label="إغلاق"
              >
                <X size={17} />
              </button>
            </header>
            <div className="px-5 py-4 flex-1 overflow-y-auto">{children}</div>
            {footer ? (
              <footer className="px-5 py-3 bg-surface-2 border-t border-line flex items-center justify-start gap-2">
                {footer}
              </footer>
            ) : null}
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

function useBodyLock(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);
}
