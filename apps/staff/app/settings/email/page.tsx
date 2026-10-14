'use client';

import { useState } from 'react';
import {
  emailEventDefinition,
  emailEvents,
  emailMessageStatuses,
  type EmailLocale,
  type EmailMessage,
  type EmailMessageListResponse,
  type EmailSettings,
  type EmailTemplate,
  type EmailTemplateListResponse,
} from '@erp/contracts';

import { Notice } from '../../../components/data-view';
import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { Tabs } from '../../../components/ui';
import { ApiError, apiData } from '../../../lib/api';
import { useQuery } from '../../../lib/use-query';
import { useSession } from '../../../lib/session';

/**
 * ✉️ البريد — سطح منشأتك (P-C6، `docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §7.3).
 *
 * لا مقابل لهذه الشاشة في `Desktop_ERP`: النسخة المكتبية أرسلت بريداً واحداً — منح وصول
 * البوابة (`Class/Session.cs` عبر عميل البريد المحلّي) — بلا سجلّ ولا نصّ قابل للتعديل.
 * هنا ثلاثة تبويبات على ثلاثة أسئلة يملك العميل جوابها:
 *
 *   1. **قوالبي** — نصّ فعّال لكل حدثٍ ولغة، ومَن كتبه: المنصة أم نحن. والتجاوز **نصٌّ لا
 *      كود** (نصّ الخطة): لا نختار حدثاً جديداً، بل نصوغ نصّ حدثٍ قائم. و«أعِد نصّ المنصة»
 *      يكتب `null` في الحقل فيعود نصّها لذلك الحقل وحده.
 *   2. **سجلّي** — ما خرج باسم منشأتي: إلى مَن، وبأي حالة، وبأي مزوّد، ومحاولاتُه وآخر خطأ.
 *      والقراءة هنا «لمن يرى» وحدها (`tenant.email.log.view`): السجلّ لا يُعدَّل من هنا.
 *   3. **هوية المُرسِل** — الاسم العربي والعنوان و«ردّ إلى» والسقفان التشغيليان. أما
 *      **المزوّد** فيُختار من المنصة (اعتمادات SMTP في بيئة الخادم)، فلا يُعرض هنا إلا
 *      للقراءة — ويُرفض تغييره برسالةٍ صريحة لا بصمت.
 *
 * وما لا تقوله الشاشة لأنها لا تستطيع ادّعاءه: **لا زرّ إرسال**. الإرسال فعلُ حدثٍ (دعوة ·
 * فاتورة · تنبيه) وله مواضعه في النظام؛ وهنا يُقرأ ما خرج ويُصاغ نصّه.
 */

const STATUS_LABEL: Record<string, string> = {
  queued: 'في الطابور',
  sent: 'أُرسلت',
  failed: 'فشلت',
  suppressed: 'محجوبة',
  bounced: 'ارتدّت',
};

const LOCALE_LABEL: Record<EmailLocale, string> = { ar: 'العربية', en: 'English' };

type TabId = 'templates' | 'messages' | 'settings';

function dateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('ar-SA') : '—';
}

export default function EmailSettingsPage() {
  const session = useSession();
  const [tab, setTab] = useState<TabId>('templates');
  const canViewLog = session.can('tenant.email.log.view');
  const canEdit = session.can('tenant.email.template.manage');

  return (
    <Screen
      title="البريد"
      subtitle="نصوص الرسائل التي تخرج باسم منشأتك، وسجلّ ما خرج منها، وهوِيّة المُرسِل. النصّ الذي تكتبه هنا يخصّ منشأتك وحدها."
      crumbs={['الإعدادات', 'البريد']}
    >
      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        items={[
          ...(canEdit ? [{ id: 'templates' as const, label: 'قوالبي' }] : []),
          ...(canViewLog ? [{ id: 'messages' as const, label: 'سجلّي' }] : []),
          ...(canViewLog ? [{ id: 'settings' as const, label: 'هوية المُرسِل' }] : []),
        ]}
      />
      {tab === 'templates' && canEdit && <TemplatesTab />}
      {tab === 'messages' && canViewLog && <MessagesTab />}
      {tab === 'settings' && canViewLog && <SenderTab canEdit={canEdit} />}
    </Screen>
  );
}

// ───────────────────────────────────────────────────── القوالب

function TemplatesTab() {
  const [locale, setLocale] = useState<EmailLocale>('ar');
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  const [busy, setBusy] = useState(false);

  const list = useQuery<EmailTemplateListResponse>(() => {
    const params = new URLSearchParams({ locale });
    return apiData<EmailTemplateListResponse>(`/email/templates?${params.toString()}`);
  }, [locale]);

  function open(template: EmailTemplate) {
    setEditing(template);
    setSubject(template.subject);
    setBody(template.body);
    setReason('');
    setNotice(undefined);
  }

  async function save(revert: { subject?: null; body?: null } = {}) {
    if (!editing) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const saved = await apiData<EmailTemplate>(
        `/email/templates/${editing.event}?locale=${editing.locale}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            subject: revert.subject === null ? null : subject,
            body: revert.body === null ? null : body,
            ...(reason.trim().length >= 3 ? { reason } : {}),
          }),
        },
      );
      setEditing(saved);
      setNotice({
        kind: 'ok',
        text:
          saved.source === 'tenant'
            ? `حُفظ نصّك — النسخة ${saved.version}.`
            : 'عاد النصّ إلى نصّ المنصة — لم يبقَ تجاوزٌ لهذا الحدث.',
      });
      list.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  if (list.status === 'forbidden') return <Forbidden />;
  if (list.status === 'loading') return <Loading />;
  if (list.status === 'error') return <ErrorBox message={list.error} onRetry={list.reload} />;

  const rows = list.data?.data ?? [];
  const overridden = rows.filter((row) => row.source === 'tenant').length;

  return (
    <div className="grid">
      <div className="card tight">
        <div className="row">
          <label>
            اللغة
            <select value={locale} onChange={(change) => setLocale(change.target.value as EmailLocale)}>
              <option value="ar">{LOCALE_LABEL.ar}</option>
              <option value="en">{LOCALE_LABEL.en}</option>
            </select>
          </label>
          <button className="btn" type="button" onClick={list.reload}>
            تحديث
          </button>
        </div>
        <p className="muted">
          {rows.length} حدثاً في هذه اللغة، منها {overridden} بنصّك. «أعِد نصّ المنصة» يكتب نصّ المنصة في
          الحقل، وإن أعَدت الحقلين معاً حُذف تجاوزك وعاد الحدث إلى نصّها بالكامل.
        </p>
      </div>

      <Notice notice={notice} />

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>الحدث</th>
              <th>الموضوع</th>
              <th>النصّ</th>
              <th>المصدر</th>
              <th>المتغيّرات</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.event}>
                <td>{row.labelAr}</td>
                <td className="muted">{row.subject}</td>
                <td className="muted">
                  {row.body.split('\n')[0]?.slice(0, 60)}
                  {row.body.length > 60 ? '…' : ''}
                </td>
                <td>
                  <span className={`chip ${row.source === 'tenant' ? 'on' : ''}`}>
                    {row.source === 'tenant' ? 'نصّنا' : 'نصّ المنصة'}
                  </span>
                </td>
                <td className="muted">{row.variables.map((name) => `{{${name}}}`).join(' ')}</td>
                <td>
                  <button className="btn sm" type="button" onClick={() => open(row)}>
                    تحرير
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>{editing.labelAr}</h2>
          <p className="muted">
            المتغيّرات المعلَنة: {editing.variables.map((name) => `{{${name}}}`).join(' · ') || 'لا شيء'} —
            ومتغيّرٌ خارجها يُرفض عند الحفظ، فلا يخرج نصٌّ فيه متغيّرٌ مجهول إلى عميل.
          </p>
          <label>
            الموضوع
            <input value={subject} onChange={(change) => setSubject(change.target.value)} />
          </label>
          <label>
            النصّ
            <textarea rows={10} value={body} onChange={(change) => setBody(change.target.value)} />
          </label>
          <label>
            سبب التعديل (اختياري، يُسجَّل في تدقيق منشأتك)
            <input value={reason} onChange={(change) => setReason(change.target.value)} />
          </label>
          <div className="row">
            <button className="btn" type="button" disabled={busy} onClick={() => save()}>
              حفظ نصّي
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => save({ subject: null, body: null })}
            >
              أعِد نصّ المنصة
            </button>
            <button className="btn" type="button" onClick={() => setEditing(null)}>
              إغلاق
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────── السجلّ

function MessagesTab() {
  const [event, setEvent] = useState('');
  const [status, setStatus] = useState('');
  const list = useQuery<EmailMessageListResponse>(() => {
    const params = new URLSearchParams({ limit: '50' });
    if (event) params.set('event', event);
    if (status) params.set('status', status);
    return apiData<EmailMessageListResponse>(`/email/messages?${params.toString()}`);
  }, [event, status]);

  if (list.status === 'forbidden') return <Forbidden />;
  if (list.status === 'loading') return <Loading />;
  if (list.status === 'error') return <ErrorBox message={list.error} onRetry={list.reload} />;

  const rows = list.data?.data ?? [];
  const counts = list.data?.counts ?? {};

  return (
    <div className="grid">
      <div className="card tight">
        <div className="row">
          <label>
            الحدث
            <select value={event} onChange={(change) => setEvent(change.target.value)}>
              <option value="">كل الأحداث</option>
              {emailEvents.map((key) => (
                <option key={key} value={key}>
                  {emailEventDefinition(key).labelAr}
                </option>
              ))}
            </select>
          </label>
          <label>
            الحالة
            <select value={status} onChange={(change) => setStatus(change.target.value)}>
              <option value="">كل الحالات</option>
              {emailMessageStatuses.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" type="button" onClick={list.reload}>
            تحديث
          </button>
        </div>
        <p className="muted">
          {emailMessageStatuses.map((value) => `${STATUS_LABEL[value]}: ${counts[value] ?? 0}`).join(' · ')} —
          والرسائل التي تراها هي رسائل منشأتك وحدها.
        </p>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>الوقت</th>
              <th>إلى</th>
              <th>الحدث</th>
              <th>الحالة</th>
              <th>المحاولات</th>
              <th>آخر خطأ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row: EmailMessage) => (
              <tr key={row.id}>
                <td>{dateTime(row.sentAt ?? row.queuedAt)}</td>
                <td>
                  {row.toEmail}
                  {row.isTest && <span className="chip">اختبار</span>}
                </td>
                <td>{row.eventLabelAr}</td>
                <td>
                  <span
                    className={`chip ${row.status === 'sent' ? 'on' : row.status === 'failed' ? 'off' : ''}`}
                  >
                    {STATUS_LABEL[row.status]}
                  </span>
                </td>
                <td>{row.attempts}</td>
                <td className="muted">{row.lastError ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <Empty
            title="لا رسائل بعد"
            detail="سينبني السجلّ تلقائياً حين يرسل النظام أول رسالةٍ باسم منشأتك (دعوة · فاتورة · تنبيه)."
          />
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────── هوية المُرسِل ومزوّد البريد

function SenderTab({ canEdit }: { canEdit: boolean }) {
  const settings = useQuery<EmailSettings>(() => apiData<EmailSettings>('/email/settings'), []);
  const [draft, setDraft] = useState<Partial<EmailSettings>>({});
  const [apiKeyDraft, setApiKeyDraft] = useState<string | undefined>(undefined);
  const [smtpPasswordDraft, setSmtpPasswordDraft] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [probeTo, setProbeTo] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  const [busy, setBusy] = useState(false);

  if (settings.status === 'forbidden') return <Forbidden />;
  if (settings.status === 'loading') return <Loading />;
  if (settings.status === 'error') return <ErrorBox message={settings.error} onRetry={settings.reload} />;

  const current = settings.data;
  const value = <K extends keyof EmailSettings>(key: K): EmailSettings[K] | undefined =>
    draft[key] ?? current?.[key];

  const selectedProvider = value('provider') ?? 'console';

  async function save() {
    setBusy(true);
    setNotice(undefined);
    try {
      const payload: Record<string, unknown> = {
        provider: selectedProvider,
        fromName: value('fromName'),
        fromEmail: value('fromEmail'),
        replyTo: value('replyTo') || null,
        sendingDomain: value('sendingDomain') || null,
        ...(reason.trim().length >= 3 ? { reason } : {}),
      };
      if (apiKeyDraft !== undefined) {
        payload.apiKey = apiKeyDraft.trim() || null;
      }
      if (draft.apiEndpoint !== undefined) {
        payload.apiEndpoint = draft.apiEndpoint?.trim() || null;
      }
      if (draft.smtpHost !== undefined) {
        payload.smtpHost = draft.smtpHost?.trim() || null;
      }
      if (draft.smtpPort !== undefined) {
        payload.smtpPort = draft.smtpPort || null;
      }
      if (draft.smtpUser !== undefined) {
        payload.smtpUser = draft.smtpUser?.trim() || null;
      }
      if (smtpPasswordDraft !== undefined) {
        payload.smtpPassword = smtpPasswordDraft || null;
      }
      if (draft.smtpSecure !== undefined) {
        payload.smtpSecure = draft.smtpSecure;
      }

      const updated = await apiData<EmailSettings>('/email/settings/provider', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setDraft({});
      setApiKeyDraft(undefined);
      setSmtpPasswordDraft(undefined);
      setReason('');
      setNotice({
        kind: 'ok',
        text: `حُفظت إعدادات البريد — المزوّد الفعّال «${updated.provider}» والمُرسِل ${updated.fromName} <${updated.fromEmail}>.`,
      });
      settings.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    if (!probeTo.includes('@')) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await apiData<{ status: string; provider: string; to: string }>(
        '/email/settings/test',
        {
          method: 'POST',
          body: JSON.stringify({ to: probeTo.trim(), locale: 'ar' }),
        },
      );
      setNotice({
        kind: result.status === 'sent' ? 'ok' : 'danger',
        text:
          result.status === 'sent'
            ? `تم إرسال الرسالة التجريبية عبر «${result.provider}» إلى ${result.to}.`
            : `تعذر تسليم الرسالة التجريبية (${result.status}).`,
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>مزوّد البريد الإلكتروني وهوية المُرسِل</h2>
        <p className="muted">
          يمكنك الربط المباشر مع <strong>Resend</strong> أو خادم <strong>SMTP</strong> مخصّص أو بوابة{' '}
          <strong>HTTP Webhook / API</strong> لإرسال الفواتير واستعادة كلمات المرور والإشعارات.
        </p>

        <div className="row">
          <label>
            مزوّد خدمة البريد
            <select
              value={selectedProvider}
              disabled={!canEdit}
              onChange={(change) =>
                setDraft({ ...draft, provider: change.target.value as EmailSettings['provider'] })
              }
            >
              <option value="resend">Resend API (موصى به للسحابة)</option>
              <option value="smtp">SMTP — خادم بريد قياسي (TLS / STARTTLS)</option>
              <option value="http">HTTP API / Webhook — مزوّد بريد خارجي مخصّص</option>
              <option value="console">Console — سجلّ النظام الداخلي</option>
            </select>
          </label>
          <label>
            اسم المُرسِل
            <input
              value={value('fromName') ?? ''}
              disabled={!canEdit}
              onChange={(change) => setDraft({ ...draft, fromName: change.target.value })}
            />
          </label>
          <label>
            عنوان البريد المُرسِل
            <input
              value={value('fromEmail') ?? ''}
              disabled={!canEdit}
              dir="ltr"
              placeholder="noreply@yourdomain.com"
              onChange={(change) => setDraft({ ...draft, fromEmail: change.target.value })}
            />
          </label>
          <label>
            ردّ إلى (Reply-To)
            <input
              value={value('replyTo') ?? ''}
              disabled={!canEdit}
              dir="ltr"
              placeholder="support@yourdomain.com"
              onChange={(change) => setDraft({ ...draft, replyTo: change.target.value })}
            />
          </label>
          <label>
            نطاق الإرسال (Sending Domain)
            <input
              value={value('sendingDomain') ?? ''}
              disabled={!canEdit}
              dir="ltr"
              placeholder="mail.example.com"
              onChange={(change) => setDraft({ ...draft, sendingDomain: change.target.value })}
            />
          </label>
        </div>

        {(selectedProvider === 'resend' || selectedProvider === 'http') && (
          <div className="row" style={{ marginTop: 12 }}>
            <label style={{ flex: 2 }}>
              {selectedProvider === 'resend'
                ? 'مفتاح Resend API Key'
                : 'مفتاح المصادقة (Bearer API Key)'}
              <input
                type="password"
                dir="ltr"
                disabled={!canEdit}
                value={apiKeyDraft ?? ''}
                placeholder={
                  current?.apiKeyMasked
                    ? `محفوظ حالياً (${current.apiKeyMasked}) — اتركه فارغاً للإبقاء عليه`
                    : selectedProvider === 'resend'
                      ? 're_123456789...'
                      : 'Bearer token...'
                }
                onChange={(change) => setApiKeyDraft(change.target.value)}
              />
            </label>
            <label style={{ flex: 2 }}>
              {selectedProvider === 'resend'
                ? 'رابط Resend API (اختياري — الافتراضي https://api.resend.com/emails)'
                : 'رابط نقطة النهاية (HTTP Webhook URL)'}
              <input
                dir="ltr"
                disabled={!canEdit}
                value={value('apiEndpoint') ?? ''}
                placeholder={
                  selectedProvider === 'resend'
                    ? 'https://api.resend.com/emails'
                    : 'https://api.provider.com/v1/send'
                }
                onChange={(change) => setDraft({ ...draft, apiEndpoint: change.target.value })}
              />
            </label>
          </div>
        )}

        {selectedProvider === 'smtp' && (
          <div className="row" style={{ marginTop: 12 }}>
            <label>
              مُضيف SMTP (Host)
              <input
                dir="ltr"
                disabled={!canEdit}
                value={value('smtpHost') ?? ''}
                placeholder="smtp.resend.com أو smtp.office365.com"
                onChange={(change) => setDraft({ ...draft, smtpHost: change.target.value })}
              />
            </label>
            <label>
              المنفذ (Port)
              <input
                type="number"
                dir="ltr"
                disabled={!canEdit}
                value={value('smtpPort') ?? 587}
                onChange={(change) =>
                  setDraft({
                    ...draft,
                    smtpPort: change.target.value ? Number(change.target.value) : null,
                  })
                }
              />
            </label>
            <label>
              اسم مستخدم SMTP
              <input
                dir="ltr"
                disabled={!canEdit}
                value={value('smtpUser') ?? ''}
                placeholder="resend أو user@domain.com"
                onChange={(change) => setDraft({ ...draft, smtpUser: change.target.value })}
              />
            </label>
            <label>
              كلمة مرور SMTP
              <input
                type="password"
                dir="ltr"
                disabled={!canEdit}
                value={smtpPasswordDraft ?? ''}
                placeholder={current?.smtpConfigured ? '•••••••• (محفوظة)' : 'كلمة المرور أو مفتاح SMTP'}
                onChange={(change) => setSmtpPasswordDraft(change.target.value)}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 22 }}>
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={Boolean(value('smtpSecure'))}
                onChange={(change) => setDraft({ ...draft, smtpSecure: change.target.checked })}
              />
              اتصال TLS مباشر (منفذ 465)
            </label>
          </div>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <label>
            سبب التعديل (تدقيق اختياري)
            <input value={reason} disabled={!canEdit} onChange={(change) => setReason(change.target.value)} />
          </label>
          <button className="btn primary" type="button" disabled={!canEdit || busy} onClick={save}>
            حفظ الإعدادات
          </button>
          <button className="btn" type="button" onClick={settings.reload}>
            استرجاع
          </button>
        </div>

        <hr style={{ margin: '18px 0', border: 0, borderTop: '1px solid var(--line, #e2e8f0)' }} />

        <div className="row">
          <label style={{ flex: 1 }}>
            إرسال بريد تجريبي للتحقق من الاتصال
            <input
              type="email"
              dir="ltr"
              value={probeTo}
              disabled={!canEdit}
              placeholder="test@yourdomain.com"
              onChange={(change) => setProbeTo(change.target.value)}
            />
          </label>
          <button
            className="btn"
            type="button"
            disabled={!canEdit || busy || !probeTo.includes('@')}
            onClick={sendTest}
          >
            إرسال رسالة اختبار
          </button>
        </div>

        {!canEdit && (
          <p className="alert warn">قراءةٌ فقط: تعديل إعدادات البريد يحتاج صلاحية «إدارة قوالب البريد».</p>
        )}
        <p className="muted">
          المزوّد الفعّال حالياً: <strong>{current?.provider}</strong>
          {current?.apiKeyMasked ? ` · مفتاح API: ${current.apiKeyMasked}` : ''} — آخر تعديل:{' '}
          {dateTime(current?.updatedAt ?? null)}.
        </p>
      </div>

      <Notice notice={notice} />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>لماذا لا تصل الرسالة أحياناً؟</h2>
        <ul className="muted">
          <li>
            <strong>محجوبة</strong> — العنوان في قائمة الحجر (ارتداد سابق أو إلغاء اشتراك أو طلب العميل). لا
            تُستهلك محاولة: الحجر يمنع قبل الطابور.
          </li>
          <li>
            <strong>فشلت</strong> — حاول المُرسِل ثلاث مرات (بعد دقيقة، ثم خمس، ثم ثلاثين)، ثم توقّف. الإصلاح
            من المنصة: مزوّد البريد والإعدادات.
          </li>
          <li>
            <strong>في الطابور</strong> — الرسالة مسجَّلة ومهمّتها قائمة، ولم تُسلَّم بعد.
          </li>
        </ul>
      </div>
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isForbidden) return 'تحتاج صلاحية «إدارة قوالب البريد» لهذا الإجراء.';
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
