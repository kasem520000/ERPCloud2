'use client';

import { usageMetricRegistry, type UsageSnapshot } from '@erp/contracts';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiData } from '../../../lib/api';
import { useQuery } from '../../../lib/use-query';
import { useSession } from '../../../lib/session';

/**
 * 📊 الاستخدام والحصص — شاشة المستأجر التي يطلبها P-C5 («شاشة للمستأجر في staff
 * (`/settings/usage`)» في `docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * لا يوجد مقابل لها في `Desktop_ERP`: النسخة المكتبية تخدم منشأةً واحدة على جهاز العميل،
 * فلا حصص ولا `usage_counters`. الشاشة كلها من عقدٍ واحد — `GET /usage`
 * (`UsageSnapshot`) — والأرقام الثمانية تأتي من فهرس المقاييس في `@erp/contracts`
 * نفسه الذي يقرأ به سطح المنصّة، فلا تختلف شاشتان على رقم.
 *
 * وثلاثة أشياء تقولها الشاشة صراحةً لأن كتمانها يجعل الرقم مضلّلاً:
 *
 *   * **من أين جاء الحدّ** — تجاوزٌ خصّته به المنصّة أو افتراضٌ في الفهرس؛ والافتراض
 *     **يُبلَّغ عنه ولا يمنع** (`enforced === false`)، فنقولها ولا نوهم العميل برفضٍ لم يقع.
 *   * **أين يقع الرفض** — نصٌّ من الفهرس (`enforcedAtAr`)، فلا يظنّ العميل أنّ كل زيادة
 *     ستُرفض في كل مكان.
 *   * **٨٠٪ ناعم و١٠٠٪ صلب** — النسبتان مكتوبتان في العقد مرة واحدة (`usageStateFor`)
 *     وتُعرضان هنا كما هما.
 *
 * وقراءة الأرقام من `withTenantTx` في الـAPI: كل منشأة ترى أرقامها وحدها بحكم سياسة
 * العزل، لا بحكم فلترةٍ في هذه الصفحة.
 */

const STATE_LABEL: Record<string, string> = {
  ok: 'طبيعي',
  soft: 'قريب من الحدّ',
  hard: 'بلغ الحدّ',
  unlimited: 'بلا حدّ',
};

const SOURCE_LABEL: Record<string, string> = {
  tenant: 'حدٌّ خصّت به المنصّة منشأتك',
  platform: 'حدّ عام على المنصّة',
  default: 'افتراض الفهرس',
};

function ratioOf(used: number, limit: number | null): number {
  if (limit === null) return 0;
  return Math.min(1, used / Math.max(limit, 1));
}

function toneOf(state: string): string {
  if (state === 'hard') return 'danger';
  if (state === 'soft') return 'warn';
  return 'ok';
}

export default function UsageSettingsPage() {
  const session = useSession();
  const snapshot = useQuery<UsageSnapshot>(() => apiData<UsageSnapshot>('/usage'), []);
  const data = snapshot.data;

  // `can` يتعامل مع `*` بنفسه (المالك يملكها)، فلا شرط ثالث هنا.
  const allowed = session.can('tenant.view');

  return (
    <Screen
      title="الاستخدام والحصص"
      subtitle="ما تستهلكه منشأتك مقابل الحدود التي وضعتها المنصّة — والحصص لا تُشترى من هنا."
      crumbs={['الإعدادات', 'إعدادات عامة']}
      actions={
        <button className="btn" type="button" onClick={snapshot.reload}>
          تحديث
        </button>
      }
    >
      {!allowed && <Forbidden />}

      {allowed && snapshot.status === 'loading' && <Loading rows={4} />}
      {allowed && snapshot.status === 'error' && <ErrorBox message={snapshot.error} onRetry={snapshot.reload} />}
      {allowed && snapshot.status === 'forbidden' && (
        <Empty title="لا تملك صلاحية عرض الاستخدام" detail="هذه الشاشة تحتاج صلاحية عرض المنشأة (tenant.view)." />
      )}

      {allowed && snapshot.status === 'success' && data && (
        <>
          <div className="card">
            <dl className="kv">
              <dt>المنشأة</dt>
              <dd>
                {data.tenantName} <span className="muted small" dir="ltr">{data.tenantCode}</span>
              </dd>
              <dt>الفترة</dt>
              <dd dir="ltr">
                {data.periodStart} ← {data.periodEnd}
              </dd>
              <dt>حالة الحساب</dt>
              <dd>{data.tenantStatus}</dd>
            </dl>
            <p className="muted small" style={{ marginBottom: 0 }}>
              الأرقام تُقرأ لحظة السؤال من جداول منشأتك (الفروع · الأصناف · المستخدمون · الفواتير · التخزين ·
              الرسائل)، ومن عدّادٍ يزيده الطلب نفسه للاستدعاءات والبريد — لا نسخةً ثانية تتخلّف عن الأصل.
            </p>
          </div>

          {data.metrics
            .filter((metric) => metric.state === 'hard' && metric.enforced)
            .map((metric) => (
              <p key={`hard-${metric.key}`} className="alert danger">
                بلغتَ حدّ «{metric.labelAr}» ({metric.used} من {metric.limit}) — والزيادة تُرفض برمز
                <span dir="ltr"> USAGE_LIMIT_REACHED </span>
                عند: {metric.enforcedAtAr}. راجع المنصّة لرفع الحدّ.
              </p>
            ))}
          {data.metrics
            .filter((metric) => metric.state === 'soft')
            .map((metric) => (
              <p key={`soft-${metric.key}`} className="alert warn">
                {metric.noticeAr ?? `اقتربتَ من حدّ «${metric.labelAr}» (${metric.percentUsed}٪).`}
              </p>
            ))}

          <div className="card">
            <h2>المقاييس الثمانية</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>البند</th>
                    <th>المستهلك</th>
                    <th>الحدّ</th>
                    <th>النسبة</th>
                    <th>الحالة</th>
                    <th>من أين جاء الحدّ؟</th>
                    <th>أين يقع الرفض؟</th>
                  </tr>
                </thead>
                <tbody>
                  {usageMetricRegistry.map((definition) => {
                    const metric = data.metrics.find((entry) => entry.key === definition.key);
                    if (!metric) return null;
                    return (
                      <tr key={metric.key}>
                        <td>
                          {metric.labelAr}
                          <div className="muted small">
                            {metric.period === 'month' ? 'يُصفَّر كل شهر' : metric.period === 'day' ? 'يُصفَّر كل يوم' : 'تراكمي'}
                          </div>
                        </td>
                        <td className="num">
                          {metric.used.toLocaleString('ar-SA')} <span className="muted small">{metric.unitAr}</span>
                        </td>
                        <td className="num">{metric.limit === null ? 'بلا حدّ' : metric.limit.toLocaleString('ar-SA')}</td>
                        <td>
                          <span className="meter">
                            <span
                              className={`meter-fill ${toneOf(metric.state) === 'ok' ? '' : toneOf(metric.state)}`}
                              style={{ width: `${Math.round(ratioOf(metric.used, metric.limit) * 100)}%` }}
                            />
                          </span>
                          <span className="muted small" style={{ marginInlineStart: 6 }}>
                            {metric.percentUsed === null ? '—' : `${metric.percentUsed}%`}
                          </span>
                        </td>
                        <td>
                          <span className={`badge ${metric.state === 'ok' ? 'ready' : metric.state}`}>
                            {STATE_LABEL[metric.state]}
                          </span>
                          <div className="muted small">{metric.enforced ? 'يُطبَّق' : 'يُبلَّغ عنه فقط'}</div>
                        </td>
                        <td className="muted small">{SOURCE_LABEL[metric.limitSource]}</td>
                        <td className="muted small">{metric.enforcedAtAr}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h2>استدعاءات الـAPI — آخر ٣٠ يوماً</h2>
            <div className="day-bars" dir="ltr">
              {data.apiCallsPerDay.map((day) => {
                const max = Math.max(1, ...data.apiCallsPerDay.map((entry) => entry.count));
                return (
                  <div
                    key={day.day}
                    className="day-bar"
                    style={{ height: `${Math.max(3, (day.count / max) * 100)}%` }}
                    title={`${day.day}: ${day.count}`}
                  />
                );
              })}
            </div>
            <p className="muted small">
              اليوم الحالي: {(data.apiCallsPerDay.at(-1)?.count ?? 0).toLocaleString('ar-SA')} استدعاء · أحدث توليد{' '}
              {new Date(data.generatedAt).toLocaleString('ar-SA')}
            </p>
          </div>
        </>
      )}
    </Screen>
  );
}
