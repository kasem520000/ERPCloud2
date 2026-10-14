'use client';

import { useState } from 'react';
import {
  IMPERSONATION_MAX_MINUTES,
  IMPERSONATION_MIN_MINUTES,
  type ImpersonationSession,
  type ImpersonationStartResult,
} from '@erp/contracts';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { ApiError, apiData, apiDelete, apiPost } from '../../lib/api';
import { useQuery } from '../../lib/use-query';

/**
 * الدخول المؤقّت — `break-glass` (P-C8، `docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * الشاشة تعرض ما تسمح به الشاشة، ويبقى الفرض على الـAPI: الحارس يمنع الحذف ومسّ
 * `/auth/`، ويقرأ صفّ الجلسة في كل طلب — فالإنهاء من هنا يُسقط الرمز في الطلب التالي.
 *
 * ثلاثة قرارات تظهر في الشاشة لا تُخفى:
 *
 *   * **السبب مكتوبٌ ويُقرأ للعميل**: يظهر في سجلّ المنشأة وفي التدقيق، والمدّة سقفها
 *     60 دقيقة في العقد (لا في الواجهة).
 *   * **الرمز يمرَّر في جزء العنوان** (`#support=…`): الجزء لا يُرسل إلى أي خادم ولا يُكتب
 *     في سجلّ الوسيط، ويُنظَّف من العنوان بمجرّد أن يقرأه تطبيق العميل. والبديل — النسخ
 *     واللصق في شاشة الدخول — يترك الرمز في الحافظة بلا حاجة.
 *   * **السجلّ لا يُمحى**: «الإنهاء» يكتب `ended_at`، ولا يحذف صفّاً — أثرُ من دخل باسم من
 *     يبقى.
 */

const STATUS_LABEL: Record<ImpersonationSession['status'], string> = {
  active: 'نشطة',
  ended: 'أُنهيت',
  expired: 'انتهت بوقتها',
};

function dateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('ar-SA') : '—';
}

function apiMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isForbidden) return 'تحتاج صلاحية «مكتب الدعم» (console.support.manage) لهذا الدخول.';
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * عنوان تطبيق العميل (الـstaff). يُشتقّ من عنوان اللوحة نفسها بمبدّل المنفذ المتعارف عليه
 * في البيئة المحلية (3003 → 3001)، ويُضبط صراحةً بـ`NEXT_PUBLIC_STAFF_URL` في النشر
 * المفصول. لا `localhost` مكتوبٌ في الكود: المتصفّح ليس الخادم.
 */
function staffUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_STAFF_URL ?? '').trim().replace(/\/+$/, '');
  if (configured.length > 0) return configured;
  if (typeof window === 'undefined') return '';
  return `${window.location.protocol}//${window.location.hostname}:3001`;
}

export default function ImpersonationPage() {
  const sessions = useQuery<ImpersonationSession[]>(
    () => apiData<ImpersonationSession[]>('/platform/impersonate/sessions'),
    [],
  );
  const tenants = useQuery<Array<{ id: string; code: string; name: string }>>(
    () => apiData<Array<{ id: string; code: string; name: string }>>('/platform/tenants?limit=100'),
    [],
  );

  const [tenantId, setTenantId] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<ImpersonationStartResult | null>(null);

  const active = (sessions.data ?? []).find((session) => session.status === 'active');

  async function start() {
    setBusy(true);
    setNotice(undefined);
    setStarted(null);
    try {
      const result = await apiPost<ImpersonationStartResult>('/platform/impersonate', {
        tenantId,
        reason,
        minutes,
      });
      setStarted(result);
      setNotice({
        kind: 'ok',
        text: `فُتحت جلسةٌ تنتهي في ${dateTime(result.session.expiresAt)} — الرمز لا يعمل بعد إنهائها أو انتهائها.`,
      });
      setReason('');
      sessions.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function end(session: ImpersonationSession) {
    if (!window.confirm(`إنهاء الجلسة على «${session.tenantName ?? session.tenantId}»؟ الرمز يسقط فوراً.`))
      return;
    setBusy(true);
    setNotice(undefined);
    try {
      await apiDelete(`/platform/impersonate/${session.id}`);
      setNotice({ kind: 'ok', text: 'أُنهيت الجلسة — الرمز لم يبقَ صالحاً.' });
      setStarted(null);
      sessions.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const ready = tenantId.length > 0 && reason.trim().length >= 10;

  return (
    <Screen
      title="الدخول المؤقّت"
      subtitle={`نظرةٌ بعين العميل عند الحاجة: سببٌ مكتوب، ومدّةٌ من ${IMPERSONATION_MIN_MINUTES} إلى ${IMPERSONATION_MAX_MINUTES} دقيقة، ورمزٌ لا يعمل بعد الإنهاء — ولا حذفَ ولا مسّاً بالمصادقة خلاله.`}
      crumbs={['الدعم']}
    >
      {active && (
        <section className="card tight">
          <p className="alert danger" style={{ margin: 0 }}>
            جلسةٌ نشطة الآن على «{active.tenantName ?? active.tenantId}» ({active.operatorLabel ?? '—'}) —
            تنتهي {dateTime(active.expiresAt)}. أنهِها إن لم تكن قيد العمل.
          </p>
        </section>
      )}

      <section className="card grid">
        <h2 style={{ marginTop: 0 }}>جلسةٌ جديدة</h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label>
            المنشأة
            <select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
              <option value="">اختر منشأة…</option>
              {(tenants.data ?? []).map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name} ({tenant.code})
                </option>
              ))}
            </select>
          </label>
          <label>
            المدّة (دقائق)
            <input
              type="number"
              min={IMPERSONATION_MIN_MINUTES}
              max={IMPERSONATION_MAX_MINUTES}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
            />
          </label>
        </div>
        <label>
          السبب (يُقرأ للعميل في سجلّه، ويُقيَّد في التدقيق)
          <textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="row">
          <button className="btn" type="button" disabled={!ready || busy} onClick={() => void start()}>
            {busy ? 'جارٍ…' : 'ابدأ الجلسة'}
          </button>
          <p className="muted" style={{ margin: 0 }}>
            لا يُفتح بابٌ لمنشأةٍ بلا مالكٍ نشط، والرمز يُصدر باسم عضويّة المالك.
          </p>
        </div>
        {notice && (
          <p className={`alert ${notice.kind === 'ok' ? 'ok' : 'danger'}`} style={{ margin: 0 }}>
            {notice.text}
          </p>
        )}
        {started && (
          <div className="card tight">
            <p style={{ margin: 0 }}>
              الرمز صالحٌ حتى {dateTime(started.session.expiresAt)} ({started.expiresIn} ثانية)، ولا يُجدَّد.
            </p>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <a
                className="btn"
                href={`${staffUrl()}/#support=${started.accessToken}`}
                target="_blank"
                rel="noreferrer"
              >
                افتح منشأة العميل
              </a>
              <button
                className="btn"
                type="button"
                onClick={() => void navigator.clipboard?.writeText(started.accessToken)}
              >
                انسخ الرمز
              </button>
              <span className="muted">الرمز يمرّ في جزء العنوان، ولا يُرسل إلى أي خادم.</span>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>سجلّ الجلسات</h2>
        {sessions.status === 'loading' && <Loading rows={3} />}
        {sessions.status === 'forbidden' && <Forbidden />}
        {sessions.status === 'error' && <ErrorBox message={sessions.error} onRetry={sessions.reload} />}
        {sessions.status === 'success' && (sessions.data?.length ?? 0) === 0 && (
          <Empty title="لا جلسات بعد" detail="كل دخولٍ مؤقّت يُكتب هنا بمن دخله وسببه ومدّته." />
        )}
        {sessions.status === 'success' && (sessions.data?.length ?? 0) > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المنشأة</th>
                  <th>المشغّل</th>
                  <th>السبب</th>
                  <th>البداية</th>
                  <th>النهاية</th>
                  <th>الحالة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(sessions.data ?? []).map((session) => (
                  <tr key={session.id}>
                    <td>
                      {session.tenantName ?? '—'}
                      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                        {session.tenantCode ?? ''} · باسم {session.asUserLabel ?? '—'}
                      </p>
                    </td>
                    <td>{session.operatorLabel ?? session.operatorUserId}</td>
                    <td>{session.reason}</td>
                    <td>{dateTime(session.startedAt)}</td>
                    <td>{dateTime(session.endedAt ?? session.expiresAt)}</td>
                    <td>
                      <span className={`chip${session.status === 'active' ? ' on' : ''}`}>
                        {STATUS_LABEL[session.status]}
                      </span>
                    </td>
                    <td>
                      {session.status === 'active' && (
                        <button
                          className="btn danger"
                          type="button"
                          disabled={busy}
                          onClick={() => void end(session)}
                        >
                          إنهاء
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Screen>
  );
}
