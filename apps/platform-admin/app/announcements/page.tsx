'use client';

import { useState } from 'react';
import {
  announcementAudiences,
  announcementChannels,
  announcementStatuses,
  type Announcement,
  type AnnouncementAudience,
  type AnnouncementChannel,
  type AnnouncementReadRow,
  type AnnouncementStatus,
  type AnnouncementTargetStatus,
} from '@erp/contracts';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { Tabs } from '../../components/ui';
import { ApiError, apiData } from '../../lib/api';
import { useQuery } from '../../lib/use-query';

/**
 * الإعلانات والإشعارات — service console (P-C7، `docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * سؤالان يسألهما المشغّل:
 *
 *   1. **ماذا نقول، ولمن، ومتى؟** — كتابةٌ بنصّين (ar/en، وكلاهما إلزامي)، واستهدافٌ
 *      بالجميع أو بباقةٍ أو بحالة اشتراك، وجدولةٌ بوقت، ومعاينةٌ باللغة قبل الإرسال.
 *   2. **هل وصل؟** — توزيعٌ لكل عميل: إشعارات داخل التطبيق، ورسائل البريد، وقراءات.
 *
 * وثلاثة قرارات من العقد تظهر في الشاشة لا تُخفى:
 *
 *   * **الجمهور يُثبَّت لحظة النشر** (snapshot)، فمن دخل بعدها لا يُشمل بإعادة الإرسال —
 *     وهذا ما يجعل «أعِد النشر» آمنة: تكمل الناقص ولا تضاعف الواصل.
 *   * **المنشور لا يُعدَّل**: ما قيل للناس لا يُعاد كتابته بأثرٍ رجعي. التعديل لمسودّةٍ أو
 *     مجدولة، والتصحيح thereafter إعلانٌ جديد.
 *   * **البريد للمالك وحده**، والإشعار في التطبيق لكل عضوٍ نشط — الرسالة تُقرأ، والبريد
 *     يُوجَّه إلى من يمثّل المنشأة أمام المنصة.
 */

const STATUS_LABEL: Record<AnnouncementStatus, string> = {
  draft: 'مسودّة',
  scheduled: 'مجدولة',
  published: 'منشورة',
};

const AUDIENCE_LABEL: Record<AnnouncementAudience, string> = {
  all: 'كل العملاء النشطين',
  plan: 'حسب الباقة',
  status: 'حسب حالة الاشتراك',
};

const CHANNEL_LABEL: Record<AnnouncementChannel, string> = {
  in_app: 'إشعار داخل التطبيق',
  email: 'رسالة بريد',
};

function dateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('ar-SA') : '—';
}

/** `datetime-local` يكتب الوقت المحلّي بلا منطقة زمنية؛ والـAPI يقرأ ISO. */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function apiMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isForbidden)
      return 'تحتاج صلاحية «إعلانات المنصة» (console.notifications.manage) لهذا الإجراء.';
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

type TabId = 'list' | 'compose';

export default function AnnouncementsPage() {
  const [tab, setTab] = useState<TabId>('list');
  const [editing, setEditing] = useState<Announcement | null>(null);

  return (
    <Screen
      title="الإعلانات والإشعارات"
      subtitle="رسالة المنصة إلى عملائها: نصّان (عربي/إنجليزي)، استهدافٌ بالجميع أو بباقةٍ أو بحالة الاشتراك، وجدولة، ومعاينة، ثم قياس الوصول والقراءة. البريد يذهب إلى مالك المنشأة، والإشعار إلى كل عضوٍ نشط."
      crumbs={['المنصة', 'التشغيل']}
      actions={
        <button
          className="btn"
          type="button"
          onClick={() => {
            setEditing(null);
            setTab('compose');
          }}
        >
          إعلان جديد
        </button>
      }
    >
      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        items={[
          { id: 'list', label: 'الإعلانات' },
          { id: 'compose', label: editing ? 'تعديل إعلان' : 'كتابة إعلان' },
        ]}
      />
      {tab === 'list' && (
        <ListTab
          onEdit={(item) => {
            setEditing(item);
            setTab('compose');
          }}
        />
      )}
      {tab === 'compose' && (
        <ComposeTab
          editing={editing}
          onSaved={() => {
            setEditing(null);
            setTab('list');
          }}
        />
      )}
    </Screen>
  );
}

// ───────────────────────────────────────────────────── القائمة

function ListTab({ onEdit }: { onEdit: (item: Announcement) => void }) {
  const [status, setStatus] = useState<AnnouncementStatus | ''>('');
  const [audience, setAudience] = useState<AnnouncementAudience | ''>('');
  const [readsFor, setReadsFor] = useState<Announcement | null>(null);

  const list = useQuery<Announcement[]>(() => {
    const params = new URLSearchParams({ limit: '50' });
    if (status) params.set('filter[status]', status);
    if (audience) params.set('filter[audience]', audience);
    return apiData<Announcement[]>(`/platform/announcements?${params.toString()}`);
  }, [status, audience]);

  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function publish(item: Announcement) {
    if (!window.confirm(`نشر «${item.titleAr}» الآن وتوزيعه على ${AUDIENCE_LABEL[item.audience]}؟`)) return;
    setBusyId(item.id);
    setNotice(undefined);
    try {
      const published = await apiData<Announcement>(`/platform/announcements/${item.id}/publish`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'نشرٌ من شاشة الإعلانات' }),
      });
      setNotice({
        kind: 'ok',
        text: `نُشرت: ${published.stats.inApp} إشعاراً داخل التطبيق · ${published.stats.emails} بريداً · ${published.stats.tenants} منشأة.`,
      });
      list.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="toolbar">
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span>الحالة</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as AnnouncementStatus | '')}
          >
            <option value="">الكل</option>
            {announcementStatuses.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span>الجمهور</span>
          <select
            value={audience}
            onChange={(event) => setAudience(event.target.value as AnnouncementAudience | '')}
          >
            <option value="">الكل</option>
            {announcementAudiences.map((value) => (
              <option key={value} value={value}>
                {AUDIENCE_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="button" onClick={list.reload}>
          تحديث
        </button>
      </div>

      {notice && (
        <p className={`alert ${notice.kind === 'ok' ? 'ok' : 'danger'}`} style={{ margin: 0 }}>
          {notice.text}
        </p>
      )}

      <section className="card">
        {list.status === 'loading' && <Loading rows={3} />}
        {list.status === 'forbidden' && <Forbidden />}
        {list.status === 'error' && <ErrorBox message={list.error} onRetry={list.reload} />}
        {list.status === 'success' && (list.data?.length ?? 0) === 0 && (
          <Empty title="لا إعلانات بعد" detail="ابدأ بـ«إعلان جديد» — النصّان (ar/en) إلزاميان قبل النشر." />
        )}
        {list.status === 'success' && (list.data?.length ?? 0) > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>العنوان</th>
                  <th>الحالة</th>
                  <th>الجمهور</th>
                  <th>القنوات</th>
                  <th>الميعاد</th>
                  <th>الوصول</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.titleAr}</strong>
                      <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
                        {item.titleEn}
                      </p>
                    </td>
                    <td>
                      <span className={`chip${item.status === 'published' ? ' on' : ''}`}>
                        {STATUS_LABEL[item.status]}
                      </span>
                    </td>
                    <td>
                      {AUDIENCE_LABEL[item.audience]}
                      {item.planCode ? ` · ${item.planCode}` : ''}
                      {item.tenantStatus ? ` · ${item.tenantStatus}` : ''}
                    </td>
                    <td>{item.channels.map((channel) => CHANNEL_LABEL[channel]).join(' · ')}</td>
                    <td>
                      {item.status === 'published' ? dateTime(item.publishedAt) : dateTime(item.publishAt)}
                    </td>
                    <td>
                      {item.stats.tenants} منشأة · {item.stats.inApp} إشعاراً · {item.stats.emails} بريداً ·{' '}
                      {item.stats.reads} قراءة
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {item.status !== 'published' && (
                          <button
                            className="btn"
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => void publish(item)}
                          >
                            نشر الآن
                          </button>
                        )}
                        {item.status !== 'published' && (
                          <button className="btn" type="button" onClick={() => onEdit(item)}>
                            تعديل
                          </button>
                        )}
                        {item.status === 'published' && (
                          <button className="btn" type="button" onClick={() => setReadsFor(item)}>
                            القراءات
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {readsFor && <ReadsPanel announcement={readsFor} onClose={() => setReadsFor(null)} />}
    </>
  );
}

// ───────────────────────────────────────────────────── القراءات

function ReadsPanel({ announcement, onClose }: { announcement: Announcement; onClose: () => void }) {
  const reads = useQuery<AnnouncementReadRow[]>(
    () => apiData<AnnouncementReadRow[]>(`/platform/announcements/${announcement.id}/reads?limit=100`),
    [announcement.id],
  );

  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>القراءات — {announcement.titleAr}</h2>
        <button className="btn" type="button" onClick={onClose}>
          إغلاق
        </button>
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        صفٌّ لكل عميلٍ مستهدف: كم إشعاراً وُزّع، وكم بريداً خرج، وكم قُرئ (وسمُ القراءة يُكتب من مركز
        الإشعارات حين يفتحه المستخدم).
      </p>
      {reads.status === 'loading' && <Loading rows={3} />}
      {reads.status === 'forbidden' && <Forbidden />}
      {reads.status === 'error' && <ErrorBox message={reads.error} onRetry={reads.reload} />}
      {reads.status === 'success' && (reads.data?.length ?? 0) === 0 && (
        <Empty title="لا مستهدفين" detail="لم يطابق الاستهداف منشأةً نشطة لحظة النشر." />
      )}
      {reads.status === 'success' && (reads.data?.length ?? 0) > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>المنشأة</th>
                <th>الرمز</th>
                <th>إشعارات</th>
                <th>بريد</th>
                <th>قراءات</th>
                <th>آخر قراءة</th>
              </tr>
            </thead>
            <tbody>
              {(reads.data ?? []).map((row) => (
                <tr key={row.tenantId}>
                  <td>{row.tenantName}</td>
                  <td>
                    <code>{row.tenantCode}</code>
                  </td>
                  <td>{row.inApp}</td>
                  <td>{row.emails}</td>
                  <td>{row.reads}</td>
                  <td>{dateTime(row.lastReadAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ───────────────────────────────────────────────────── الكتابة

function ComposeTab({ editing, onSaved }: { editing: Announcement | null; onSaved: () => void }) {
  const [titleAr, setTitleAr] = useState(editing?.titleAr ?? '');
  const [titleEn, setTitleEn] = useState(editing?.titleEn ?? '');
  const [bodyAr, setBodyAr] = useState(editing?.bodyAr ?? '');
  const [bodyEn, setBodyEn] = useState(editing?.bodyEn ?? '');
  const [audience, setAudience] = useState<AnnouncementAudience>(editing?.audience ?? 'all');
  const [planCode, setPlanCode] = useState(editing?.planCode ?? '');
  const [tenantStatus, setTenantStatus] = useState<AnnouncementTargetStatus>(
    editing?.tenantStatus ?? 'active',
  );
  const [channels, setChannels] = useState<AnnouncementChannel[]>(editing?.channels ?? ['in_app', 'email']);
  const [publishAt, setPublishAt] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<'ar' | 'en'>('ar');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const plans = useQuery<Array<{ code: string; name: string }>>(
    () => apiData<Array<{ code: string; name: string }>>('/platform/plans?limit=50'),
    [],
  );

  const payload = {
    titleAr: titleAr.trim(),
    titleEn: titleEn.trim(),
    bodyAr: bodyAr.trim(),
    bodyEn: bodyEn.trim(),
    audience,
    planCode: audience === 'plan' ? planCode.trim() : null,
    tenantStatus: audience === 'status' ? tenantStatus : null,
    channels,
    publishAt: publishAt ? toIso(publishAt) : null,
    reason: reason.trim() || 'كتابة إعلانٍ من شاشة الإعلانات',
  };

  async function save(saveAs: 'draft' | 'scheduled') {
    setBusy(true);
    setNotice(undefined);
    try {
      const body = saveAs === 'draft' ? { ...payload, publishAt: null } : payload;
      const saved = editing
        ? await apiData<Announcement>(`/platform/announcements/${editing.id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : await apiData<Announcement>('/platform/announcements', {
            method: 'POST',
            body: JSON.stringify(body),
          });
      setNotice({
        kind: 'ok',
        text:
          saved.status === 'scheduled'
            ? `حُفظت مجدولةً على ${dateTime(saved.publishAt)} — ولها مهمّةٌ في الطابور تنشرها في وقتها.`
            : 'حُفظت مسودّة. لا شيء خرج إلى العملاء بعد.',
      });
      onSaved();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function publishNow() {
    setBusy(true);
    setNotice(undefined);
    try {
      const target = editing
        ? await apiData<Announcement>(`/platform/announcements/${editing.id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : await apiData<Announcement>('/platform/announcements', {
            method: 'POST',
            body: JSON.stringify({ ...payload, publishAt: null }),
          });
      const published = await apiData<Announcement>(`/platform/announcements/${target.id}/publish`, {
        method: 'POST',
        body: JSON.stringify({ reason: payload.reason }),
      });
      setNotice({
        kind: 'ok',
        text: `نُشرت: ${published.stats.tenants} منشأة · ${published.stats.inApp} إشعاراً · ${published.stats.emails} بريداً.`,
      });
      onSaved();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const toggleChannel = (channel: AnnouncementChannel) =>
    setChannels((current) =>
      current.includes(channel) ? current.filter((item) => item !== channel) : [...current, channel],
    );

  return (
    <section className="card">
      <div className="grid cols-2">
        <div className="grid">
          <label>
            العنوان (عربي)
            <input value={titleAr} onChange={(event) => setTitleAr(event.target.value)} maxLength={200} />
          </label>
          <label>
            Title (English)
            <input
              dir="ltr"
              value={titleEn}
              onChange={(event) => setTitleEn(event.target.value)}
              maxLength={200}
            />
          </label>
          <label>
            النصّ (عربي)
            <textarea
              rows={5}
              value={bodyAr}
              onChange={(event) => setBodyAr(event.target.value)}
              maxLength={5000}
            />
          </label>
          <label>
            Body (English)
            <textarea
              dir="ltr"
              rows={5}
              value={bodyEn}
              onChange={(event) => setBodyEn(event.target.value)}
              maxLength={5000}
            />
          </label>
        </div>

        <div className="grid">
          <label>
            الجمهور
            <select
              value={audience}
              onChange={(event) => setAudience(event.target.value as AnnouncementAudience)}
            >
              {announcementAudiences.map((value) => (
                <option key={value} value={value}>
                  {AUDIENCE_LABEL[value]}
                </option>
              ))}
            </select>
          </label>

          {audience === 'plan' && (
            <label>
              الباقة
              <input
                list="announcement-plans"
                value={planCode}
                onChange={(event) => setPlanCode(event.target.value)}
                placeholder="مثال: growth"
              />
              <datalist id="announcement-plans">
                {(plans.data ?? []).map((plan) => (
                  <option key={plan.code} value={plan.code}>
                    {plan.name}
                  </option>
                ))}
              </datalist>
            </label>
          )}

          {audience === 'status' && (
            <label>
              حالة المنشأة
              <select
                value={tenantStatus}
                onChange={(event) => setTenantStatus(event.target.value as AnnouncementTargetStatus)}
              >
                <option value="active">نشطة</option>
                <option value="suspended">معلّقة</option>
                <option value="archived">مؤرشفة</option>
              </select>
            </label>
          )}

          <fieldset>
            <legend>القنوات</legend>
            {announcementChannels.map((channel) => (
              <label key={channel} className="row" style={{ gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={channels.includes(channel)}
                  onChange={() => toggleChannel(channel)}
                />
                <span>{CHANNEL_LABEL[channel]}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {channel === 'in_app' ? 'لكل عضوٍ نشط' : 'لمالك المنشأة وحده'}
                </span>
              </label>
            ))}
          </fieldset>

          <label>
            الجدولة (اتركها فارغةً للنشر اليدوي)
            <input
              type="datetime-local"
              dir="ltr"
              value={publishAt}
              onChange={(event) => setPublishAt(event.target.value)}
            />
            <span className="muted" style={{ fontSize: 12 }}>
              الوقت الماضي مرفوض؛ والوقت المستقبلي يضع الإعلان «مجدولة» ومعه مهمّةٌ تنشره في وقته.
            </span>
          </label>

          <label>
            سبب التغيير (يُكتب في سجل التدقيق)
            <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} />
          </label>
        </div>
      </div>

      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Tabs<'ar' | 'en'>
          value={preview}
          onChange={setPreview}
          items={[
            { id: 'ar', label: 'معاينة عربية' },
            { id: 'en', label: 'Preview English' },
          ]}
        />
      </div>

      <article className="card" style={{ background: 'var(--surface)' }}>
        <strong>{preview === 'ar' ? titleAr || '—' : titleEn || '—'}</strong>
        <p dir={preview === 'ar' ? 'rtl' : 'ltr'} style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>
          {preview === 'ar' ? bodyAr || '—' : bodyEn || '—'}
        </p>
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
          {AUDIENCE_LABEL[audience]}
          {audience === 'plan' && planCode ? ` · ${planCode}` : ''}
          {audience === 'status' ? ` · ${tenantStatus}` : ''} ·{' '}
          {channels.map((channel) => CHANNEL_LABEL[channel]).join(' · ') || 'بلا قناة'}
        </p>
      </article>

      {notice && (
        <p className={`alert ${notice.kind === 'ok' ? 'ok' : 'danger'}`} style={{ margin: 0 }}>
          {notice.text}
        </p>
      )}

      <div className="row" style={{ gap: 8 }}>
        <button className="btn" type="button" disabled={busy} onClick={() => void save('draft')}>
          حفظ مسودّة
        </button>
        <button
          className="btn"
          type="button"
          disabled={busy || !publishAt}
          onClick={() => void save('scheduled')}
        >
          حفظ مجدولة
        </button>
        <button className="btn primary" type="button" disabled={busy} onClick={() => void publishNow()}>
          نشر الآن
        </button>
        <button className="btn" type="button" disabled={busy} onClick={onSaved}>
          إلغاء
        </button>
      </div>
    </section>
  );
}
