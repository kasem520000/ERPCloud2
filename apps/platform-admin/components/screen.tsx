'use client';

import type { ReactNode } from 'react';

/**
 * Standard page chrome — v2 (Vercel/Linear): breadcrumbs + 24px title +
 * subtitle + actions, matching the redesigned console pages.
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
            <nav className="flex flex-wrap items-center gap-1.5 text-[11.5px] font-bold text-muted" aria-label="المسار">
              {crumbs.map((crumb, i) => (
                <span key={`${crumb}-${i}`} className="flex items-center gap-1.5">
                  {i > 0 ? <span aria-hidden>‹</span> : null}
                  <span className={i === crumbs.length - 1 ? 'text-ink-2' : undefined}>{crumb}</span>
                </span>
              ))}
            </nav>
          ) : null}
          <h1 className="m-0 mt-1 text-[24px] font-extrabold tracking-tight text-ink leading-tight">{title}</h1>
          {subtitle ? <p className="m-0 mt-1 text-[13px] text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2 no-print">{actions}</div> : null}
      </section>
      {children}
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-4 shadow-1" aria-busy="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="h-4 animate-pulse rounded-md bg-surface-3" style={{ width: `${100 - index * 8}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-4 shadow-1">
      <p className="m-0 flex items-center gap-2 rounded-[10px] border border-danger-line bg-danger-soft px-4 py-2.5 text-[13px] font-semibold text-danger-ink">
        تعذر تحميل البيانات: {message ?? 'خطأ غير معروف'}
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="h-10 rounded-[8px] bg-brand-600 px-4 text-[13.5px] font-bold text-on-accent transition-colors duration-150 hover:bg-brand-700"
          style={{ justifySelf: 'start' }}
        >
          إعادة المحاولة
        </button>
      ) : null}
    </div>
  );
}

export function Forbidden() {
  return (
    <div className="grid place-items-center gap-2 rounded-[10px] border border-line bg-surface p-8 text-center shadow-1">
      <span className="grid size-12 place-items-center rounded-2xl bg-warn-soft text-warn">🔒</span>
      <p className="m-0 text-[15px] font-bold text-ink">لا تملك صلاحية الوصول</p>
      <p className="m-0 max-w-md text-[13px] text-muted">
        اطلب من مشغّل المنصة منحك الدور المطلوب من «المستخدمون والأدوار».
      </p>
    </div>
  );
}

export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="grid place-items-center gap-2 rounded-[10px] border border-line bg-surface p-8 text-center shadow-1">
      <span className="grid size-12 place-items-center rounded-2xl bg-surface-3 text-muted">🗂️</span>
      <p className="m-0 text-[15px] font-bold text-ink">{title}</p>
      {detail ? <p className="m-0 max-w-md text-[13px] text-muted">{detail}</p> : null}
    </div>
  );
}
