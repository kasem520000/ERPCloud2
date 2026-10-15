'use client';

import type { ReactNode } from 'react';

/**
 * M3 — standard page chrome for the accounting app's read-only screens, following the
 * staff panel's `components/screen.tsx` conventions (24px title, subtitle, breadcrumbs).
 */

export function Screen({
  title,
  subtitle,
  crumbs,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  crumbs?: string[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {crumbs && crumbs.length > 0 ? (
            <nav className="flex flex-wrap items-center gap-1.5 text-[12px] font-bold text-muted" aria-label="المسار">
              {crumbs.map((crumb, i) => (
                <span key={`${crumb}-${i}`} className="flex items-center gap-1.5">
                  {i > 0 ? <span aria-hidden>‹</span> : null}
                  <span className={i === crumbs.length - 1 ? 'text-ink-2' : undefined}>{crumb}</span>
                </span>
              ))}
            </nav>
          ) : null}
          <h1 className="m-0 mt-1 text-[24px] font-bold text-ink tracking-tight leading-tight">{title}</h1>
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
