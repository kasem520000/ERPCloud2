'use client';

import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * Card — the surface every panel, table and dialog body sits on.
 *
 * `variant="plain"` is the flat card used inside dense grids (staff), and
 * `variant="raised"` lifts it with a shadow for floating layers. In dark mode
 * the shadow ladder is already swapped for raised borders + an inner light by
 * the tokens, so nothing here has to know which theme is active.
 */
export type CardProps = HTMLAttributes<HTMLDivElement> & {
  hover?: boolean;
  padded?: boolean;
  variant?: 'plain' | 'raised';
};

export function Card({
  hover = false,
  padded = true,
  variant = 'plain',
  className = '',
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-line bg-surface text-ink',
        variant === 'raised' ? 'shadow-3' : 'shadow-1',
        padded && 'p-4',
        hover &&
          'transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-line-strong hover:shadow-4',
        className,
      )}
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
    <div className={cn('mb-3 flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h3 className="m-0 truncate text-[15px] leading-snug font-bold text-ink">{title}</h3>
        {subtitle ? <p className="m-0 mt-0.5 text-xs text-muted">{subtitle}</p> : null}
      </div>
      {action ? <div className="flex flex-none items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={cn('text-[13.5px] leading-relaxed text-ink-2', className)}>{children}</div>;
}

export function CardFooter({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[12.5px] text-muted',
        className,
      )}
    >
      {children}
    </div>
  );
}
