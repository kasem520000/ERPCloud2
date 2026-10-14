'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useState, type ReactNode } from 'react';

/**
 * تلميح خفيف — يظهر فوق العنصر بعد توقف المؤشر 120ms، بأسهم و انزلاق ناعم.
 */
export type TooltipSide = 'top' | 'bottom' | 'start' | 'end';

const POSITIONS: Record<TooltipSide, string> = {
  top: 'bottom-full start-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full start-1/2 -translate-x-1/2 mt-1.5',
  start: 'end-full top-1/2 -translate-y-1/2 me-1.5',
  end: 'start-full top-1/2 -translate-y-1/2 ms-1.5',
};

const ARROWS: Record<TooltipSide, string> = {
  top: 'top-full start-1/2 -translate-x-1/2 -mt-1 rotate-45',
  bottom: 'bottom-full start-1/2 -translate-x-1/2 -mb-1 rotate-45',
  start: 'start-full top-1/2 -translate-y-1/2 -ms-1 rotate-45',
  end: 'end-full top-1/2 -translate-y-1/2 -me-1 rotate-45',
};

export function Tooltip({
  label,
  side = 'top',
  children,
  disabled = false,
}: {
  label: ReactNode;
  side?: TooltipSide;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (disabled) return <>{children}</>;

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      <AnimatePresence>
        {open ? (
          <motion.span
            role="tooltip"
            initial={{ opacity: 0, scale: 0.94, y: side === 'top' ? 3 : side === 'bottom' ? -3 : 0 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className={`absolute z-[80] whitespace-nowrap rounded-lg bg-inverse px-2.5 py-1.5 text-[11.5px] font-semibold text-on-accent shadow-4 pointer-events-none ${POSITIONS[side]}`}
          >
            {label}
            <span aria-hidden className={`absolute size-2 bg-inverse ${ARROWS[side]}`} />
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
