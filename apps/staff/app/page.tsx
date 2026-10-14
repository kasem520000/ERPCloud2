'use client';

import Link from 'next/link';
import {
  CalendarDays,
  FilePlus2,
  LayoutDashboard,
  PackageSearch,
  ReceiptText,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { UserDashboard } from '../components/dashboard/user-dashboard';
import { AreaCardChart, DonutCardChart } from '../components/ui/chart';
import { CountUp, Reveal } from '../components/ui/count-up';
import { EmptyState } from '../components/ui/empty-state';
import { KpiCard } from '../components/ui/kpi-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { Badge } from '../components/ui/badge';
import { useSession } from '../lib/session';
import { money, shortDate } from '../lib/lookups';
import { computeStats, fetchDashboardData, partyName, type DashboardData } from '../lib/dashboard';

function useDashboardData() {
  const [state, setState] = useState<{ status: 'loading' | 'success' | 'error'; data?: DashboardData; error?: string }>({
    status: 'loading',
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchDashboardData()
      .then((data) => !cancelled && setState({ status: 'success', data }))
      .catch((error) =>
        !cancelled &&
        setState({ status: 'error', error: error instanceof Error ? error.message : String(error) }),
      );
    return () => {
      cancelled = true;
    };
  }, [nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

/** Hijri + Gregorian date line for the greeting. */
function dateLine(now = new Date()): { greg: string; hijri: string } {
  const greg = new Intl.DateTimeFormat('ar-SA-u-ca-gregory', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
  let hijri = '';
  try {
    hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(now);
  } catch {
    hijri = '';
  }
  return { greg, hijri };
}

const SAR = (value: number) => money(value);

export default function DashboardPage() {
  const { me, can } = useSession();
  const data = useDashboardData();

  const stats = data.status === 'success' && data.data ? computeStats(data.data) : null;
  const firstName = (me?.user.fullName ?? 'زميلي').split(' ')[0];
  const hour = new Date().getUTCHours();
  const greetingWord = hour < 12 ? 'صباح الخير' : 'مساء الخير';
  const dates = dateLine();

  const todayDelta =
    stats && stats.yesterdaySales > 0 ? ((stats.todaySales - stats.yesterdaySales) / stats.yesterdaySales) * 100 : null;
  const monthDelta =
    stats && stats.lastMonthSales > 0 ? ((stats.monthSales - stats.lastMonthSales) / stats.lastMonthSales) * 100 : null;

  if (data.status === 'error') {
    return (
      <EmptyState
        tone="red"
        icon={<TrendingDown size={30} strokeWidth={1.5} />}
        title="تعذر تحميل بيانات لوحة المتابعة"
        description={data.error}
      />
    );
  }

  return (
    <div className="grid gap-5">
      {/* ---------------------------------------------------- greeting */}
      <Reveal>
        <section className="relative overflow-hidden rounded-2xl border border-line bg-surface p-5 shadow-1">
          {/* dotted grid + gradient wash */}
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none opacity-70"
            style={{
              backgroundImage:
                'radial-gradient(110rem 34rem at 115% -20%, rgb(37 99 235 / 0.10), transparent 55%), radial-gradient(circle, var(--line-strong) 1px, transparent 1px)',
              backgroundSize: 'auto, 18px 18px',
            }}
          />
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="m-0 text-[26px] font-bold text-ink tracking-tight">
                {greetingWord}، {firstName} <span aria-hidden>👋</span>
              </h1>
              <p className="m-0 mt-1 text-[13px] text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays size={14} className="text-brand-600" />
                  {dates.greg}
                </span>
                {dates.hijri ? <span dir="rtl" className="text-muted">· {dates.hijri} هـ</span> : null}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {can('sales.invoice.create') ? (
                <Link
                  href="/sales/invoices/new"
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-[10px] bg-brand-600 border border-brand-600 text-on-accent text-[13.5px] font-semibold shadow-2 hover:bg-brand-700 transition-all duration-150"
                >
                  <FilePlus2 size={16} />
                  فاتورة جديدة
                </Link>
              ) : null}
              {can('sales.view') ? (
                <Link
                  href="/sales/invoices"
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-[10px] bg-surface border border-line-strong text-ink-2 text-[13.5px] font-semibold shadow-1 hover:bg-surface-2 transition-all duration-150"
                >
                  <ReceiptText size={16} />
                  كل الفواتير
                </Link>
              ) : null}
              <Link
                href="/reports/sales"
                className="inline-flex items-center gap-2 h-10 px-4 rounded-[10px] bg-surface border border-line-strong text-ink-2 text-[13.5px] font-semibold shadow-1 hover:bg-surface-2 transition-all duration-150"
              >
                <TrendingUp size={16} />
                تقارير المبيعات
              </Link>
              {can('dashboards.view') ? (
                <Link
                  href="/dashboards"
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-[10px] bg-surface border border-line-strong text-ink-2 text-[13.5px] font-semibold shadow-1 hover:bg-surface-2 transition-all duration-150"
                >
                  <LayoutDashboard size={16} />
                  لوحاتي
                </Link>
              ) : null}
            </div>
          </div>
        </section>
      </Reveal>

      <UserDashboard />

      {/* -------------------------------------------------------- KPIs */}
      {data.status === 'loading' ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : stats ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            title="مبيعات اليوم"
            value={<CountUp value={stats.todaySales} format={SAR} />}
            icon={<Wallet size={21} />}
            tone="blue"
            delta={todayDelta}
            deltaLabel="مقارنةً بالأمس"
            spark={stats.weekSpark}
            delay={0}
          />
          <KpiCard
            title={`مبيعات ${new Intl.DateTimeFormat('ar', { month: 'long' }).format(new Date())}`}
            value={<CountUp value={stats.monthSales} format={SAR} />}
            icon={<ShoppingCart size={21} />}
            tone="green"
            delta={monthDelta}
            deltaLabel="عن الشهر السابق"
            spark={[stats.lastMonthSales, stats.monthSales]}
            delay={0.1}
          />
          <KpiCard
            title="ذمم مدينة (فواتير غير مسددة)"
            value={<CountUp value={stats.receivable} format={SAR} />}
            icon={<TrendingUp size={21} />}
            tone="amber"
            hint={`${stats.overdueInvoices} فاتورة لدى ${stats.overdueCustomers} عميل`}
            delay={0.2}
          />
          <KpiCard
            title="أصناف تحت الحد الأدنى"
            value={<CountUp value={stats.lowStockCount} />}
            icon={<PackageSearch size={21} />}
            tone={stats.lowStockCount > 0 ? 'red' : 'slate'}
            hint={`${stats.nearExpiryCount} صنف قريب من الانتهاء`}
            delay={0.3}
          />
        </div>
      ) : null}

      {/* ------------------------------------------------------ charts */}
      <div className="grid gap-4 grid-cols-1 xl:grid-cols-5">
        <Reveal delay={0.15} className="xl:col-span-3">
          <section className="rounded-xl border border-line bg-surface p-4 shadow-1 h-full">
            <header className="flex items-start justify-between gap-3 mb-2">
              <div>
                <h3 className="m-0 text-[15px] font-bold text-ink">مبيعات آخر 7 أيام</h3>
                <p className="m-0 mt-0.5 text-xs text-muted">إجمالي الفواتير المرحّلة (بالريال السعودي)</p>
              </div>
              <Badge tone="blue" dot>
                {stats ? `${stats.week.reduce((sum, day) => sum + day.count, 0)} فاتورة` : '…'}
              </Badge>
            </header>
            {data.status === 'loading' ? (
              <SkeletonCard lines={5} />
            ) : stats ? (
              <AreaCardChart data={stats.week} xKey="label" dataKey="total" formatter={SAR} name="المبيعات" height={264} />
            ) : null}
          </section>
        </Reveal>

        <Reveal delay={0.25} className="xl:col-span-2">
          <section className="rounded-xl border border-line bg-surface p-4 shadow-1 h-full">
            <header className="flex items-start justify-between gap-3 mb-2">
              <div>
                <h3 className="m-0 text-[15px] font-bold text-ink">المبيعات حسب الفرع</h3>
                <p className="m-0 mt-0.5 text-xs text-muted">توزيع الإيراد على الفروع</p>
              </div>
            </header>
            {data.status === 'loading' ? (
              <SkeletonCard lines={5} />
            ) : stats && stats.branchTotals.length > 0 ? (
              <DonutCardChart
                data={stats.branchTotals.map((entry) => ({ name: entry.label, value: entry.total }))}
                formatter={SAR}
                centerValue={money(stats.branchTotals.reduce((sum, entry) => sum + entry.total, 0))}
                centerLabel="الإجمالي"
                height={210}
              />
            ) : (
              <EmptyState
                tone="slate"
                icon={<ReceiptText size={28} strokeWidth={1.5} />}
                title="لا توجد مبيعات مرحّلة بعد"
                description="عندما تُرحَّل أول فاتورة سيظهر توزيعها على الفروع هنا."
              />
            )}
          </section>
        </Reveal>
      </div>

      {/* ------------------------------------------------ mini tables */}
      <div className="grid gap-4 grid-cols-1 xl:grid-cols-2">
        <Reveal delay={0.3}>
          <section className="rounded-xl border border-line bg-surface shadow-1">
            <header className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
              <h3 className="m-0 text-[15px] font-bold text-ink">أحدث الفواتير</h3>
              <Link href="/sales/invoices" className="text-[12.5px] font-bold text-brand-600 hover:text-brand-700">
                عرض الكل ←
              </Link>
            </header>
            {data.status === 'loading' ? (
              <div className="p-4">
                <SkeletonCard lines={4} />
              </div>
            ) : stats && stats.lastInvoices.length > 0 ? (
              <ul className="m-0 list-none p-0 divide-y divide-line">
                {stats.lastInvoices.map((invoice) => (
                  <li key={invoice.id}>
                    <Link
                      href={`/sales/invoices/${invoice.id}`}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 transition-colors duration-150"
                    >
                      <span className="grid place-items-center size-9 rounded-lg bg-info-soft text-brand-600 flex-none">
                        <ReceiptText size={16} />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-bold text-ink truncate" dir="ltr">
                          {invoice.number ?? 'مسودة'}
                        </span>
                        <span className="block text-[11.5px] text-muted truncate">
                          {data.data ? partyName(invoice, data.data.parties) : '—'} · {shortDate(invoice.postedAt ?? invoice.createdAt)}
                        </span>
                      </span>
                      <span className="text-[13px] font-bold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {money(invoice.total)}
                      </span>
                      <Badge tone={invoice.paymentStatus === 'paid' ? 'green' : 'amber'} status={invoice.paymentStatus}>
                        {invoice.paymentStatus === 'paid' ? 'مسدّدة' : 'غير مسدّدة'}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4">
                <EmptyState
                  tone="slate"
                  icon={<ReceiptText size={28} strokeWidth={1.5} />}
                  title="لا توجد فواتير بعد"
                  description="ابدأ بإصدار أول فاتورة مبيعات."
                />
              </div>
            )}
          </section>
        </Reveal>

        <Reveal delay={0.4}>
          <section className="rounded-xl border border-line bg-surface shadow-1">
            <header className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
              <h3 className="m-0 text-[15px] font-bold text-ink">أصناف تحت الحد الأدنى</h3>
              <Link href="/inventory/below-minimum" className="text-[12.5px] font-bold text-brand-600 hover:text-brand-700">
                عرض الكل ←
              </Link>
            </header>
            {data.status === 'loading' ? (
              <div className="p-4">
                <SkeletonCard lines={4} />
              </div>
            ) : data.data && data.data.lowStock.length > 0 ? (
              <ul className="m-0 list-none p-0 divide-y divide-line">
                {data.data.lowStock.slice(0, 5).map((row) => (
                  <li key={`${row.itemId}-${row.warehouseId}`} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="grid place-items-center size-9 rounded-lg bg-danger-soft text-danger flex-none">
                      <PackageSearch size={16} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-bold text-ink truncate">{row.nameAr}</span>
                      <span className="block text-[11.5px] text-muted truncate" dir="ltr">
                        {row.sku}
                      </span>
                    </span>
                    <span className="text-[12px] text-muted font-semibold">
                      المتاح <b className="text-danger">{row.quantity}</b> / الحد {row.minQty}
                    </span>
                    <Badge tone="red" dot>
                      ناقص {row.shortage}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4">
                <EmptyState
                  tone="green"
                  icon={<PackageSearch size={28} strokeWidth={1.5} />}
                  title="المخزون ضمن الحدود"
                  description="لا توجد أصناف تحت الحد الأدنى حالياً."
                />
              </div>
            )}
          </section>
        </Reveal>
      </div>
    </div>
  );
}
