'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * Modal and Drawer — the two overlays.
 *
 * Both share one focus contract:
 *   • focus moves inside on open and returns to the opener on close;
 *   • `Tab` cycles within the panel (a dialog that leaks focus to the page
 *     behind it is a broken dialog);
 *   • `Escape` closes, unless the caller marks the overlay `persistent`
 *     (used for destructive confirmations that must be answered);
 *   • the page behind never scrolls.
 *
 * The backdrop and panel are token-coloured, so both read correctly on white
 * and on slate-950.
 */

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Refuse `Escape` and a backdrop click — for destructive confirmations. */
  persistent?: boolean;
  className?: string;
  labelClose?: string;
};

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const;

function useOverlay(open: boolean, onClose: () => void, persistent: boolean) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  const focusables = useCallback((): HTMLElement[] => {
    const root = panelRef.current;
    if (!root) return [];
    return [
      ...root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.offsetParent !== null);
  }, []);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const first = focusables()[0] ?? panelRef.current;
    first?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (persistent) return;
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      } else if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open, onClose, persistent, focusables]);

  return panelRef;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  persistent = false,
  className = '',
  labelClose = 'إغلاق',
}: ModalProps) {
  const titleId = useId();
  const panelRef = useOverlay(open, onClose, persistent);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
          <motion.div
            className="fixed inset-0 bg-slate-950/45 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={persistent ? undefined : onClose}
            aria-hidden
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'relative z-10 w-full rounded-xl border border-line bg-raised p-5 shadow-5',
              SIZES[size],
              className,
            )}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id={titleId} className="m-0 text-[17px] font-bold text-ink">
                  {title}
                </h2>
                {description ? (
                  <p className="m-0 mt-1 text-[13px] leading-relaxed text-muted">{description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={labelClose}
                className="grid size-8 flex-none place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-3 hover:text-ink"
              >
                <X size={16} />
              </button>
            </div>
            <div className="text-[13.5px] leading-relaxed text-ink-2">{children}</div>
            {footer ? (
              <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
                {footer}
              </div>
            ) : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

export type DrawerProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
  persistent?: boolean;
  className?: string;
  labelClose?: string;
};

/**
 * Drawer — slides in from the inline-end edge, which is the *right* edge in
 * Arabic and the left edge in English. `inset-inline-end` is a logical
 * property, so the same class list serves both directions (Design v3 §4).
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-md',
  persistent = false,
  className = '',
  labelClose = 'إغلاق',
}: DrawerProps) {
  const titleId = useId();
  const panelRef = useOverlay(open, onClose, persistent);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50">
          <motion.div
            className="absolute inset-0 bg-slate-950/45 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={persistent ? undefined : onClose}
            aria-hidden
          />
          <motion.aside
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'absolute inset-y-0 end-0 flex w-full flex-col border-s border-line bg-raised shadow-5',
              width,
              className,
            )}
          >
            <header className="flex items-start justify-between gap-3 border-b border-line p-5">
              <div className="min-w-0">
                <h2 id={titleId} className="m-0 text-[16px] font-bold text-ink">
                  {title}
                </h2>
                {description ? (
                  <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted">{description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={labelClose}
                className="grid size-8 flex-none place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-3 hover:text-ink"
              >
                <X size={16} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto p-5 text-[13.5px] leading-relaxed text-ink-2">
              {children}
            </div>
            {footer ? (
              <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line p-4">
                {footer}
              </footer>
            ) : null}
          </motion.aside>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * ConfirmDialog — every destructive action in platform-admin goes through a
 * modal that asks for a reason or a confirmation word (Design v3 §6.2). It is
 * `persistent` by default so an accidental click cannot delete a tenant.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'تأكيد',
  cancelLabel = 'إلغاء',
  /** When set, the confirm button stays disabled until the visitor types it. */
  confirmWord,
  tone = 'danger',
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmWord?: string;
  tone?: 'danger' | 'brand';
  loading?: boolean;
}) {
  const [reason, setReason] = useReasonState(open);
  const confirmed = !confirmWord || reason.trim() === confirmWord;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      persistent
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-line-strong bg-surface px-4 text-[13px] font-bold text-ink transition-colors duration-150 hover:bg-surface-3"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={!confirmed || loading}
            onClick={() => onConfirm(reason.trim())}
            className={cn(
              'h-9 rounded-md border px-4 text-[13px] font-bold text-white shadow-2 transition-[filter] duration-150',
              'disabled:cursor-not-allowed disabled:opacity-55',
              tone === 'danger' ? 'border-danger bg-danger' : 'border-brand bg-brand',
            )}
          >
            {loading ? '…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        {confirmWord ? (
          <p className="m-0 text-[13px] text-ink-2">
            اكتب <span className="font-bold text-ink">«{confirmWord}»</span> للتأكيد.
          </p>
        ) : null}
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-bold text-ink-2">السبب</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            className="w-full rounded-md border border-line-strong bg-surface p-2.5 text-[13px] text-ink placeholder:text-muted focus:border-brand focus:ring-4 focus:ring-brand/20 focus:outline-none"
            placeholder="سبب الإجراء — يُسجَّل في سجل التدقيق"
          />
        </label>
      </div>
    </Modal>
  );
}

/** Local state that resets whenever the dialog is (re)opened. */
function useReasonState(open: boolean): [string, (value: string) => void] {
  const [reason, setReason] = useState('');
  const wasOpen = useRef(open);
  if (open !== wasOpen.current) {
    wasOpen.current = open;
    if (open) setReason('');
  }
  return [reason, setReason];
}
