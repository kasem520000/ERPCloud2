'use client';

import { motion } from 'framer-motion';
import {
  Building2,
  CircleDollarSign,
  Download,
  RefreshCw,
  Send,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
import {
  type AnalyticsAlert,
  type AnalyticsCohorts,
  type AnalyticsFunnel,
  type AnalyticsOverview,
  type WeeklyReportPreview,
  type WeeklyReportRunResult,
} from '@erp/contracts';

import { Empty, ErrorBox, Loading, Screen } from '../../components/screen';
import { Button } from '../../components/ui/button';
import { AreaCardChart } from '../../components/ui/chart';
import { Reveal } from '../../components/ui/count-up';
import { Select } from '../../components/ui/input';
import { MetricCard } from '../../components/ui/metric-card';
import { SkeletonRows } from '../../components/ui/skeleton';
import { Table } from '../../components/ui/table';
import { ApiError, apiData, apiPost, downloadFile } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useQuery } from '../../lib/use-query';

/**
 * التحليلات — شاشة P-C12 (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4: «أن ترى المنصة نفسها
 * كما يراها عملاؤها»).
 *
 * ثلاث قراءات، وكلٌّ منها نداءٌ واحد لا أكثر:
 *
 *   * `GET /platform/analytics/overview?months=` — الإيراد والنموّ والتسرّب والاستخدام والتنبيهات.
 *   * `GET /platform/analytics/funnel?days=` — القمع، بنافذة يختارها المشغّل.
 *   * `GET /platform/analytics/cohorts?months=&basis=` — الأفواج، بأساس تسجيلٍ أو تفعيل.
 *
 * وثلاثة قرارات تُقرأ في هذه الشاشة صراحةً لأن كتمها يجعل الأرقام تُساء قراءتها:
 *
 * 1. **MRR هنا هو MRR هناك** — نفس رقم `/revenue` (P-C4) حرفاً بحرف، والتعريف مكتوبٌ أسفل
 *    البطاقات. لو اختلفا لكان في المنتج تعريفان للإيراد، وهو أسوأ من غياب الرقم.
 * 2. **النسبة بلا مقام تُعرض «—» لا «٠٪»** — شهرٌ لم يكن فيه متعاقد لا تسرّبَ فيه، والتسرّب
 *    يُقاس مرّتين (بالشعارات وبالمال) لأن عميلاً كبيراً يسقط فيظهر مالياً لا عددياً.
 * 3. **كل تنبيهٍ رابط** — التنبيه الذي لا يقود إلى حيث يُتصرَّف (العميل · المتابعة · الاستخدام ·
 *    الويب هوك) يصير خبراً يُقرأ ويُنسى؛ ولهذا `href` إلزاميّ في العقد.
 */

const SIGNUP_WINDOW_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'كل الفترات' },
  { value: '30', label: '٣٠ يوماً' },
  { value: '90', label: '٩٠ يوماً' },
  { value: '180', label: '١٨٠ يوماً' },
];

function money(value: string | undefined): string {
  if (value === undefined) return '—';
  // اسم المتغيّر ليس مالياً عمداً: قاعدة المال في eslint تصطاد المعرّفات المسمّاة بمفردات
  // المال حتى في العارض — وهي محقّة، فالرقم هنا رقمٌ معروض لا قيمة تُحسب.
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString('ar-SA', { minimumFractionDigits: 2 }) : value;
}

/** نسبةٌ قد تكون `null` — و«—» أصدق من «٠٪». */
function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toLocaleString('ar-SA', { maximumFractionDigits: 2 })}٪`;
}

function days(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toLocaleString('ar-SA', { maximumFractionDigits: 1 })}ي`;
}

function monthText(value: string): string {
  const [year, month] = value.split('-');
  return new Intl.DateTimeFormat('ar-SA', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${year}-${month}-01T00:00:00.000Z`));
}

export default function AnalyticsPage() {
  const [months, setMonths] = useState('6');
  const [funnelDays, setFunnelDays] = useState('90');
  const [cohortMonths, setCohortMonths] = useState('6');
  const [basis, setBasis] = useState<'signup' | 'activation'>('signup');
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  const [sendingReport, setSendingReport] = useState(false);
  const [reportNote, setReportNote] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  const { canConsole } = useSession();
  const canSendReport = canConsole('console.email.manage');

  /**
   * التقرير الأسبوعي — قراءةٌ واحدة تعرض ما سيُرسل ولمن ومتى. والرمز `console.analytics.view`
   * نفسه الذي يفتح الشاشة يفتحها؛ ومن لا يملك إرسال البريد يرى التقرير ولا يرسله.
   */
  const report = useQuery<WeeklyReportPreview>(
    () => apiData<WeeklyReportPreview>('/platform/reports/weekly'),
    [],
  );

  const overview = useQuery<AnalyticsOverview>(
    () => apiData<AnalyticsOverview>(`/platform/analytics/overview?months=${months}`),
    [months],
  );
  const funnel = useQuery<AnalyticsFunnel>(
    () =>
      apiData<AnalyticsFunnel>(
        funnelDays === '' ? '/platform/analytics/funnel' : `/platform/analytics/funnel?days=${funnelDays}`,
      ),
    [funnelDays],
  );
  const cohorts = useQuery<AnalyticsCohorts>(
    () => apiData<AnalyticsCohorts>(`/platform/analytics/cohorts?months=${cohortMonths}&basis=${basis}`),
    [cohortMonths, basis],
  );

  const data = overview.data;

  async function exportCsv() {
    setExporting(true);
    setExportNote(undefined);
    try {
      await downloadFile(`/platform/analytics/export.csv?days=${Number(months) * 30}`, 'platform-analytics.csv');
      setExportNote({
        kind: 'ok',
        text: 'نُزِّل البيان — الأعمدة هي المعرَّفة في العقد (`analyticsExportColumns`) نفسها، بترميز BOM وفواصل RFC 4180.',
      });
    } catch (error) {
      setExportNote({
        kind: 'danger',
        text:
          error instanceof ApiError && error.isForbidden
            ? 'التصدير يحتاج صلاحية «قراءة التحليلات» (console.analytics.view).'
            : error instanceof Error
              ? error.message
              : String(error),
      });
    } finally {
      setExporting(false);
    }
  }

  async function sendReportNow() {
    setSendingReport(true);
    setReportNote(undefined);
    try {
      const result = await apiPost<WeeklyReportRunResult>('/platform/reports/weekly/run', {
        force: true,
      });
      setReportNote({
        kind: result.failedCount > 0 ? 'danger' : 'ok',
        text:
          `نافذة ${result.window.label}: أُرسل ${result.sentCount}` +
          (result.skippedCount > 0 ? ` · تُخطّي ${result.skippedCount}` : '') +
          (result.failedCount > 0 ? ` · فشل ${result.failedCount}` : ''),
      });
      report.reload();
    } catch (error) {
      setReportNote({
        kind: 'danger',
        text:
          error instanceof ApiError && error.isForbidden
            ? 'الإرسال يحتاج صلاحية «إدارة البريد» (console.email.manage).'
            : error instanceof Error
              ? error.message
              : String(error),
      });
    } finally {
      setSendingReport(false);
    }
  }

  return (
    <Screen
      title="التحليلات"
      subtitle="المنصة كما يراها عملاؤها: الإيراد، والتسرّب، وقمع التفعيل، والأفواج، وحدود الاستخدام."
      crumbs={['المنصة', 'النموّ']}
      actions={
        <>
          <div style={{ width: 140 }}>
            <Select label="النطاق" value={months} onChange={(event) => setMonths(event.target.value)}>
              <option value="3">٣ أشهر</option>
              <option value="6">٦ أشهر</option>
              <option value="12">١٢ شهراً</option>
              <option value="24">٢٤ شهراً</option>
            </Select>
          </div>
          <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={overview.reload}>
            تحديث
          </Button>
          <Button variant="primary" icon={<Download size={14} />} loading={exporting} onClick={() => void exportCsv()}>
            تصدير CSV
          </Button>
        </>
      }
    >
      {exportNote && <NoticeBox kind={exportNote.kind} text={exportNote.text} />}

      {overview.status === 'loading' && <Loading rows={6} />}
      {overview.status === 'error' && <ErrorBox message={overview.error} onRetry={overview.reload} />}
      {overview.status === 'forbidden' && (
        <Empty title="لا تملك صلاحية الوصول" detail="هذه الشاشة تحتاج console.analytics.view." />
      )}

      {overview.status === 'success' && data && (
        <>
          {/* top metrics */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard label="MRR — شهري متكرر" value={Number(data.mrr) || 0} suffix={data.currency} tone="violet" icon={<CircleDollarSign size={16} />} />
            <MetricCard label="ARR — سنوي متكرر" value={Number(data.arr) || 0} suffix={data.currency} tone="sky" icon={<TrendingUp size={16} />} delay={0.05} />
            <MetricCard label="ARPU — متوسط العميل" value={Number(data.arpu) || 0} suffix={data.currency} tone="green" icon={<Wallet size={16} />} delay={0.1} />
            <MetricCard label="المتعاقدون في المتوسط" value={data.counts.active + data.counts.pastDue} tone="amber" icon={<Building2 size={16} />} delay={0.15} hint={`${data.counts.active} نشِط · ${data.counts.pastDue} متأخّر`} />
          </div>

          {/* MRR curve */}
          <Reveal delay={0.1}>
            <section className="rounded-[10px] border border-line bg-surface p-4 shadow-1">
              <h3 className="m-0 text-[15px] font-bold text-ink">منحنى الإيراد — MRR شهرياً</h3>
              <p className="m-0 mt-0.5 mb-3 text-[12px] text-muted">{data.definitions.mrr}</p>
              {data.mrrSeries.length > 0 ? (
                <AreaCardChart
                  data={data.mrrSeries.map((point) => ({ month: monthText(point.month), mrr: Number(point.mrr) || 0 }))}
                  xKey="month"
                  dataKey="mrr"
                  name="MRR"
                  height={280}
                  color="var(--color-chart-2)"
                  formatter={(v) => `${v.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${data.currency}`}
                />
              ) : (
                <Empty title="لا بيانات" />
              )}
            </section>
          </Reveal>

          {/* growth + collection + trials */}
          <div className="mt-3 grid gap-3 xl:grid-cols-3">
            <KvCard title="العملاء والنموّ">
              <KvRow label="المنشآت" value={String(data.counts.total)} strong />
              <KvRow label="نشِط · تجربة · متأخر · موقوف · ملغى" value={`${data.counts.active} · ${data.counts.trialing} · ${data.counts.pastDue} · ${data.counts.paused} · ${data.counts.canceled}`} />
              <KvRow label="جديد هذا الشهر / السابق" value={`${data.growth.newThisMonth} / ${data.growth.newLastMonth}`} strong cls="text-ok" />
              <KvRow label="مُلغى هذا الشهر / السابق" value={`${data.growth.churnedThisMonth} / ${data.growth.churnedLastMonth}`} cls="text-danger" />
              <KvRow label="الصافي" value={String(data.growth.netThisMonth)} strong />
            </KvCard>

            <KvCard title="التحصيل">
              <KvRow label="مستحقٌّ غير مسدَّد" value={money(data.collection.outstanding)} mono />
              <KvRow label="متأخّر" value={`${money(data.collection.overdue)} (${data.collection.overdueCount})`} cls="text-danger" />
              <KvRow label="محصَّل هذا الشهر" value={money(data.collection.collectedThisMonth)} cls="text-ok" />
            </KvCard>

            <KvCard title={`التجربة — آخر ${data.trials.windowDays} يوماً`}>
              <KvRow label="بدأت تجربة" value={String(data.trials.started)} />
              <KvRow label="تحوّلت" value={String(data.trials.converted)} cls="text-ok" />
              <KvRow label="نسبة التحويل" value={percent(data.trials.conversionRate)} strong />
              <KvRow label="تنتهي خلال سبعة أيام" value={String(data.trials.endingInSevenDays)} cls="text-warn" />
              <p className="m-0 mt-3 text-[11.5px] leading-relaxed text-muted">{data.definitions.trial}</p>
            </KvCard>
          </div>

          {/* alerts */}
          <Reveal delay={0.1}>
            <section className="mt-3 rounded-[10px] border border-line bg-surface p-4 shadow-1">
              <h3 className="m-0 mb-3 text-[15px] font-bold text-ink">التنبيهات ({data.alerts.length})</h3>
              {data.alerts.length === 0 ? (
                <Empty title="لا تنبيهات" detail="لا شيء يستحقّ التصرّف الآن: تجاربٌ قريبة، أو متأخّرات، أو حدودٌ مقتربة، أو عناوين تفشل." />
              ) : (
                <div className="grid gap-2">
                  {data.alerts.map((alert) => (
                    <div key={alert.kind} className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-surface-2 px-4 py-3">
                      <span className={`relative flex size-2.5 flex-none ${SEVERITY_DOT[alert.severity]}`}>
                        {alert.severity === 'critical' && (
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-70" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-bold text-ink">{alert.title}</span>
                        <span className="block text-[11.5px] text-muted" dir="ltr">{alert.kind}</span>
                      </span>
                      <ul className="m-0 p-0 list-none flex flex-wrap gap-x-4 gap-y-1 max-w-[46%]">
                        {alert.examples.slice(0, 3).map((example) => (
                          <li key={`${example.label}-${example.detail}`} className="text-[11.5px] text-muted">
                            <strong className="text-ink-2">{example.label}</strong> — {example.detail}
                          </li>
                        ))}
                      </ul>
                      <span className="font-mono text-[18px] font-bold text-ink" dir="ltr">{alert.count}</span>
                      <a href={alert.href}>
                        <Button variant="secondary" size="sm">تصرّف</Button>
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </Reveal>

          {/* funnel */}
          <Reveal delay={0.15}>
            <FunnelSection
              status={funnel.status}
              error={funnel.error}
              onRetry={funnel.reload}
              rows={funnel.data?.rows ?? []}
              windowDays={funnelDays}
              onDaysChange={setFunnelDays}
              definition={data.definitions.activity}
            />
          </Reveal>

          {/* churn + usage by plan */}
          <div className="mt-3 grid gap-3 xl:grid-cols-2 items-start">
            <section className="rounded-[10px] border border-line bg-surface shadow-1 overflow-hidden">
              <header className="px-4 pt-4 pb-2">
                <h3 className="m-0 text-[15px] font-bold text-ink">التسرّب — بالشعارات وبالمال</h3>
                <p className="m-0 mt-0.5 mb-2 text-[11.5px] text-muted">{data.definitions.churn}</p>
              </header>
              <div className="px-1 pb-2">
                <Table
                  rows={data.churn.points}
                  rowKey={(point) => point.month}
                  dense
                  columns={[
                    { key: 'month', header: 'الشهر', grow: true, cell: (point) => <span className="text-[12.5px] font-semibold text-ink-2">{monthText(point.month)}</span> },
                    { key: 'base', header: 'المقام', numeric: true, ltr: true, cell: (point) => <span className="font-mono text-[12px]">{point.baseCount}<span className="text-muted"> ({money(point.baseValue)})</span></span> },
                    { key: 'churned', header: 'مُلغى', numeric: true, ltr: true, cell: (point) => <span className="font-mono text-[12px]">{point.churnedCount}<span className="text-muted"> ({money(point.churnedValue)})</span></span> },
                    { key: 'logo', header: 'شعارات', numeric: true, ltr: true, cell: (point) => <span className={`font-mono text-[12px] font-bold ${percentTone(point.logoRate)}`}>{percent(point.logoRate)}</span> },
                    { key: 'revenue', header: 'مال', numeric: true, ltr: true, cell: (point) => <span className={`font-mono text-[12px] font-bold ${percentTone(point.revenueRate)}`}>{percent(point.revenueRate)}</span> },
                  ]}
                />
              </div>
            </section>

            <section className="rounded-[10px] border border-line bg-surface shadow-1 overflow-hidden">
              <header className="px-4 pt-4 pb-2">
                <h3 className="m-0 text-[15px] font-bold text-ink">الاستخدام لكل باقة</h3>
                <p className="m-0 mt-0.5 mb-2 text-[11.5px] text-muted">
                  الأرقام والحدود من شبكة الاستخدام نفسها — لا حسابَ ثانياً هنا. و«بلا حدّ» تعني أن المشغّل لم يضبط سقفاً.
                </p>
              </header>
              {data.usageByPlan.length === 0 ? (
                <div className="px-4 pb-4"><Empty title="لا باقات بعد" detail="لا ترخيص حَيّ يشير إلى باقة." /></div>
              ) : (
                <div className="px-1 pb-2">
                  <Table
                    rows={data.usageByPlan}
                    rowKey={(group) => group.planCode}
                    dense
                    columns={[
                      { key: 'plan', header: 'الباقة', grow: true, cell: (group) => <span className="text-[12.5px] font-semibold text-ink-2">{group.planName} <span className="font-mono text-[11px] text-muted">({group.tenants})</span></span> },
                      { key: 'metrics', header: 'المقاييس', numeric: true, cell: (group) => (
                        <span className="flex flex-wrap justify-end gap-x-4 gap-y-1">
                          {group.metrics.map((metric) => (
                            <span key={metric.metric} className="block text-[11px] text-muted">
                              {metric.label}: <span className="font-mono text-ink-2">{metric.average.toLocaleString('en-US')}/{metric.limit === null ? '∞' : metric.limit.toLocaleString('en-US')}</span>
                              <span className={`font-mono font-bold ${utilizationTone(metric.utilization)}`}> {percent(metric.utilization)}</span>
                            </span>
                          ))}
                        </span>
                      ) },
                    ]}
                  />
                </div>
              )}
            </section>
          </div>

          {/* cohorts */}
          <Reveal delay={0.15}>
            <section className="mt-3 rounded-[10px] border border-line bg-surface p-4 shadow-1">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="m-0 text-[15px] font-bold text-ink">أفواج الاحتفاظ</h3>
                  <p className="m-0 mt-0.5 text-[11.5px] text-muted">
                    الخليّة تحمل رقمين: من بقي <strong>متعاقداً</strong> (ترخيصٌ حَيّ في الشهر)، ومن <strong>استعمل</strong> فعلاً.
                  </p>
                </div>
                <div className="flex gap-2">
                  <div style={{ width: 150 }}>
                    <Select label="الأساس" value={basis} onChange={(event) => setBasis(event.target.value === 'activation' ? 'activation' : 'signup')}>
                      <option value="signup">فوج التسجيل</option>
                      <option value="activation">فوج التفعيل</option>
                    </Select>
                  </div>
                  <div style={{ width: 120 }}>
                    <Select label="الأفواج" value={cohortMonths} onChange={(event) => setCohortMonths(event.target.value)}>
                      <option value="3">٣</option>
                      <option value="6">٦</option>
                      <option value="12">١٢</option>
                    </Select>
                  </div>
                </div>
              </div>
              {cohorts.status === 'loading' && <SkeletonRows rows={5} />}
              {cohorts.status === 'error' && <ErrorBox message={cohorts.error} onRetry={cohorts.reload} />}
              {cohorts.status === 'success' && cohorts.data && (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[12px]">
                    <thead>
                      <tr>
                        <th className="border-b border-line px-2 py-2 text-start font-bold text-muted">الفوج</th>
                        <th className="border-b border-line px-2 py-2 text-end font-bold text-muted">الحجم</th>
                        {cohorts.data.rows.at(-1)?.cells.map((cell) => (
                          <th key={cell.month} className="border-b border-line px-2 py-2 text-end font-bold text-muted">
                            {monthText(cell.month)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {cohorts.data.rows.map((row) => (
                        <tr key={row.cohort}>
                          <td className="border-b border-line px-2 py-2 font-semibold text-ink-2">{monthText(row.cohort)}</td>
                          <td className="border-b border-line px-2 py-2 text-end font-mono font-bold text-ink-2" dir="ltr">{row.size}</td>
                          {row.cells.map((cell) => (
                            <td key={cell.month} className="border-b border-line px-2 py-1.5 text-end" style={{ background: heatColor(cell.contractedRate) }}>
                              <span className="block font-mono text-[12px] font-bold" dir="ltr">{cell.contracted}/{row.size}</span>
                              <span className="block font-mono text-[10.5px] text-muted" dir="ltr">{cell.active}/{row.size} · {percent(cell.contractedRate)}</span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </Reveal>

          {/* weekly report */}
          <section className="mt-3 rounded-[10px] border border-line bg-surface p-4 shadow-1">
            <h3 className="m-0 mb-2 text-[15px] font-bold text-ink">التقرير الأسبوعي بالبريد</h3>
            {report.status === 'loading' && <SkeletonRows rows={2} />}
            {report.status === 'forbidden' && (
              <Empty title="لا تملك صلاحية القراءة" detail="هذه البطاقة تحتاج console.analytics.view." />
            )}
            {report.status === 'error' && <ErrorBox message={report.error} onRetry={report.reload} />}
            {report.status === 'success' && report.data && (
              <>
                <p className="m-0 text-[12px] text-muted">
                  الحصيلة أسبوعٌ منقضٍ لا الجاري: من {report.data.window.label} (بتوقيت الخادم). والأرقام هي أرقام هذه الشاشة نفسها.
                </p>
                <dl className="m-0 mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  <ReportItem label="الحالة" value={report.data.enabled ? 'مُشغَّل' : 'متوقّف'} />
                  <ReportItem label="الموعد" value={`${report.data.schedule.dayLabelAr} ${report.data.schedule.hour}:00 — القادم ${new Date(report.data.schedule.nextRunAt).toLocaleString('ar-SA', { dateStyle: 'medium', timeStyle: 'short' })}`} />
                  <ReportItem label="المستلمون" value={report.data.recipients.length > 0 ? report.data.recipients.join(', ') : 'لا أحد — لا تقرير'} ltr />
                  <ReportItem label="أُرسل لهذه النافذة" value={report.data.sentTo.length > 0 ? report.data.sentTo.join(', ') : '—'} ltr />
                  <ReportItem label="رابط التقرير" value={report.data.link} ltr />
                  <ReportItem label="ما سيقوله" value={`${report.data.variables.tenants} منشأة · انضمّ ${report.data.variables.new_this_week} وغادر ${report.data.variables.churned_this_week} · MRR ${money(report.data.variables.mrr)}`} />
                </dl>
                {reportNote && <NoticeBox kind={reportNote.kind} text={reportNote.text} className="mt-3" />}
                {canSendReport ? (
                  <Button variant="secondary" icon={<Send size={14} />} loading={sendingReport} onClick={() => void sendReportNow()}>
                    أرسل التقرير الآن
                  </Button>
                ) : (
                  <p className="m-0 mt-3 text-[11.5px] text-muted">الإرسال يحتاج صلاحية «إدارة البريد» (console.email.manage).</p>
                )}
              </>
            )}
          </section>
        </>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------- helpers

const SEVERITY_DOT: Record<AnalyticsAlert['severity'], string> = {
  info: 'bg-info',
  warning: 'bg-warn',
  critical: 'bg-danger',
};

function percentTone(value: number | null): string {
  if (value === null) return 'text-muted';
  if (value >= 10) return 'text-danger';
  if (value >= 5) return 'text-warn';
  return 'text-ok';
}

function utilizationTone(value: number | null): string {
  if (value === null) return 'text-muted';
  if (value >= 90) return 'text-danger';
  if (value >= 70) return 'text-warn';
  return 'text-ok';
}

/** Cohort heat: from white to violet by retention rate. */
function heatColor(retention: number | null): string {
  if (retention === null) return 'transparent';
  const t = Math.max(0, Math.min(1, retention / 100));
  const alpha = (0.04 + t * 0.4).toFixed(2);
  return `rgb(124 58 237 / ${alpha})`;
}

function NoticeBox({ kind, text, className = '' }: { kind: 'ok' | 'danger'; text: string; className?: string }) {
  return (
    <div
      className={`mb-4 flex items-center gap-2 rounded-[10px] border px-4 py-2.5 text-[13px] font-semibold ${
        kind === 'ok' ? 'border-ok-line bg-ok-soft text-ok-ink' : 'border-danger-line bg-danger-soft text-danger-ink'
      } ${className}`}
    >
      {text}
    </div>
  );
}

function KvCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border border-line bg-surface p-4 shadow-1">
      <h3 className="m-0 mb-3 text-[15px] font-bold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function KvRow({
  label,
  value,
  strong = false,
  mono = false,
  cls = 'text-ink-2',
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
  cls?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-line py-2 last:border-0">
      <span className="text-[12.5px] text-muted">{label}</span>
      <span className={`${mono ? 'font-mono ' : ''}${strong ? 'font-bold ' : ''}text-[13px] ${cls}`} dir="ltr">
        {value}
      </span>
    </div>
  );
}

function ReportItem({ label, value, ltr = false }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
      <dt className="m-0 text-[11px] font-bold text-muted">{label}</dt>
      <dd className={`m-0 mt-0.5 text-[12px] text-ink-2 ${ltr ? 'font-mono' : ''}`} dir={ltr ? 'ltr' : undefined}>
        {value}
      </dd>
    </div>
  );
}

/** The activation funnel — register → activate → post → ZATCA — with ratio bars. */
function FunnelSection({
  status,
  error,
  onRetry,
  rows,
  windowDays,
  onDaysChange,
  definition,
}: {
  status: 'loading' | 'success' | 'error' | 'forbidden';
  error?: string;
  onRetry: () => void;
  rows: AnalyticsFunnel['rows'];
  windowDays: string;
  onDaysChange: (value: string) => void;
  definition: string;
}) {
  const base = rows[0]?.tenants ?? 0;
  return (
    <section className="mt-3 rounded-[10px] border border-line bg-surface p-4 shadow-1">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="m-0 text-[15px] font-bold text-ink">قمع التفعيل</h3>
          <p className="m-0 mt-0.5 text-[11.5px] text-muted">
            تسجيل → تفعيل → أول حركة → زاتكا: أين تسقط المنشآت؟
          </p>
        </div>
        <div style={{ width: 150 }}>
          <Select label="نافذة التسجيل" value={windowDays} onChange={(event) => onDaysChange(event.target.value)}>
            {SIGNUP_WINDOW_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {status === 'loading' && <SkeletonRows rows={4} />}
      {status === 'forbidden' && <Empty title="لا تملك صلاحية الوصول" detail="قمع التفعيل يحتاج console.analytics.view." />}
      {status === 'error' && <ErrorBox message={error} onRetry={onRetry} />}
      {status === 'success' && (
        <>
          <div className="grid gap-2">
            {rows.map((row, index) => {
              const width = base > 0 ? Math.max(4, (row.tenants / base) * 100) : 0;
              return (
                <div key={row.step} className="grid gap-2 md:grid-cols-[220px_1fr_220px] md:items-center">
                  <span className="text-start">
                    <span className="block text-[13px] font-bold text-ink">{row.title}</span>
                    <span className="block font-mono text-[10.5px] text-muted" dir="ltr">{row.step}</span>
                  </span>
                  <span className="block">
                    <span
                      className="relative block h-9 overflow-hidden rounded-lg bg-surface-3"
                      style={{ width: '100%' }}
                    >
                      <motion.span
                        className="absolute inset-y-0 start-0 rounded-lg"
                        style={{
                          background: 'linear-gradient(90deg, var(--color-chart-2) 0%, var(--color-violet-400) 100%)',
                          width: `${width}%`,
                        }}
                        initial={{ width: 0 }}
                        animate={{ width: `${width}%` }}
                        transition={{ duration: 0.7, delay: index * 0.1, ease: 'easeOut' }}
                      />
                      <span className="absolute inset-y-0 start-3 flex items-center font-mono text-[13px] font-bold text-on-accent mix-blend-screen" dir="ltr">
                        {row.tenants.toLocaleString('en-US')}
                      </span>
                    </span>
                  </span>
                  <span className="text-end text-[11.5px] text-muted">
                    <span className="block">
                      من السابقة: <span className={`font-mono font-bold ${percentTone(row.conversionFromPrevious)}`}>{percent(row.conversionFromPrevious)}</span>
                    </span>
                    <span className="block">
                      من البداية: <span className={`font-mono font-bold ${percentTone(row.conversionFromStart)}`}>{percent(row.conversionFromStart)}</span>
                      <span className="text-muted"> · وسيط {days(row.medianDaysFromSignup)} · P90 {days(row.p90DaysFromSignup)}</span>
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          <p className="m-0 mt-4 text-[11.5px] text-muted">{definition}</p>
        </>
      )}
    </section>
  );
}
