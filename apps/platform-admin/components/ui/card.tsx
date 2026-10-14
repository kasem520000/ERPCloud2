'use client';

import type { HTMLAttributes, ReactNode } from 'react';

/**
 * بطاقة النظام — سطح أبيض، حدود slate-200، ظل لينا، ورفع 4px عند التمرير.
 */
export type CardProps = HTMLAttributes<HTMLDivElement> & {
  hover?: boolean;
  padded?: boolean;
};

export function Card({ hover = false, padded = true, className = '', children, ...rest }: CardProps) {
  return (
    <div
      className={`bg-surface border border-line rounded-xl shadow-1 ${padded ? 'p-4' : ''} ${
        hover
          ? 'transition-all duration-150 ease-out hover:-translate-y-1 hover:shadow-4 cursor-default'
          : ''
      } ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 mb-3 ${className}`}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-bold text-ink m-0 leading-snug truncate">{title}</h3>
        {subtitle ? <p className="text-xs text-muted m-0 mt-0.5">{subtitle}</p> : null}
      </div>
      {action ? <div className="flex items-center gap-2 flex-none">{action}</div> : null}
    </div>
  );
}

export function CardFooter({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mt-3 pt-3 border-t border-line flex items-center gap-2 flex-wrap ${className}`}>
      {children}
    </div>
  );
}
