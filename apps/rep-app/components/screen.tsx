'use client';

import type { ReactNode } from 'react';

/**
 * M5 — standard page chrome for the rep app's screens, following the accounting app's
 * `components/screen.tsx` conventions (M3): 24px title, subtitle, breadcrumbs — trimmed
 * for a phone viewport (no horizontal actions row; actions render inline under titles).
 */

export function Screen({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="m-0 text-[22px] font-bold text-ink tracking-tight leading-tight">{title}</h1>
          {subtitle ? <p className="m-0 mt-1 text-[13px] text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </section>
      {children}
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="muted" style={{ padding: '10px 4px' }}>
          …
        </div>
      ))}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="card" role="alert">
      <strong>تعذر تحميل البيانات</strong>
      <p className="muted small">{message ?? ''}</p>
      {onRetry ? (
        <button type="button" className="btn sm" onClick={onRetry}>
          إعادة المحاولة
        </button>
      ) : null}
    </div>
  );
}

export function Forbidden({ message }: { message?: string }) {
  return (
    <div className="card" role="alert">
      <strong>صلاحية غير كافية</strong>
      <p className="muted small">{message ?? 'لا تملك صلاحية عرض هذه الشاشة.'}</p>
    </div>
  );
}

export function Empty({ hint }: { hint?: string }) {
  return (
    <div className="card muted" style={{ textAlign: 'center', padding: '28px' }}>
      {hint ?? 'لا توجد بيانات لعرضها.'}
    </div>
  );
}
