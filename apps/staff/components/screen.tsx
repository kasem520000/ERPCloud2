'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { findScreenByHref } from '../lib/navigation';

/**
 * Standard page chrome — v2: breadcrumbs + 24px title + subtitle + actions,
 * matching the redesigned pages (dashboard / invoices / reports).
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
        {actions ? <div className="flex flex-wrap items-center gap-2 no-print">{actions}</div> : null}
      </section>
      {children}
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div
      className="rounded-xl border border-line bg-surface p-4 shadow-1 grid gap-3"
      aria-busy="true"
    >
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-4 rounded-md bg-surface-3 animate-pulse"
          style={{ width: `${100 - index * 8}%` }}
        />
      ))}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-1 grid gap-3">
      <p className="m-0 flex items-center gap-2 rounded-xl border border-danger-line bg-danger-soft px-4 py-2.5 text-[13px] font-semibold text-danger-ink">
        تعذر تحميل البيانات: {message ?? 'خطأ غير معروف'}
      </p>
      {onRetry ? (
        <button
          className="h-10 px-4 rounded-[10px] bg-brand-600 text-on-accent text-[13.5px] font-bold hover:bg-brand-700 transition-colors duration-150"
          type="button"
          onClick={onRetry}
          style={{ justifyContent: 'flex-start' }}
        >
          إعادة المحاولة
        </button>
      ) : null}
    </div>
  );
}

export function Forbidden() {
  return (
    <div className="rounded-xl border border-line bg-surface p-8 shadow-1 grid place-items-center text-center gap-2">
      <span className="grid place-items-center size-12 rounded-2xl bg-warn-soft text-warn">🔒</span>
      <p className="m-0 text-[15px] font-bold text-ink">لا تملك صلاحية الوصول</p>
      <p className="m-0 text-[13px] text-muted max-w-md">
        اطلب من مالك الحساب منحك الصلاحية المطلوبة من «صلاحيات المستخدمين».
      </p>
    </div>
  );
}

export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-8 shadow-1 grid place-items-center text-center gap-2">
      <span className="grid place-items-center size-12 rounded-2xl bg-surface-3 text-muted">🗂️</span>
      <p className="m-0 text-[15px] font-bold text-ink">{title}</p>
      {detail ? <p className="m-0 text-[13px] text-muted max-w-md">{detail}</p> : null}
    </div>
  );
}

/**
 * Placeholder for a screen that exists in the menu tree but is not built yet.
 * It never fakes data: it states the status and names the endpoint it will consume,
 * so the roadmap is visible instead of hidden behind a dummy table.
 */
export function ScreenScaffold({ href }: { href: string }) {
  const item = findScreenByHref(href);

  if (!item) {
    return (
      <Screen title="شاشة غير معروفة" subtitle={href}>
        <Empty title="هذه الشاشة غير مسجلة في شجرة النظام" detail="تحقق من الرابط أو ارجع للرئيسية." />
        <Link className="btn" href="/">
          الرئيسية
        </Link>
      </Screen>
    );
  }

  return (
    <Screen
      title={item.labelAr}
      subtitle={item.labelEn}
      crumbs={[item.moduleLabelAr, item.groupLabelAr]}
      actions={
        <Link className="btn" href="/">
          الرئيسية
        </Link>
      }
    >
      <div className="rounded-xl border border-line bg-surface p-4 shadow-1">
        <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-bold ${
              item.status === 'api' ? 'bg-ok-soft text-ok-ink' : 'bg-warn-soft text-warn-ink'
            }`}
          >
            {item.status === 'api' ? 'الواجهة البرمجية جاهزة — الشاشة قيد التنفيذ' : 'قيد التطوير'}
          </span>
        </div>
        {item.status === 'api' ? (
          <p className="m-0 text-[13.5px] text-ink-2">
            منطق هذه الشاشة موجود بالفعل في الخادم ويمكن استدعاؤه الآن عبر المسار أدناه؛ ما ينقص هو واجهة
            الإدخال والعرض.
          </p>
        ) : (
          <p className="m-0 text-[13.5px] text-ink-2">
            هذه الشاشة مدرجة في خطة النظام ولم تُنفذ بعد، لا في الواجهة ولا في الخادم.
          </p>
        )}
        {item.endpoint ? (
          <dl className="grid gap-1.5 mt-3 text-[13px]">
            <dt className="text-muted font-bold">المسار البرمجي</dt>
            <dd className="m-0 font-bold text-ink" dir="ltr">
              {item.endpoint}
            </dd>
            {item.permission ? (
              <>
                <dt className="text-muted font-bold">الصلاحية</dt>
                <dd className="m-0 font-bold text-ink" dir="ltr">
                  {item.permission}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </div>
    </Screen>
  );
}
