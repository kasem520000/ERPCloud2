'use client';

import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * Button — the one button for all three surfaces.
 *
 * Design v3 §5: five variants, three sizes, a loading state, and a `disabled`
 * state that stays on screen greyed rather than disappearing (the desktop's
 * "disabled, never hidden" rule, carried into the cloud).
 *
 * Every colour comes from the semantic tokens, so the same class list paints
 * correctly on white and on slate-950. The button is a flex row, which means
 * RTL flips icon/label order with no extra code.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-ink border-brand shadow-2 hover:brightness-110 active:brightness-95',
  secondary:
    'bg-surface text-ink border-line-strong shadow-1 hover:bg-surface-3 hover:border-line-raised',
  ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-surface-3 hover:text-ink',
  danger: 'bg-surface text-danger border-danger-line hover:bg-danger-soft hover:border-danger',
  success: 'bg-ok text-white border-ok shadow-2 hover:brightness-110',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[12.5px] rounded-sm gap-1.5',
  md: 'h-9 px-4 text-[13.5px] rounded-md gap-2',
  lg: 'h-11 px-5 text-[15px] rounded-lg gap-2',
};

/** The spinner, exported so a table cell or a drawer footer can reuse it. */
export function Spinner({ size = 15, className }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} className={cn('animate-spin', className)} aria-hidden />;
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows the spinner and blocks every interaction — the button stays visible. */
  loading?: boolean;
  /** Icon rendered before the label; flips with RTL automatically. */
  icon?: ReactNode;
  block?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  block = false,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center border font-semibold whitespace-nowrap',
        'transition-[filter,background-color,border-color,box-shadow] duration-150 ease-out',
        'focus-visible:ring-4 focus-visible:ring-brand/25 focus-visible:border-brand',
        'disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}
