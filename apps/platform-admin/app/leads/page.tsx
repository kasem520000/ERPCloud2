'use client';

/**
 * P-M6 — صندوق العملاء المتوقّعين (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * شاشةٌ واحدة بتبويبين، لأن السؤالين متجاوران في يوم المشغّل:
 *
 *   1. **الطابور** — «من وصل؟ ومن لم يُتابع؟»: الطلبات مرتّبةً بالمفتوح أوّلاً، وعدّاداتٌ لكل
 *      حالةٍ ولغير المُسنَد، ومرشّحات (الحالة · المصدر · طلباتي · بحثٌ بالاسم أو البريد أو
 *      المرجع). واختيارُ طلبٍ يفتح بطاقته: الرسالة كما كتبها صاحبها، ووسوم الحملة، والملاحظات،
 *      والأثر الزمني، وأزرار الانتقال، والإسناد، **والتحويل إلى منشأة**.
 *   2. **النشرة** — «من يقرأ رسائلنا؟»: المشتركون بحالتهم، وتأكيدٌ أو إلغاءٌ بضغطة (فمن كتب
 *      عنوانه في ورقةٍ لن يفتح رابط التأكيد).
 *
 * وخمسة قرارات ظاهرة هنا:
 *
 *   * **الحالة النهائية لا تُعرض انتقالاً**: من `won`/`rejected` تُخفى أزرار الانتقال، لأن
 *     الـAPI يرفضها (`LEAD_STATUS_LOCKED`) — والشاشة لا تعرض ما سيُرفض.
 *   * **الرفض يطلب سبباً**: قرارُ «لن نتابع» يُكتب ليُقرأ بعد ستة أشهر.
 *   * **التحويل يُظهر بيانات الدخول مرّةً واحدة**: كلمة المرور المؤقتة تُعاد من الخادم مرّةً
 *     ولا تُخزَّن في الشاشة بعد إغلاق البطاقة — وزرُّ النسخ معها.
 *   * **الرمز يحكم الزرّ**: `console.leads.view` يفتح الشاشة، و`console.leads.manage` يُظهر
 *     الأفعال — والـAPI هو الحاكم لا الشاشة.
 *   * **لا حذف**: الطابور سجلّ، والطلب المرفوض يبقى بتاريخه.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  leadSources,
  leadSourceLabelsAr,
  leadStatuses,
  leadStatusLabelsAr,
  leadTransitions,
  subscriberStatuses,
  subscriberStatusLabelsAr,
  type LeadConversion,
  type LeadDetailResponse,
  type LeadNoteView,
  type LeadSource,
  type LeadStatus,
  type LeadView,
  type ListEnvelope,
  type PlatformPlan,
  type SubscriberStatus,
  type SubscriberView,
} from '@erp/contracts';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { Tabs } from '../../components/ui';
import { ApiError, apiData, apiFetch, apiPatch, apiPost } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useQuery } from '../../lib/use-query';

type QueuePayload = ListEnvelope<LeadView> & { counts: Record<LeadStatus, number>; unassigned: number };
type SubscribersPayload = ListEnvelope<SubscriberView> & { counts: Record<SubscriberStatus, number> };
type Operator = { id: string; fullName: string | null; email: string };

const STATUS_TONE: Record<LeadStatus, string> = {
  new: 'tag',
  contacted: 'tag platform',
  qualified: 'tag tenant',
  won: 'tag ok',
  rejected: 'tag danger',
};

export default function LeadsPage() {
  const { canConsole } = useSession();
  const canManage = canConsole('console.leads.manage');
  const [tab, setTab] = useState<'queue' | 'subscribers'>('queue');

  return (
    <Screen
      title="العملاء المتوقّعون"
      subtitle="من وصل من الموقع، ومن تابعه، ومن صار عميلاً — والنشرة البريدية في تبويبٍ ثانٍ."
      crumbs={['لوحة المنصّة', 'العملاء', 'العملاء المتوقّعون']}
    >
      <Tabs
        items={[
          { id: 'queue', label: 'الطابور' },
          { id: 'subscribers', label: 'النشرة البريدية' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'queue' ? <Queue canManage={canManage} /> : <Subscribers canManage={canManage} />}
    </Screen>
  );
}

// ═══════════════════════════════════════════════════ الطابور

function Queue({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [source, setSource] = useState<LeadSource | ''>('');
  const [scope, setScope] = useState<'' | 'unassigned' | 'mine'>('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (source) params.set('source', source);
    if (scope) params.set(scope, 'true');
    if (applied) params.set('q', applied);
    const value = params.toString();
    return value ? `?${value}` : '';
  }, [status, source, scope, applied]);

  const queue = useQuery<QueuePayload>(() => apiData<QueuePayload>(`/platform/leads${queryString}`), [queryString]);

  if (queue.status === 'loading') return <Loading rows={5} />;
  if (queue.status === 'forbidden') return <Forbidden />;
  if (queue.status === 'error') return <ErrorBox message={queue.error} onRetry={queue.reload} />;

  const payload = queue.data!;

  return (
    <>
      <section className="card grid">
        <div className="toolbar">
          <select className="input" value={status} onChange={(event) => setStatus(event.target.value as LeadStatus | '')}>
            <option value="">كل الحالات</option>
            {leadStatuses.map((key) => (
              <option key={key} value={key}>
                {leadStatusLabelsAr[key]} ({payload.counts[key] ?? 0})
              </option>
            ))}
          </select>
          <select className="input" value={source} onChange={(event) => setSource(event.target.value as LeadSource | '')}>
            <option value="">كل المصادر</option>
            {leadSources.map((key) => (
              <option key={key} value={key}>
                {leadSourceLabelsAr[key]}
              </option>
            ))}
          </select>
          <select className="input" value={scope} onChange={(event) => setScope(event.target.value as '' | 'unassigned' | 'mine')}>
            <option value="">الكل</option>
            <option value="unassigned">غير المُسنَد ({payload.unassigned})</option>
            <option value="mine">طلباتي</option>
          </select>
          <input
            className="input"
            placeholder="بحث: اسم · شركة · بريد · مرجع"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setApplied(search.trim());
            }}
          />
          <button className="btn" type="button" onClick={() => setApplied(search.trim())}>
            ابحث
          </button>
          {applied ? (
            <button
              className="btn sm"
              type="button"
              onClick={() => {
                setSearch('');
                setApplied('');
              }}
            >
              مسح البحث
            </button>
          ) : null}
        </div>

        <div className="toolbar">
          {leadStatuses.map((key) => (
            <span className={STATUS_TONE[key]} key={key}>
              {leadStatusLabelsAr[key]}: {payload.counts[key] ?? 0}
            </span>
          ))}
          <span className="muted">المعروض: {payload.data.length} من {payload.meta.total}</span>
        </div>
      </section>

      {payload.data.length === 0 ? (
        <Empty title="لا طلبات بهذه المرشّحات" detail="جرّب توسيع الحالة أو المصدر، أو امسح البحث." />
      ) : (
        <section className="card">
          <table className="table">
            <thead>
              <tr>
                <th>المرجع</th>
                <th>الطلب</th>
                <th>البريد</th>
                <th>الفروع</th>
                <th>المصدر</th>
                <th>الحالة</th>
                <th>المسؤول</th>
                <th>وصل في</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payload.data.map((lead) => (
                <tr key={lead.id}>
                  <td>
                    <bdi>{lead.reference}</bdi>
                  </td>
                  <td>
                    {lead.fullName ?? '—'}
                    {lead.companyName ? <div className="muted">{lead.companyName}</div> : null}
                  </td>
                  <td>
                    <bdi>{lead.email}</bdi>
                  </td>
                  <td>{lead.branchCount ?? '—'}</td>
                  <td>{lead.sourceLabelAr}</td>
                  <td>
                    <span className={STATUS_TONE[lead.status]}>{lead.statusLabelAr}</span>
                  </td>
                  <td>{lead.assignedToName ?? '—'}</td>
                  <td>{formatDate(lead.createdAt)}</td>
                  <td>
                    <button className="btn sm" type="button" onClick={() => setOpenId(openId === lead.id ? null : lead.id)}>
                      {openId === lead.id ? 'إغلاق' : 'تفاصيل'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {openId ? (
        <LeadCard
          leadId={openId}
          canManage={canManage}
          onChanged={() => {
            queue.reload();
          }}
        />
      ) : null}
    </>
  );
}

// ═══════════════════════════════════════════════════ بطاقة الطلب

function LeadCard({ leadId, canManage, onChanged }: { leadId: string; canManage: boolean; onChanged: () => void }) {
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [converted, setConverted] = useState<LeadConversion | null>(null);

  const detail = useQuery<LeadDetailResponse>(() => apiData<LeadDetailResponse>(`/platform/leads/${leadId}`), [leadId]);
  const operators = useQuery<Operator[]>(() => apiData<Operator[]>('/platform/users'), []);
  const plans = useQuery<PlatformPlan[]>(() => apiData<PlatformPlan[]>('/platform/plans'), []);

  const refresh = useCallback(() => {
    detail.reload();
    onChanged();
  }, [detail, onChanged]);

  if (detail.status === 'loading') return <Loading rows={3} />;
  if (detail.status === 'forbidden') return <Forbidden />;
  if (detail.status === 'error') return <ErrorBox message={detail.error} onRetry={detail.reload} />;

  const lead = detail.data!.lead;
  const available = leadTransitions[lead.status];

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      refresh();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.detail ?? failure.message : 'تعذّر تنفيذ الطلب');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card grid" aria-label={`طلب ${lead.reference}`}>
      <header className="section-title">
        <div>
          <h2 style={{ margin: 0 }}>
            <bdi>{lead.reference}</bdi> · {lead.fullName ?? lead.email}
          </h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {lead.sourceLabelAr} · {formatDate(lead.createdAt)} ·{' '}
            <span className={STATUS_TONE[lead.status]}>{lead.statusLabelAr}</span>
            {lead.convertedTenantCode ? (
              <>
                {' '}
                · منشأة: <bdi>{lead.convertedTenantCode}</bdi>
              </>
            ) : null}
          </p>
        </div>
      </header>

      {error ? <p className="alert danger">{error}</p> : null}

      <div className="grid cols-2">
        <div className="card">
          <h3>الرسالة</h3>
          <p>{lead.message}</p>
          <dl className="kv">
            <dt>البريد</dt>
            <dd>
              <bdi>{lead.email}</bdi>
            </dd>
            <dt>الهاتف</dt>
            <dd>{lead.phone ? <bdi>{lead.phone}</bdi> : '—'}</dd>
            <dt>الشركة</dt>
            <dd>{lead.companyName ?? '—'}</dd>
            <dt>الفروع</dt>
            <dd>{lead.branchCount ?? '—'}</dd>
            <dt>الباقة المهتمّ بها</dt>
            <dd>{lead.planInterest ?? '—'}</dd>
            <dt>موافقة الرسائل</dt>
            <dd>{lead.acceptsMarketing ? 'نعم' : 'لا'}</dd>
          </dl>
        </div>

        <div className="card">
          <h3>الحملة</h3>
          {lead.utm ? (
            <dl className="kv">
              <dt>المصدر</dt>
              <dd>{lead.utm.source ?? '—'}</dd>
              <dt>الوسيط</dt>
              <dd>{lead.utm.medium ?? '—'}</dd>
              <dt>الحملة</dt>
              <dd>{lead.utm.campaign ?? '—'}</dd>
              <dt>المحتوى</dt>
              <dd>{lead.utm.content ?? '—'}</dd>
              <dt>المرجع</dt>
              <dd>{lead.utm.referrer ? <bdi>{lead.utm.referrer}</bdi> : '—'}</dd>
              <dt>صفحة الهبوط</dt>
              <dd>{lead.utm.landingPath ?? '—'}</dd>
            </dl>
          ) : (
            <p className="muted">وصل الطلب بلا وسوم حملة (زيارة مباشرة أو من رابط بلا UTM).</p>
          )}
        </div>
      </div>

      <div className="card grid">
        <h3>المتابعة</h3>
        {!canManage ? (
          <p className="muted">قراءةٌ فقط: الإسناد وتغيير الحالة والتحويل تحتاج `console.leads.manage`.</p>
        ) : (
          <>
            <div className="toolbar">
              {available.length === 0 ? (
                <span className="muted">حالةٌ نهائية: لا انتقال بعدها. أضف ملاحظةً لتوثيق أي تطوّر.</span>
              ) : (
                available.map((next) => (
                  <button
                    key={next}
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      act(() =>
                        apiPatch(`/platform/leads/${lead.id}`, {
                          status: next,
                          reason: reason.trim() || undefined,
                        }),
                      )
                    }
                  >
                    → {leadStatusLabelsAr[next]}
                  </button>
                ))
              )}
            </div>
            <label className="field">
              <span>سبب التغيير (يُسجَّل في الأثر)</span>
              <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="مثال: خارج نطاقنا الجغرافي حالياً" />
            </label>

            <label className="field">
              <span>المسؤول</span>
              <select
                className="input"
                value={lead.assignedTo ?? ''}
                disabled={busy || operators.status !== 'success'}
                onChange={(event) =>
                  act(() => apiPatch(`/platform/leads/${lead.id}`, { assignedTo: event.target.value || null }))
                }
              >
                <option value="">بلا مسؤول</option>
                {(operators.data ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.fullName ?? person.email}
                  </option>
                ))}
              </select>
            </label>

            {(operators.data ?? []).length === 0 && operators.status === 'success' ? (
              <p className="muted">لا مشغّلون في الدليل — الإسناد يتطلّب مستخدماً نشطاً.</p>
            ) : null}

            <ConvertPanel
              lead={lead}
              plans={plans.data ?? []}
              busy={busy}
              converted={converted}
              onConvert={(body) =>
                act(async () => {
                  const result = await apiPost<LeadConversion>(`/platform/leads/${lead.id}/convert`, body);
                  setConverted(result);
                })
              }
            />
          </>
        )}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>الملاحظات</h3>
          {canManage ? (
            <div className="grid">
              <textarea
                className="input"
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="ما الذي جرى في المكالمة؟"
              />
              <button
                className="btn primary"
                type="button"
                disabled={busy || note.trim().length < 2}
                onClick={() =>
                  act(async () => {
                    await apiPost<LeadNoteView>(`/platform/leads/${lead.id}/notes`, { body: note.trim() });
                    setNote('');
                  })
                }
              >
                أضف ملاحظة
              </button>
            </div>
          ) : null}
          <Notes notes={detail.data!.notes} />
        </div>

        <div className="card">
          <h3>الأثر</h3>
          <ul className="timeline">
            {detail.data!.events.map((event) => (
              <li key={event.id}>
                <b>{eventLabel(event.kind)}</b>
                {event.detail ? <span> — {event.detail}</span> : null}
                <div className="muted">
                  {event.actorName ?? 'النظام'} · {formatDate(event.createdAt)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Notes({ notes }: { notes: LeadNoteView[] }) {
  if (notes.length === 0) return <p className="muted">لا ملاحظات بعد.</p>;
  return (
    <ul className="timeline">
      {notes.map((entry) => (
        <li key={entry.id}>
          {entry.body}
          <div className="muted">
            {entry.authorName ?? 'النظام'} · {formatDate(entry.createdAt)}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** التحويل: باقةٌ ورمزُ منشأةٍ وتجربة — وبيانات الدخول تُعاد مرّةً واحدة. */
function ConvertPanel({
  lead,
  plans,
  busy,
  converted,
  onConvert,
}: {
  lead: LeadView;
  plans: PlatformPlan[];
  busy: boolean;
  converted: LeadConversion | null;
  onConvert: (body: Record<string, unknown>) => void;
}) {
  const [planId, setPlanId] = useState('');
  const [tenantCode, setTenantCode] = useState('');
  const [trialDays, setTrialDays] = useState('');

  if (lead.convertedTenantId) {
    return (
      <div className="card">
        <h4>حُوّل إلى منشأة</h4>
        <p className="muted">
          <bdi>{lead.convertedTenantCode}</bdi> · {formatDate(lead.convertedAt ?? '')}
        </p>
      </div>
    );
  }

  return (
    <div className="card grid">
      <h4>التحويل إلى منشأة</h4>
      <p className="muted">
        يُنشئ المنشأة والمدير ودليل الحسابات، ويمنح ترخيصاً بحالة «تجربة»، ثم يُغلق الطلب. وكلمة المرور
        المؤقتة تُعرض هنا <b>مرّةً واحدة</b>.
      </p>

      {converted ? (
        <div className="alert ok">
          <p>
            أُنشئت <bdi>{converted.tenantCode}</bdi> · تجربة {converted.trialDays} يوماً
            {converted.trialEndsAt ? ` حتى ${formatDate(converted.trialEndsAt)}` : ''}.
          </p>
          <p>
            <b>بيانات الدخول</b> — تُعرض مرّةً واحدة:
            <br />
            <bdi>{converted.ownerEmail}</bdi> · <bdi>{converted.tempPassword}</bdi>
          </p>
          <button
            className="btn"
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(`${converted.ownerEmail} / ${converted.tempPassword}`);
            }}
          >
            انسخ بيانات الدخول
          </button>
        </div>
      ) : null}

      <div className="toolbar">
        <select className="input" value={planId} onChange={(event) => setPlanId(event.target.value)}>
          <option value="">الباقة الافتراضية (أوّل باقة معروضة)</option>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name} · {plan.interval}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="رمز المنشأة (اختياري)"
          dir="ltr"
          value={tenantCode}
          onChange={(event) => setTenantCode(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        />
        <input
          className="input"
          placeholder="أيام التجربة (من الإعدادات)"
          inputMode="numeric"
          value={trialDays}
          onChange={(event) => setTrialDays(event.target.value.replace(/[^\d]/g, '').slice(0, 3))}
        />
        <button
          className="btn primary"
          type="button"
          disabled={busy}
          onClick={() =>
            onConvert({
              ...(planId ? { planId } : {}),
              ...(tenantCode ? { tenantCode } : {}),
              ...(trialDays ? { trialDays: Number(trialDays) } : {}),
            })
          }
        >
          حوّل إلى عميل
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════ النشرة

function Subscribers({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState<SubscriberStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const queryString = status ? `?status=${status}` : '';
  const list = useQuery<SubscribersPayload>(
    () => apiData<SubscribersPayload>(`/platform/leads/subscribers${queryString}`),
    [queryString],
  );

  if (list.status === 'loading') return <Loading rows={4} />;
  if (list.status === 'forbidden') return <Forbidden />;
  if (list.status === 'error') return <ErrorBox message={list.error} onRetry={list.reload} />;

  const payload = list.data!;

  const setSubscriber = async (id: string, next: SubscriberStatus) => {
    setError(null);
    try {
      await apiFetch(`/platform/leads/subscribers/${id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
      list.reload();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.detail ?? failure.message : 'تعذّر التحديث');
    }
  };

  return (
    <>
      <section className="card grid">
        <div className="toolbar">
          <select className="input" value={status} onChange={(event) => setStatus(event.target.value as SubscriberStatus | '')}>
            <option value="">كل الحالات</option>
            {subscriberStatuses.map((key) => (
              <option key={key} value={key}>
                {subscriberStatusLabelsAr[key]} ({payload.counts[key] ?? 0})
              </option>
            ))}
          </select>
          <span className="muted">المعروض: {payload.data.length} من {payload.meta.total}</span>
          {!canManage ? <span className="muted">قراءةٌ فقط</span> : null}
        </div>
        {error ? <p className="alert danger">{error}</p> : null}
      </section>

      {payload.data.length === 0 ? (
        <Empty title="لا مشتركين بهذه الحالة" detail="الاشتراك يبدأ من تذييل الموقع، ويُؤكَّد من رابط البريد." />
      ) : (
        <section className="card">
          <table className="table">
            <thead>
              <tr>
                <th>البريد</th>
                <th>الحالة</th>
                <th>اللغة</th>
                <th>المصدر</th>
                <th>اشترك في</th>
                <th>أكّد في</th>
                {canManage ? <th>إجراء</th> : null}
              </tr>
            </thead>
            <tbody>
              {payload.data.map((row) => (
                <tr key={row.id}>
                  <td>
                    <bdi>{row.email}</bdi>
                  </td>
                  <td>
                    <span className="tag">{row.statusLabelAr}</span>
                  </td>
                  <td>{row.locale === 'ar' ? 'العربية' : 'English'}</td>
                  <td>{leadSourceLabelsAr[row.source]}</td>
                  <td>{formatDate(row.createdAt)}</td>
                  <td>{row.confirmedAt ? formatDate(row.confirmedAt) : '—'}</td>
                  {canManage ? (
                    <td>
                      <div className="toolbar">
                        {row.status !== 'confirmed' ? (
                          <button className="btn sm" type="button" onClick={() => void setSubscriber(row.id, 'confirmed')}>
                            تأكيد
                          </button>
                        ) : null}
                        {row.status !== 'unsubscribed' ? (
                          <button className="btn sm" type="button" onClick={() => void setSubscriber(row.id, 'unsubscribed')}>
                            إلغاء
                          </button>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════ أدوات

const EVENT_LABELS: Record<string, string> = {
  'lead.created': 'وصل الطلب',
  'lead.duplicated': 'طلبٌ مكرَّر أُلحق',
  'lead.assigned': 'إسناد',
  'lead.status_changed': 'تغيير حالة',
  'lead.note_added': 'ملاحظة',
  'lead.converted': 'تحويل إلى عميل',
  'subscriber.created': 'اشتراك في النشرة',
  'subscriber.confirmed': 'تأكيد اشتراك',
};

function eventLabel(kind: string): string {
  return EVENT_LABELS[kind] ?? kind;
}

function formatDate(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
