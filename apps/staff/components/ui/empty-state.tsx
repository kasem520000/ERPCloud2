'use client';

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * حالة فارغة — أيقونة 64px في مربع ملوّن، عنوان، وصف، وزر إجراء اختياري.
 */
export type EmptyStateProps = {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: 'blue' | 'green' | 'amber' | 'red' | 'slate';
};

const TONES = {
  blue: 'bg-info-soft text-info',
  green: 'bg-ok-soft text-ok',
  amber: 'bg-warn-soft text-warn',
  red: 'bg-danger-soft text-danger',
  slate: 'bg-surface-3 text-muted',
} as const;

export function EmptyState({ icon, title, description, action, tone = 'slate' }: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="grid place-items-center gap-3 py-14 px-6 text-center rounded-xl border border-dashed border-line-strong bg-surface-2"
    >
      <span className={`grid place-items-center size-16 rounded-2xl ${TONES[tone]}`} aria-hidden>
        {icon}
      </span>
      <div>
        <h3 className="m-0 text-[15px] font-bold text-ink">{title}</h3>
        {description ? <p className="m-0 mt-1 text-[13px] text-muted max-w-sm mx-auto">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </motion.div>
  );
}
