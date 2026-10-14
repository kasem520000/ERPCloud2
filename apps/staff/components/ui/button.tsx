'use client';

import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * زر واحد لكل الحالات — 5 variants × 3 sizes, with loading state and an icon slot.
 * The button is a flex row so RTL flips icon/label order automatically.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-on-accent border-brand-600 shadow-2 hover:bg-brand-700 hover:border-brand-700',
  secondary:
    'bg-surface text-ink-2 border-line-strong shadow-1 hover:bg-surface-2 hover:border-line-strong',
  ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-surface-3 hover:text-ink',
  danger: 'bg-surface text-danger border-danger-line hover:bg-danger-soft hover:border-danger-line',
  success: 'bg-ok text-on-accent border-ok shadow-2 hover:brightness-110',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[12.5px] rounded-lg gap-1.5',
  md: 'h-10 px-4 text-[13.5px] rounded-[10px] gap-2',
  lg: 'h-12 px-6 text-[15px] rounded-xl gap-2',
};

export function Spinner({ size = 15 }: { size?: number }) {
  return <LoaderCircle size={size} className="animate-spin" aria-hidden />;
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Icon rendered before the label (flips in RTL automatically). */
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
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center font-semibold whitespace-nowrap border transition-all duration-150 ease-out active:translate-y-px focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-600/20 disabled:opacity-55 disabled:cursor-not-allowed disabled:active:translate-y-0 ${VARIANTS[variant]} ${SIZES[size]} ${block ? 'w-full' : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}
