import type { HTMLAttributes } from 'react';

/**
 * هيكل تحميل بلمعان (shimmer) — نفس حركة الـ skeleton القديم لكن كأداة Tailwind.
 */
export function Skeleton({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`animate-pulse rounded-md bg-surface-3 ${className}`}
      aria-hidden
      {...rest}
    />
  );
}

export function SkeletonRows({ rows = 4, width = '100%' }: { rows?: number; width?: string }) {
  return (
    <div className="grid gap-2.5" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} style={{ width: `${100 - i * 9}%`, maxWidth: width }} className="h-3.5" />
      ))}
    </div>
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-1 grid gap-3" aria-busy="true">
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: `${92 - i * 12}%` }} />
      ))}
    </div>
  );
}
