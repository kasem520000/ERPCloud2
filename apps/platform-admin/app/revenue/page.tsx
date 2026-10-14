'use client';

import {
  AlertTriangle,
  BadgeDollarSign,
  CalendarClock,
  CircleDollarSign,
  RefreshCw,
  Timer,
  TrendingUp,
  Wallet,
} from 'lucide-react';

import { Screen } from '../../components/screen';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { AreaCardChart } from '../../components/ui/chart';
import { Reveal } from '../../components/ui/count-up';
import { EmptyState } from '../../components/ui/empty-state';
import { MetricCard } from '../../components/ui/metric-card';
import { SkeletonRows } from '../../components/ui/skeleton';
import { Table } from '../../components/ui/table';
import { apiData } from '../../lib/api';
import { useQuery } from '../../lib/use-query';

/**
 * لوحة الإيراد — شاشة يطلبها P-C4 («revenue dashboard: MRR · ARR · المتأخّر»).
 *
 * التعريفات مثبَّتة في العقود لا في الشاشة، لأن الرقم الذي لا تعريف له لا يُدار:
 *
 * * **MRR** = مجموع المكافئ الشهري للتراخيص المتعاقَدة (`active` · `past_due`). الباقة السنوية
 *   تدخل بمكافئها الشهري (4990 سنوياً = 415.83 شهرياً)، والتجربة والموقوف مؤقتاً ليسا إيراداً.
 * * **ARR** = `MRR × 12`.
 * * **المتأخّر** = غير المسدَّد على فاتورة صادرة تجاوزت تاريخ استحقاقها، و**غير المسدَّد** كله
 *   يُعرض بجانبه لأن ما استحقّ اليوم سيصير متأخّراً غداً.
 * * **المحصَّل هذا الشهر** = مجموع الدفعات المسجَّلة منذ بداية الشهر.
 *
 * ولا تُجمَع عملتان: حين تحمل الباقات أكثر من عملة يظهر وسم «عملات مختلطة» — جمع الريال
 * بالدولار بلا سعر صرف رقمٌ كاذب.
 */

type Revenue = {
  currency: string;
  mrr: string;
  arr: string;
  outstanding: string;
  overdue: string;
  overdueCount: number;
  mixedCurrency: boolean;
  collectedThisMonth: string;
  counts: { active: number; trialing: number; pastDue: number; paused: number; canceled: number };
  upcoming: Array<{
    invoiceId: string;
    number: string | null;
    tenantName: string;
    dueDate: string | null;
    total: string;
    remaining: string;
    daysOverdue: number;
  }>;
};

type MrrSeries = Array<{ month: string; mrr: string }>;

const gregDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString('ar-SA-u-ca-gregory', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';

const monthLabel = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, 1));
  return d.toLocaleDateString('ar-SA-u-ca-gregory', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

const num = (value: string) => Number(value) || 0;

export default function RevenuePage() {
  const revenue = useQuery<Revenue>(() => apiData<Revenue>('/platform/revenue'), []);
  const series = useQuery<{ mrrSeries: MrrSeries }>(() => apiData<{ mrrSeries: MrrSeries }>('/platform/analytics/overview?months=12'), []);

  const data = revenue.data;
  const currency = data?.currency ?? 'SAR';
  const fmt = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const upcomingRows = data?.upcoming ?? [];

  return (
    <Screen
      title="الإيراد"
      subtitle="الإيراد المتكرّر والمتأخّر: أرقام شهرية واحدة، بتعريف مكتوب."
      crumbs={['المنصة', 'العملاء والتراخيص']}
      actions={
        <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => { revenue.reload(); series.reload(); }}>
          تحديث
        </Button>
      }
    >
      {revenue.status === 'loading' ? (
        <div className="rounded-[10px] border border-line bg-surface p-4 shadow-1">
          <SkeletonRows rows={6} />
        </div>
      ) : revenue.status === 'error' ? (
        <EmptyState tone="red" icon={<Wallet size={26} strokeWidth={1.5} />} title="تعذر تحميل الإيراد" description={revenue.error} />
      ) : data ? (
        <>
          {/* top metrics */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard
              label="MRR — شهري متكرر"
              value={num(data.mrr)}
              suffix={currency}
              tone="violet"
              icon={<CircleDollarSign size={16} />}
              hint="الفعّال + المتأخّر (ما زال متعاقداً)"
            />
            <MetricCard
              label="ARR — سنوي متكرر"
              value={num(data.arr)}
              suffix={currency}
              tone="sky"
              icon={<TrendingUp size={16} />}
              hint="MRR × 12"
              delay={0.05}
            />
            <MetricCard
              label="المتأخّر"
              value={num(data.overdue)}
              suffix={currency}
              tone={num(data.overdue) > 0 ? 'red' : 'green'}
              icon={<Timer size={16} />}
              hint={data.overdueCount > 0 ? `${data.overdueCount} فاتورة متجاوزة الاستحقاق` : 'لا متأخّر حالياً'}
              delay={0.1}
            />
            <MetricCard
              label="المحصَّل هذا الشهر"
              value={num(data.collectedThisMonth)}
              suffix={currency}
              tone="green"
              icon={<BadgeDollarSign size={16} />}
              hint={`غير المسدَّد كله: ${fmt(num(data.outstanding))} ${currency}`}
              delay={0.15}
            />
          </div>

          {/* big MRR chart */}
          <Reveal delay={0.1}>
            <section className="rounded-[10px] border border-line bg-surface p-4 shadow-1">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="m-0 text-[15px] font-bold text-ink">منحنى MRR — 12 شهراً</h3>
                  <p className="m-0 mt-0.5 text-[12px] text-muted">الإيراد الشهري المتكرر كما حُسب في العقود (بلا رسومٍ بلا معنى).</p>
                </div>
                {data.mixedCurrency ? (
                  <Badge tone="amber" dot>
                    <AlertTriangle size={12} /> عملات مختلطة — الأرقام بعملة العرض وحدها
                  </Badge>
                ) : null}
              </div>
              {(series.data?.mrrSeries ?? []).length > 0 ? (
                <AreaCardChart
                  data={(series.data?.mrrSeries ?? []).map((p) => ({ month: monthLabel(p.month), mrr: num(p.mrr) }))}
                  xKey="month"
                  dataKey="mrr"
                  name="MRR"
                  height={300}
                  color="var(--color-chart-2)"
                  formatter={(v) => `${fmt(v)} ${currency}`}
                />
              ) : (
                <EmptyState icon={<TrendingUp size={24} strokeWidth={1.5} />} title="لا بيانات سلسلة إيراد" />
              )}
            </section>
          </Reveal>

          <div className="grid gap-4 xl:grid-cols-3 items-start">
            {/* licence mix */}
            <Reveal delay={0.15}>
              <section className="rounded-[10px] border border-line bg-surface p-4 shadow-1">
                <h3 className="m-0 text-[15px] font-bold text-ink mb-3">التراخيص</h3>
                <dl className="m-0 grid gap-2.5">
                  {[
                    { label: 'فعّالة', value: data.counts.active, cls: 'text-ok' },
                    { label: 'متأخّرة', value: data.counts.pastDue, cls: 'text-danger' },
                    { label: 'تجربة', value: data.counts.trialing, cls: 'text-info' },
                    { label: 'موقوفة مؤقتاً', value: data.counts.paused, cls: 'text-warn' },
                    { label: 'ملغاة', value: data.counts.canceled, cls: 'text-muted' },
                  ].map((row) => (
                    <div key={row.label} className="flex items-center justify-between rounded-lg border border-line bg-surface-2 px-3 py-2">
                      <dt className="text-[12.5px] font-bold text-muted m-0">{row.label}</dt>
                      <dd className={`m-0 font-mono text-[15px] font-bold ${row.cls}`} dir="ltr">{row.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="m-0 mt-3 text-[11.5px] text-muted leading-relaxed">
                  MRR يعدّ «فعّالة» و«متأخّرة» فقط: من تأخّر في السداد ما زال متعاقداً، ومن يُجرّب لم يشترِ بعد.
                </p>
              </section>
            </Reveal>

            {/* upcoming invoices */}
            <Reveal delay={0.2} className="xl:col-span-2">
              <section className="rounded-[10px] border border-line bg-surface shadow-1 overflow-hidden">
                <header className="px-4 pt-4 pb-1 flex items-center gap-2">
                  <CalendarClock size={15} className="text-muted" />
                  <h3 className="m-0 text-[15px] font-bold text-ink">فواتير قائمة ({upcomingRows.length})</h3>
                </header>
                {upcomingRows.length === 0 ? (
                  <div className="px-4 pb-5">
                    <EmptyState icon={<CalendarClock size={22} strokeWidth={1.5} />} title="لا فواتير قائمة" description="لا فاتورة صادرة غير مدفوعة في هذه اللحظة." />
                  </div>
                ) : (
                  <div className="px-1 pb-1">
                    <Table
                      rows={upcomingRows}
                      rowKey={(row) => row.invoiceId}
                      dense
                      columns={[
                        { key: 'number', header: 'الفاتورة', ltr: true, cell: (row) => <span className="font-mono text-[12px]">{row.number ?? '—'}</span> },
                        { key: 'tenant', header: 'العميل', cell: (row) => <span className="font-bold text-ink-2">{row.tenantName}</span> },
                        { key: 'due', header: 'الاستحقاق', ltr: true, cell: (row) => <span className="font-mono text-[12px] text-muted">{gregDate(row.dueDate)}</span> },
                        { key: 'total', header: 'الإجمالي', numeric: true, ltr: true, cell: (row) => <span className="font-mono text-[12px] font-bold">{fmt(num(row.total))}</span> },
                        { key: 'remaining', header: 'المتبقّي', numeric: true, ltr: true, cell: (row) => <span className="font-mono text-[12px] font-bold text-warn-ink">{fmt(num(row.remaining))}</span> },
                        {
                          key: 'status',
                          header: 'الحالة',
                          cell: (row) =>
                            row.daysOverdue > 0 ? (
                              <Badge tone="red" dot>متأخّرة {row.daysOverdue} يوماً</Badge>
                            ) : (
                              <Badge tone="amber" dot>تنتظر السداد</Badge>
                            ),
                        },
                      ]}
                    />
                  </div>
                )}
              </section>
            </Reveal>
          </div>
        </>
      ) : null}
    </Screen>
  );
}
