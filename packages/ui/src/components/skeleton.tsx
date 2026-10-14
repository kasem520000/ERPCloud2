'use client';

import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn';

/**
 * Skeleton — the loading shape.
 *
 * `bg-surface-3` is a token, so a shimmer on a dark page is a *dark* shimmer
 * rather than a white slab. The pulse is a CSS animation, which means
 * `prefers-reduced-motion` switches it off through the tokens' global rule
 * (Design v3 §4).
 */
export function Skeleton({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('animate-pulse rounded-sm bg-surface-3', className)} aria-hidden {...rest} />
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="grid gap-2.5" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton
          key={index}
          className="h-3.5"
          style={{ width: `${Math.max(40, 100 - index * 9)}%` }}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div
      className="grid gap-3 rounded-lg border border-line bg-surface p-4 shadow-1"
      aria-busy="true"
      aria-live="polite"
    >
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton key={index} className="h-3.5" style={{ width: `${Math.max(30, 92 - index * 14)}%` }} />
      ))}
    </div>
  );
}
