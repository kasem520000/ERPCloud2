'use client';

import { cn } from '../lib/cn';

/**
 * Avatar — initials or image, always on a token background.
 *
 * The generated background is derived from the name so two people never share
 * a colour by accident, and it is drawn from the *fixed* chart palette: an
 * avatar is an identity, not a surface, so it must not flip with the theme.
 */
const PALETTE = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-chart-6',
] as const;

const SIZES = {
  xs: 'size-6 text-[10px]',
  sm: 'size-8 text-[11px]',
  md: 'size-10 text-[13px]',
  lg: 'size-12 text-[15px]',
} as const;

export type AvatarSize = keyof typeof SIZES;

function hash(value: string): number {
  let sum = 0;
  for (let index = 0; index < value.length; index += 1) {
    sum = (sum * 31 + value.charCodeAt(index)) % 997;
  }
  return sum;
}

/** «أحمد الشمري» → «أش»; a Latin name → «AS». */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '؟';
  if (parts.length === 1) return [...parts[0]!.slice(0, 2)].join('');
  return `${[...parts[0]!][0] ?? ''}${[...parts[1]!][0] ?? ''}`;
}

export type AvatarProps = {
  name: string;
  src?: string | null;
  size?: AvatarSize;
  className?: string;
  /** Extra text after the avatar — a name line in a user menu. */
  hint?: string;
};

export function Avatar({ name, src, size = 'md', className = '', hint }: AvatarProps) {
  const color = PALETTE[hash(name) % PALETTE.length];
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {src ? (
        <img
          src={src}
          alt={name}
          className={cn('flex-none rounded-full object-cover', SIZES[size])}
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            'grid flex-none place-items-center rounded-full font-bold text-white select-none',
            SIZES[size],
            color,
          )}
        >
          {initials(name)}
        </span>
      )}
      {hint ? (
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-bold text-ink">{name}</span>
          <span className="block truncate text-[11.5px] text-muted">{hint}</span>
        </span>
      ) : null}
    </span>
  );
}
