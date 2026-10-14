'use client';

import { useState } from 'react';
import { type SiteAnalytics } from '@erp/contracts';

import { Empty, ErrorBox, Loading, Screen } from '../../../components/screen';
import { apiData } from '../../../lib/api';
import { useQuery } from '../../../lib/use-query';

/**
 * تحليلات الموقع — شاشة P-M10 (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * **نداءٌ واحد** (`GET /platform/analytics/site?days=`) يعطي كل ما في الصفحة: الزوّار، والأهداف
 * والقمع، والمنحنى اليومي، والمصادر، والمسارات، ونتائج أ/ب — لأن الشاشة واحدة، وتقسيمها إلى
 * نداءاتٍ أربعة يعني أربع حالات تحميلٍ وأربع فرصٍ لتخالف الأرقام بعضها.
 *
 * **وثلاثة قرارات تُقرأ هنا صراحةً:**
 *
 *   1. **كل رقمٍ بتعريفه**: التعريفات تُقرأ من الاستجابة (`definitions`) لا من نصٍّ في الشاشة،
 *      فتتغيّر مع العقد ولا تتخلّف عنه. والرقم بلا تعريفه يصير دعاية.
 *   2. **الخصوصية جزءٌ من الشاشة لا حاشيةٌ فيها**: ما يُجمع وما لا يُجمع (‏`never`) ومدةُ
 *      الاحتفاظ تُعرض بجانب الأرقام نفسها — لأن من يقرأ «٢٠٠ زائر» يجب أن يعرف ماذا يعني زائر.
 *   3. **النسبة بلا مقام تُعرض «—» لا «٠٪»** (كقاعدة P-C12): يومٌ لم يزره أحد لا تحويلَ فيه.
 */

const WINDOWS: Array<{ value: string; label: string }> = [
  { value: '7', label: '٧ أيام' },
  { value: '30', label: '٣٠ يوماً' },
  { value: '90', label: '٩٠ يوماً' },
  { value: '180', label: '١٨٠ يوماً' },
];

function count(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString('ar-SA');
}

function dayText(value: string): string {
  return new Intl.DateTimeFormat('ar-SA', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${value}T00:00:00.000Z`),
  );
}

export default function SiteAnalyticsPage() {
  const [windowDays, setWindowDays] = useState('30');
  const query = useQuery<SiteAnalytics>(
    () => apiData<SiteAnalytics>(`/platform/analytics/site?days=${windowDays}`),
    [windowDays],
  );

  const data = query.data;

  return (
    <Screen
      title="تحليلات الموقع"
      subtitle="ما يُقرأ في الموقع التسويقي، وما يُطلب منه — أحداثٌ مجهولة الهوية بعد موافقة الزائر."
    >
      <div className="card">
        <div className="row">
          <label className="field">
            <span>النافذة</span>
            <select value={windowDays} onChange={(event) => setWindowDays(event.target.value)}>
              {WINDOWS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {query.status === 'loading' ? <Loading /> : null}
      {query.status === 'forbidden' ? (
        <Empty title="لا صلاحية" detail="هذه الشاشة تحتاج «قراءة التحليلات» (console.analytics.view)." />
      ) : null}
      {query.status === 'error' ? <ErrorBox message={query.error} onRetry={query.reload} /> : null}

      {data ? (
        <>
          <section className="grid cols-2">
            <article className="card">
              <h2>الزوّار</h2>
              <p className="kpi">{count(data.visitors.all)}</p>
              <p className="small muted">
                زائرٌ مميّزٌ في النافذة · اليوم: {count(data.visitors.today)}
              </p>
            </article>
            <article className="card">
              <h2>المشاهدات</h2>
              <p className="kpi">{count(data.views.all)}</p>
              <p className="small muted">صفحةٌ مقروءة · اليوم: {count(data.views.today)}</p>
            </article>
            <article className="card">
              <h2>أعلى هدف</h2>
              <p className="kpi">
                {data.goals
                  .filter((goal) => goal.visitors > 0)
                  .sort((left, right) => right.visitors - left.visitors)[0]?.labelAr ?? '—'}
              </p>
              <p className="small muted">من يرتّب الأهداف بأعداد الزوّار لا بالنقرات</p>
            </article>
          </section>

          <section className="card">
            <h2>القمع — الأهداف الأربعة</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>الهدف</th>
                  <th>زوّار</th>
                  <th>أحداث</th>
                  <th>النسبة من زوّار النافذة</th>
                </tr>
              </thead>
              <tbody>
                {data.goals.map((goal) => (
                  <tr key={goal.name}>
                    <td>{goal.labelAr}</td>
                    <td>{count(goal.visitors)}</td>
                    <td>{count(goal.events)}</td>
                    <td>{goal.visitors === 0 ? '—' : `${goal.ratePct.toLocaleString('ar-SA', { maximumFractionDigits: 1 })}٪`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              الزوّار مميّزون: زائرٌ ينقر الزرّ ثلاث مرّات يُحسب واحداً — وفرقُ «أحداث − زوّار» هو
              عدد النقرات المتكرّرة.
            </p>
          </section>

          <section className="card">
            <h2>المنحنى اليومي</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>اليوم</th>
                  <th>زوّار</th>
                  <th>مشاهدات</th>
                </tr>
              </thead>
              <tbody>
                {data.series.map((point) => (
                  <tr key={point.day}>
                    <td>{dayText(point.day)}</td>
                    <td>{count(point.visitors)}</td>
                    <td>{count(point.views)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="grid cols-2">
            <article className="card">
              <h2>المصادر</h2>
              {data.sources.length === 0 ? (
                <p className="muted">لا زياراتٍ في النافذة بعد.</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>المصدر</th>
                      <th>زوّار</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((source) => (
                      <tr key={source.host}>
                        <td>{source.host}</td>
                        <td>{count(source.visitors)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </article>

            <article className="card">
              <h2>أكثر الصفحات</h2>
              {data.paths.length === 0 ? (
                <p className="muted">لا صفحاتٍ في النافذة بعد.</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>المسار</th>
                      <th>زوّار</th>
                      <th>مشاهدات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.paths.map((row) => (
                      <tr key={row.path}>
                        <td dir="ltr">{row.path}</td>
                        <td>{count(row.visitors)}</td>
                        <td>{count(row.views)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </article>
          </section>

          <section className="card">
            <h2>تجارب أ/ب</h2>
            {data.experiments.length === 0 ? (
              <p className="muted">
                لا تجربة جارية. تُنشأ من «المحتوى»: صفحةٌ أصلية، ثم صفحةٌ ثانية تُربط بها كنسخة
                بحرف (a أو b) فتُعلَن للزوّار ويقيسها هذا الجدول.
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>التجربة</th>
                    <th>النسخة</th>
                    <th>رأوا</th>
                    <th>بدأوا اشتراكاً</th>
                    <th>التحويل</th>
                  </tr>
                </thead>
                <tbody>
                  {data.experiments.flatMap((experiment) =>
                    experiment.variants.map((variant) => (
                      <tr key={`${experiment.experiment}-${variant.key}`}>
                        <td dir="ltr">{experiment.experiment}</td>
                        <td>{variant.key}</td>
                        <td>{count(variant.exposures)}</td>
                        <td>{count(variant.converters)}</td>
                        <td>{variant.exposures === 0 ? '—' : `${variant.ratePct.toLocaleString('ar-SA', { maximumFractionDigits: 1 })}٪`}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            )}
          </section>

          <section className="card">
            <h2>ماذا يُقاس وماذا لا يُقاس</h2>
            <p>{data.privacy.noteAr}</p>
            <div className="grid cols">
              <div>
                <h3>يُخزَّن</h3>
                <ul>
                  {data.privacy.collected.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>لا يُخزَّن أبداً</h3>
                <ul>
                  {data.privacy.never.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="small muted">
              مدة الاحتفاظ: {count(data.privacy.retentionDays)} يوماً — الصفوف الأقدم تُحذف آلياً،
              ولا صفّ خامٌ أبديّ.
            </p>
          </section>

          <section className="card">
            <h2>تعريف كل رقم</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>الرقم</th>
                  <th>ما يعنيه</th>
                </tr>
              </thead>
              <tbody>
                {data.definitions.map((definition) => (
                  <tr key={definition.key}>
                    <td>{definition.labelAr}</td>
                    <td>{definition.definitionAr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              آخر قراءة: {new Date(data.generatedAt).toLocaleString('ar-SA')} — والشاشة تقرأ ما
              جمعه الخادم لحظة الطلب، بلا تخزينٍ وسيط.
            </p>
          </section>
        </>
      ) : null}
    </Screen>
  );
}
