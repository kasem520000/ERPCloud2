'use client';

import Link from 'next/link';
import {
  Activity,
  ArrowLeft,
  Bell,
  Building2,
  CircleDollarSign,
  Gauge,
  Plus,
  RefreshCw,
  Zap,
} from 'lucide-react';
import { useState } from 'react';

import { Screen } from '../components/screen';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { AreaCardChart, BarCardChart } from '../components/ui/chart';
import { Reveal } from '../components/ui/count-up';
import { EmptyState } from '../components/ui/empty-state';
import { MetricCard } from '../components/ui/metric-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { apiData } from '../lib/api';
import { useQuery } from '../lib/use-query';

type Overview = {
  tenants: { total: number; active: number; suspended: number; new_30d: number };
  subscriptions: { active: number; past_due: number; canceled: number; mrr: string };
  pendingActivations: number;
  users: { total: number; active: number };
};

type AnalyticsOverview = {
  generatedAt: string;
  currency: string;
  mrr: string;
  arr: string;
  arpu: string;
  counts: { total: number; active: number; trialing: number; pastDue: number; paused: number; canceled: number };
  growth: { newThisMonth: number; newLastMonth: number; churnedThisMonth: number; churnedLastMonth: number; netThisMonth: number };
  collection: { outstanding: string; overdue: string; overdueCount: number; collectedThisMonth: string };
  trials: { windowDays: number; started: number; converted: number; conversionRate: number | null; endingInSevenDays: number };
  mrrSeries: Array<{ month: string; mrr: string; newValue: string; churnedValue: string; netValue: string }>;
  churn: { windowMonths: number; points: Array<{ month: string; baseCount: number; churnedCount: number; churnedValue: string; logoRate: number | null; revenueRate: number | null }> };
  usageByPlan: Array<{ planCode: string; planName: string; tenants: number; metrics: Array<{ metric: string; label: string; unit: string; limit: number | null; average: number; peak: number; utilization: number | null }> }>;
  alerts: Array<{ kind: string; severity: string; count: number; title: string; href: string; examples: Array<{ label: string; detail: string }> }>;
  definitions: { mrr: string; churn: string; trial: string; activity: string };
};

type TenantRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  createdAt: string;
  planName: string | null;
  subscriptionStatus: string | null;
};

type Heartbeat = { running: boolean; enabled: boolean; oldestPendingAgeSeconds: number | null };
type JobMeta = { data: unknown[]; meta: { total: number } };
type OpenTicketRow = {
  id: string;
  tenantName: string | null;
  tenantCode: string | null;
  subject: string;
  priority: string;
  category: string | null;
  createdAt: string;
};
type PendingAddonRow = {
  id: string;
  tenantName: string;
  tenantCode: string;
  appNameAr: string;
  createdAt: string;
};

const TICKET_PRIORITY_AR: Record<string, string> = {
  urgent: 'عاجلة',
  high: 'عالية',
  normal: 'عادية',
  low: 'منخفضة',
};

const money = (value: number, currency = 'SAR') =>
  `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

const monthLabel = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, 1));
  return d.toLocaleDateString('ar-SA-u-ca-gregory', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

export default function PlatformOverviewPage() {
  const overview = useQuery<Overview>(() => apiData<Overview>('/platform/overview'), []);
  const analytics = useQuery<AnalyticsOverview>(() => apiData<AnalyticsOverview>('/platform/analytics/overview?months=6'), []);
  const tenants = useQuery<TenantRow[]>(() => apiData<TenantRow[]>('/platform/tenants?limit=10&sort=createdAt:desc'), []);
  const jobs = useQuery<JobMeta>(() => apiData<JobMeta>('/platform/jobs?limit=1'), []);
  const heartbeat = useQuery<Heartbeat>(() => apiData<Heartbeat>('/platform/jobs/heartbeat'), []);
  const openTickets = useQuery<OpenTicketRow[]>(
    () => apiData<OpenTicketRow[]>('/platform/tickets?filter[status]=open&limit=6'),
    [],
  );
  const addonRequests = useQuery<PendingAddonRow[]>(
    () => apiData<PendingAddonRow[]>('/marketplace/platform/requests?status=pending'),
    [],
  );
  const [refreshing, setRefreshing] = useState(false);

  function reloadAll() {
    setRefreshing(true);
    overview.reload();
    analytics.reload();
    tenants.reload();
    jobs.reload();
    heartbeat.reload();
    openTickets.reload();
    addonRequests.reload();
    setTimeout(() => setRefreshing(false), 800);
  }

  const a = analytics.data;
  const o = overview.data;

  const mrrPoints = (a?.mrrSeries ?? []).map((p) => Number(p.mrr) || 0);
  const lastMrr = mrrPoints[mrrPoints.length - 1] ?? 0;
  const prevMrr = mrrPoints[mrrPoints.length - 2] ?? 0;
  const mrrDelta = prevMrr > 0 ? ((lastMrr - prevMrr) / prevMrr) * 100 : null;

  const utilizationPoints = (a?.usageByPlan ?? []).flatMap((plan) => plan.metrics.map((m) => m.utilization)).filter((v): v is number => v !== null);
  const avgUtilization = utilizationPoints.length > 0 ? utilizationPoints.reduce((s, v) => s + v, 0) / utilizationPoints.length : 0;
  const peakMetric = (a?.usageByPlan ?? []).flatMap((plan) => plan.metrics).sort((x, y) => (y.utilization ?? 0) - (x.utilization ?? 0))[0];

  const alertCount = a?.alerts.length ?? 0;
  const critical = (a?.alerts ?? []).filter((x) => x.severity === 'critical' || x.severity === 'high').length;

  const pendingJobs = jobs.data?.meta?.total ?? 0;
  const runnerLive = heartbeat.data?.running ?? false;

  const lastCustomers = (tenants.data ?? [])
    .filter((t) => !['platform', 'platform-ops'].includes(t.code.toLowerCase()))
    .slice(0, 5);
  const ticketRows = Array.isArray(openTickets.data) ? openTickets.data : [];
  const addonRows = Array.isArray(addonRequests.data) ? addonRequests.data : [];

  return (
    <Screen
      title="لوحة تحكم المنصة"
      subtitle="مؤشرات تشغيل الخدمة: الإيراد، العملاء، الاستخدام والصحة — بنظرة واحدة."
      crumbs={['المنصة']}
      actions={
        <>
          <Link href="/tenants/new">
            <Button variant="primary" icon={<Plus size={15} />}>عميل جديد</Button>
          </Link>
          <Button variant="secondary" icon={<RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />} onClick={reloadAll}>
            تحديث
          </Button>
        </>
      }
    >
      {/* metrics */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard
          label="MRR — الإيراد الشهري"
          value={Number(a?.mrr ?? o?.subscriptions.mrr ?? 0) || 0}
          suffix={a?.currency ?? 'SAR'}
          tone="violet"
          icon={<CircleDollarSign size={16} />}
          delta={mrrDelta ?? undefined}
          deltaLabel={mrrDelta === null ? undefined : 'عن الشهر السابق'}
          spark={mrrPoints.length > 1 ? mrrPoints : undefined}
        />
        <MetricCard
          label="ARR — الإيراد السنوي"
          value={Number(a?.arr ?? 0) || 0}
          suffix={a?.currency ?? 'SAR'}
          tone="sky"
          icon={<Activity size={16} />}
          hint={a ? `ARPU: ${money(Number(a.arpu) || 0, a.currency)}` : undefined}
          delay={0.05}
        />
        <MetricCard
          label="العملاء"
          value={o?.tenants.active ?? 0}
          tone="green"
          icon={<Building2 size={16} />}
          hint={o ? `من أصل ${o.tenants.total} · ${o.tenants.new_30d} جديد / 30ي · ${o.tenants.suspended} موقوف` : undefined}
          delay={0.1}
        />
        <MetricCard
          label="متوسط الاستخدام"
          value={Math.round(avgUtilization * 10) / 10}
          suffix="%"
          tone="amber"
          icon={<Gauge size={16} />}
          hint={peakMetric ? `الأعلى: ${peakMetric.label}${peakMetric.limit ? ` (${peakMetric.peak}/${peakMetric.limit})` : ''}` : 'لا مقاييس بعد'}
          delay={0.15}
        />
        <MetricCard
          label="تنبيهات الصحة"
          value={alertCount}
          tone={critical > 0 ? 'red' : alertCount > 0 ? 'amber' : 'green'}
          icon={<Bell size={16} />}
          live={critical > 0}
          hint={critical > 0 ? `${critical} حرجة تتطلب إجراءً` : alertCount > 0 ? 'ضمن الحدود — راقبها' : 'كل المؤشرات خضراء'}
          delay={0.2}
        />
        <MetricCard
          label="مهام في الطابور"
          value={pendingJobs}
          tone="slate"
          icon={<Zap size={16} />}
          live={runnerLive}
          hint={runnerLive ? 'المنفّذ يعمل الآن' : 'المنفّذ متوقف'}
          delay={0.25}
        />
      </div>

      {/* Live Customer Support Tickets & Add-on Activation Requests */}
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-[10px] border border-line bg-surface p-4 shadow-1">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="m-0 text-[15px] font-bold text-ink">
                🛟 طلبات المساعدة والدعم المفتوحة ({ticketRows.length})
              </h3>
              <p className="m-0 mt-0.5 text-[12px] text-muted">
                الرسائل والتذاكر الواردة من لوحة العملاء بانتظار رد إدارة المنصة
              </p>
            </div>
            <Link href="/tickets">
              <Button variant="secondary" size="sm">صندوق الدعم ←</Button>
            </Link>
          </div>
          {ticketRows.length === 0 ? (
            <p className="m-0 text-[13px] text-muted">لا توجد طلبات مساعدة مفتوحة حالياً.</p>
          ) : (
            <div className="grid gap-2">
              {ticketRows.map((t) => (
                <Link
                  key={t.id}
                  href={`/tickets/${t.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5 transition-colors hover:bg-brand-soft"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-bold text-ink">{t.subject}</div>
                    <div className="text-[11.5px] text-muted">
                      العميل: {t.tenantName ?? t.tenantCode ?? 'منشأة'} · {t.category ?? 'عام'} ·{' '}
                      {new Date(t.createdAt).toLocaleString('ar-SA')}
                    </div>
                  </div>
                  <Badge tone={t.priority === 'urgent' || t.priority === 'high' ? 'red' : 'amber'}>
                    {TICKET_PRIORITY_AR[t.priority] ?? t.priority}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-[10px] border border-line bg-surface p-4 shadow-1">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="m-0 text-[15px] font-bold text-ink">
                🛒 طلبات تفعيل الباقات والإضافات القطاعية ({addonRows.length})
              </h3>
              <p className="m-0 mt-0.5 text-[12px] text-muted">
                طلبات العملاء لتفعيل الأنظمة القطاعية (المخابز والمناديب، التصنيع، تطبيق الموظف…)
              </p>
            </div>
            <Link href="/marketplace">
              <Button variant="secondary" size="sm">إدارة الباقات ←</Button>
            </Link>
          </div>
          {addonRows.length === 0 ? (
            <p className="m-0 text-[13px] text-muted">لا توجد طلبات تفعيل باقات معلقة حالياً.</p>
          ) : (
            <div className="grid gap-2">
              {addonRows.map((req) => (
                <Link
                  key={req.id}
                  href="/marketplace"
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5 transition-colors hover:bg-brand-soft"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-bold text-ink">
                      طلب تفعيل: {req.appNameAr}
                    </div>
                    <div className="text-[11.5px] text-muted">
                      المنشأة: {req.tenantName} ({req.tenantCode}) ·{' '}
                      {new Date(req.createdAt).toLocaleString('ar-SA')}
                    </div>
                  </div>
                  <Badge tone="amber">بانتظار الموافقة</Badge>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* charts */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Reveal delay={0.1}>
          <section className="rounded-[10px] border border-line bg-surface p-4 shadow-1">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <h3 className="m-0 text-[15px] font-bold text-ink">منحنى MRR</h3>
                <p className="m-0 mt-0.5 text-[12px] text-muted">الإيراد الشهري المتكرر — آخر {a?.mrrSeries.length ?? 6} أشهر</p>
              </div>
              {a ? (
                <span className="rounded-md bg-brand-soft px-2.5 py-1 font-mono text-[12px] font-bold text-brand" dir="ltr">
                  {money(Number(a.mrr) || 0, a.currency)}
                </span>
              ) : null}
            </div>
            {a && a.mrrSeries.length > 0 ? (
              <AreaCardChart
                data={a.mrrSeries.map((p) => ({ month: monthLabel(p.month), mrr: Number(p.mrr) || 0 }))}
                xKey="month"
                dataKey="mrr"
                name="MRR"
                height={264}
                color="var(--color-chart-2)"
                formatter={(v) => money(v)}
              />
            ) : (
              <EmptyState icon={<Activity size={24} strokeWidth={1.5} />} title="لا بيانات إيراد بعد" />
            )}
          </section>
        </Reveal>

        <Reveal delay={0.16}>
          <section className="rounded-[10px] border border-line bg-surface p-4 shadow-1">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <h3 className="m-0 text-[15px] font-bold text-ink">التسرّب الشهري</h3>
                <p className="m-0 mt-0.5 text-[12px] text-muted">قيمة التراخيص المفقودة كل شهر (SAR)</p>
              </div>
              {a ? (
                <Badge tone="neutral" dot>{a.churn.windowMonths} شهراً</Badge>
              ) : null}
            </div>
            {a && a.churn.points.length > 0 ? (
              <BarCardChart
                data={a.churn.points.map((p) => ({ month: monthLabel(p.month), churned: Number(p.churnedValue) || 0 }))}
                xKey="month"
                dataKey="churned"
                name="Churn"
                height={264}
                color="var(--color-chart-4)"
                formatter={(v) => money(v)}
              />
            ) : (
              <EmptyState icon={<Activity size={24} strokeWidth={1.5} />} title="لا بيانات تسرّب" description="لم يقع أي تسرّب ضمن هذه النافذة." />
            )}
          </section>
        </Reveal>
      </div>

      {/* customers + alerts */}
      <div className="grid gap-4 xl:grid-cols-5">
        <Reveal delay={0.2} className="xl:col-span-3">
          <section className="rounded-[10px] border border-line bg-surface shadow-1 overflow-hidden">
            <header className="flex items-center justify-between px-4 pt-4 pb-2">
              <div>
                <h3 className="m-0 text-[15px] font-bold text-ink">أحدث العملاء</h3>
                <p className="m-0 mt-0.5 text-[12px] text-muted">آخر المنضمّين إلى المنصة</p>
              </div>
              <Link href="/tenants">
                <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />}>كل العملاء</Button>
              </Link>
            </header>
            <div className="px-2 pb-2">
              {tenants.status === 'loading' ? (
                <div className="grid gap-2 p-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-3" style={{ width: `${98 - i * 6}%` }} />
                  ))}
                </div>
              ) : lastCustomers.length === 0 ? (
                <div className="p-4">
                  <EmptyState icon={<Building2 size={22} strokeWidth={1.5} />} title="لا عملاء بعد" />
                </div>
              ) : (
                <ul className="m-0 list-none p-0">
                  {lastCustomers.map((t) => (
                    <li key={t.id}>
                      <Link
                        href={`/tenants/${t.id}`}
                        className="flex items-center gap-3 rounded-lg px-2.5 py-2.5 transition-colors duration-100 hover:bg-brand-soft"
                      >
                        <span className="grid size-9 flex-none place-items-center rounded-lg bg-inverse font-mono text-[12px] font-bold text-on-accent" dir="ltr">
                          {t.code.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-bold text-ink">{t.name}</span>
                          <span className="block font-mono text-[11px] text-muted" dir="ltr">
                            {t.code} · {new Date(t.createdAt).toLocaleDateString('ar-SA-u-ca-gregory', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}
                          </span>
                        </span>
                        <Badge tone={t.planName ? 'purple' : 'neutral'} dot>{t.planName ?? 'بلا باقة'}</Badge>
                        <Badge tone={t.status === 'active' ? 'green' : t.status === 'suspended' ? 'red' : 'neutral'}>
                          {t.status === 'active' ? 'نشط' : t.status === 'suspended' ? 'موقوف' : t.status}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </Reveal>

        <Reveal delay={0.26} className="xl:col-span-2">
          <section className="rounded-[10px] border border-line bg-surface shadow-1 overflow-hidden h-full">
            <header className="flex items-center justify-between px-4 pt-4 pb-2">
              <div>
                <h3 className="m-0 text-[15px] font-bold text-ink">تنبيهات الصحة</h3>
                <p className="m-0 mt-0.5 text-[12px] text-muted">ما يستحق النظر من النظام</p>
              </div>
              {critical > 0 ? (
                <span className="relative grid size-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-70" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-danger" />
                </span>
              ) : null}
            </header>
            {analytics.status === 'loading' ? (
              <div className="grid gap-2 px-3 pb-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-lg bg-surface-3" />
                ))}
              </div>
            ) : (a?.alerts ?? []).length === 0 ? (
              <div className="px-4 pb-5">
                <EmptyState tone="green" icon={<Bell size={22} strokeWidth={1.5} />} title="كل المؤشرات خضراء" description="لا تنبيهات تستدعي إجراءً حالياً." />
              </div>
            ) : (
              <ul className="m-0 list-none p-0 grid gap-1 px-2 pb-2">
                {(a?.alerts ?? []).map((alert) => (
                  <li key={alert.kind}>
                    <Link
                      href={alert.href}
                      className="flex items-start gap-2.5 rounded-lg px-2.5 py-2.5 transition-colors duration-100 hover:bg-surface-2"
                    >
                      <span
                        className={`mt-1 grid size-2.5 flex-none rounded-full ${
                          alert.severity === 'critical' || alert.severity === 'high'
                            ? 'bg-danger'
                            : alert.severity === 'medium' || alert.severity === 'warning'
                              ? 'bg-warn'
                              : 'bg-line-raised'
                        }`}
                        style={{ boxShadow: alert.severity === 'critical' || alert.severity === 'high' ? '0 0 0 4px rgb(239 68 68 / 0.15)' : undefined }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-bold text-ink">{alert.title}</span>
                        {alert.examples.length > 0 ? (
                          <span className="block truncate text-[11.5px] text-muted">
                            {alert.examples.slice(0, 2).map((e) => e.label).join('، ')}
                            {alert.examples.length > 2 ? ` +${alert.examples.length - 2}` : ''}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex-none rounded-md bg-surface-3 px-2 py-0.5 font-mono text-[11px] font-bold text-ink-2" dir="ltr">
                        {alert.count}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Reveal>
      </div>

      {/* definitions */}
      {a ? (
        <Reveal delay={0.3}>
          <details className="group rounded-[10px] border border-line bg-surface shadow-1">
            <summary className="cursor-pointer list-none px-4 py-3 text-[12.5px] font-bold text-muted transition-colors duration-150 hover:text-ink">
              <span className="inline-flex items-center gap-2">
                <span className="transition-transform duration-200 group-open:rotate-90">›</span>
                كيف حُسبت هذه الأرقام (التعريفات)
              </span>
            </summary>
            <dl className="m-0 grid gap-2 border-t border-line px-4 py-3 text-[12.5px] md:grid-cols-2">
              <div>
                <dt className="font-mono font-bold text-brand">MRR</dt>
                <dd className="m-0 text-ink-2">{a.definitions.mrr}</dd>
              </div>
              <div>
                <dt className="font-mono font-bold text-brand">Churn</dt>
                <dd className="m-0 text-ink-2">{a.definitions.churn}</dd>
              </div>
              <div>
                <dt className="font-mono font-bold text-brand">Trial</dt>
                <dd className="m-0 text-ink-2">{a.definitions.trial}</dd>
              </div>
              <div>
                <dt className="font-mono font-bold text-brand">Activity</dt>
                <dd className="m-0 text-ink-2">{a.definitions.activity}</dd>
              </div>
            </dl>
          </details>
        </Reveal>
      ) : null}

      {analytics.status === 'error' && overview.status !== 'loading' ? (
        <SkeletonCard lines={2} />
      ) : null}
    </Screen>
  );
}
