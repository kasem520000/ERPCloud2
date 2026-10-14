'use client';

import { motion } from 'framer-motion';
import { useId } from 'react';

/**
 * تبويبات بخط سفلي متحرك — خط أزرق ينزلق بسلاسة تحت التبويب النشط (layoutId).
 */
export type TabItem = { key: string; label: React.ReactNode; badge?: number | string };

export function Tabs({
  items,
  value,
  onChange,
  className = '',
}: {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  const base = useId();

  return (
    <div className={`relative border-b border-line flex gap-1 overflow-x-auto ${className}`} role="tablist">
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`${base}-tab-${item.key}`}
            aria-selected={active}
            onClick={() => onChange(item.key)}
            className={`relative px-3.5 py-2.5 text-[13.5px] font-semibold whitespace-nowrap transition-colors duration-150 flex items-center gap-1.5 ${
              active ? 'text-brand-700' : 'text-muted hover:text-ink'
            }`}
          >
            {item.label}
            {item.badge !== undefined ? (
              <span
                className={`min-w-5 h-5 px-1.5 grid place-items-center rounded-full text-[10.5px] font-bold ${
                  active ? 'bg-brand-600 text-on-accent' : 'bg-surface-3 text-muted'
                }`}
              >
                {item.badge}
              </span>
            ) : null}
            {active ? (
              <motion.span
                layoutId={`${base}-underline`}
                className="absolute inset-x-2 -bottom-px h-[2.5px] rounded-full bg-brand-600"
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
