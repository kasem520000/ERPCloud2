'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ticketPriorities,
  ticketStatuses,
  type TicketDetail,
  type TicketPriority,
  type TicketStatus,
} from '@erp/contracts';

import { ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { ApiError, apiData } from '../../../lib/api';
import { useQuery } from '../../../lib/use-query';

/**
 * تذكرةٌ واحدة — «ماذا قال العميل، وماذا قيل له» (P-C8).
 *
 * شاشةٌ واحدة تعرض الرسائل بترتيبها الزمني، والملاحظة الداخلية عليها وسمٌ ظاهر (فلا
 * يقرأها المشغّل على أنها رسالةٌ وصلت العميل)، والردّ إمّا عامٌّ يوقف عدّاد الاستجابة أو
 * ملاحظةٌ لا توقفه. والانتقالات محدودة بما يسمح به الـAPI: المغلقة لا تُفتح، والمغلقة لا
 * تُردّ عليها.
 */

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'مفتوحة',
  pending: 'بانتظار العميل',
  resolved: 'محلولة',
  closed: 'مغلقة',
};

const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: 'منخفضة',
  normal: 'عادية',
  high: 'عالية',
  urgent: 'عاجلة',
};

/**
 * «ردود جاهزة» (الخطة §4): نصوصٌ قصيرة يبدأ منها المشغّل ثم يخصّصها. محتوى واجهةٍ بحت —
 * لا يُملي على العميل شيئاً، وكلٌّ منها يبقى قابلاً للتعديل قبل الإرسال.
 */
const CANNED_REPLIES: ReadonlyArray<{ id: string; label: string; body: string }> = [
  {
    id: 'received',
    label: 'استلمنا الطلب',
    body: 'وصلنا طلبك وفتحنا له تذكرة. سنوافيك بالنتيجة بعد المراجعة، ونعتذر عن أي إزعاج.',
  },
  {
    id: 'need_info',
    label: 'نحتاج تفصيلاً',
    body: 'لإتمام المراجعة نحتاج: رقم المستند، ووقت المحاولة، ونصّ الخطأ كما ظهر. يمكنك الردّ على هذه الرسالة مباشرةً.',
  },
  {
    id: 'fixed',
    label: 'أُصلح الأمر',
    body: 'أُعيد ضبط الإعداد من جهتنا، والوضع الآن سليم. جرّب إعادة المحاولة وأخبرنا بالنتيجة.',
  },
  {
    id: 'closing',
    label: 'إغلاق مؤقّت',
    body: 'لم نرَ ردّاً خلال المتابعة. سنغلق التذكرة مؤقتاً؛ يكفي أن تردّ في أي وقت لتُفتح من جديد.',
  },
];

function dateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('ar-SA') : '—';
}

function apiMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isForbidden) return 'تحتاج صلاحية «مكتب الدعم» (console.support.manage) لهذا الإجراء.';
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export default function TicketDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  const ticket = useQuery<TicketDetail>(() => apiData<TicketDetail>(`/platform/tickets/${id}`), [id]);

  return (
    <Screen
      title={ticket.data?.subject ?? 'تذكرة'}
      subtitle="الرسائل بترتيبها، والملاحظة الداخلية موسومة. الردّ العام يوقف عدّاد الاستجابة، والملاحظة لا توقفه."
      crumbs={['الدعم', 'التذاكر']}
      actions={
        <Link className="btn" href="/tickets">
          عودة إلى الصندوق
        </Link>
      }
    >
      {ticket.status === 'loading' && <Loading rows={3} />}
      {ticket.status === 'forbidden' && <Forbidden />}
      {ticket.status === 'error' && <ErrorBox message={ticket.error} onRetry={ticket.reload} />}
      {ticket.status === 'success' && ticket.data && (
        <TicketBody ticket={ticket.data} onChanged={ticket.reload} />
      )}
    </Screen>
  );
}

function TicketBody({ ticket, onChanged }: { ticket: TicketDetail; onChanged: () => void }) {
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [reason, setReason] = useState('');

  const call = useCallback(
    async (path: string, method: 'POST' | 'PATCH', payload: unknown, okText: string) => {
      setBusy(true);
      setNotice(undefined);
      try {
        await apiData<TicketDetail>(path, { method, body: JSON.stringify(payload) });
        setNotice({ kind: 'ok', text: okText });
        onChanged();
        return true;
      } catch (error) {
        setNotice({ kind: 'danger', text: apiMessage(error) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  async function sendReply() {
    const sent = await call(
      `/platform/tickets/${ticket.id}/reply`,
      'POST',
      { body, isInternal: internal, ...(reason.trim() ? { reason } : {}) },
      internal ? 'قُيّدت الملاحظة الداخلية — لا تُرسل إلى العميل.' : 'أُرسل الردّ — توقف عدّاد الاستجابة.',
    );
    if (sent) {
      setBody('');
      setReason('');
    }
  }

  return (
    <div className="grid">
      <section className="card tight">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <p style={{ margin: 0 }}>
              <span className={`chip${ticket.status === 'open' ? ' on' : ''}`}>
                {STATUS_LABEL[ticket.status]}
              </span>{' '}
              <span className={`chip${ticket.priority === 'urgent' ? ' on' : ''}`}>
                {PRIORITY_LABEL[ticket.priority]}
              </span>{' '}
              {ticket.category ? <span className="chip">{ticket.category}</span> : null}
            </p>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              {ticket.tenantName ?? '—'} ({ticket.tenantCode ?? '—'}) · المكلَّف:{' '}
              {ticket.assignedToLabel ?? 'بلا إسناد'}
            </p>
          </div>
          <div className="muted" style={{ textAlign: 'left' }}>
            <p style={{ margin: 0 }}>فُتحت: {dateTime(ticket.createdAt)}</p>
            <p style={{ margin: 0 }}>المهلة: {dateTime(ticket.slaDueAt)}</p>
            <p style={{ margin: 0 }}>
              أول ردّ: {ticket.firstResponseAt ? dateTime(ticket.firstResponseAt) : 'لم يحدث بعد'}
            </p>
            <p style={{ margin: 0 }}>أُغلقت: {ticket.closedAt ? dateTime(ticket.closedAt) : '—'}</p>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>المحادثة</h2>
        <ul className="thread">
          {ticket.messages.map((message) => (
            <li key={message.id} className={message.isInternal ? 'note' : message.authorKind}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>
                  {message.authorKind === 'operator'
                    ? `مشغّل · ${message.authorLabel ?? '—'}`
                    : message.authorKind === 'customer'
                      ? `العميل · ${message.authorLabel ?? '—'}`
                      : 'النظام'}
                  {message.isInternal && <span className="chip on"> ملاحظة داخلية</span>}
                </strong>
                <span className="muted">{dateTime(message.createdAt)}</span>
              </div>
              <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{message.body}</p>
            </li>
          ))}
        </ul>
      </section>

      {ticket.status !== 'closed' && (
        <section className="card grid">
          <h2 style={{ marginTop: 0 }}>ردّ</h2>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {CANNED_REPLIES.map((reply) => (
              <button key={reply.id} className="btn" type="button" onClick={() => setBody(reply.body)}>
                {reply.label}
              </button>
            ))}
          </div>
          <label>
            النصّ
            <textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} />
          </label>
          <div className="row">
            <label className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={internal}
                onChange={(event) => setInternal(event.target.checked)}
              />
              <span>ملاحظة داخلية (لا تُرسل إلى العميل ولا توقف عدّاد الاستجابة)</span>
            </label>
            <label>
              السبب (اختياري)
              <input value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <button
              className="btn"
              type="button"
              disabled={busy || body.trim().length < 2}
              onClick={() => void sendReply()}
            >
              {internal ? 'قيّد الملاحظة' : 'أرسل الردّ'}
            </button>
          </div>
        </section>
      )}

      <section className="card grid">
        <h2 style={{ marginTop: 0 }}>إجراءات التذكرة</h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label>
            الحالة
            <select
              value=""
              disabled={busy}
              onChange={(event) =>
                void call(
                  `/platform/tickets/${ticket.id}`,
                  'PATCH',
                  { status: event.target.value as TicketStatus, reason: 'تحديث حالة من مكتب الدعم' },
                  'حُدّثت الحالة.',
                )
              }
            >
              <option value="">اختر…</option>
              {ticketStatuses
                .filter(
                  (value) => value !== ticket.status && !(ticket.status === 'closed' && value !== 'closed'),
                )
                .map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABEL[value]}
                  </option>
                ))}
            </select>
          </label>
          <label>
            الأولوية
            <select
              value=""
              disabled={busy}
              onChange={(event) =>
                void call(
                  `/platform/tickets/${ticket.id}`,
                  'PATCH',
                  { priority: event.target.value as TicketPriority, reason: 'تغيير أولوية من مكتب الدعم' },
                  'حُدّثت الأولوية وأُعيد حساب المهلة من الآن.',
                )
              }
            >
              <option value="">اختر…</option>
              {ticketPriorities
                .filter((value) => value !== ticket.priority)
                .map((value) => (
                  <option key={value} value={value}>
                    {PRIORITY_LABEL[value]}
                  </option>
                ))}
            </select>
          </label>
          {ticket.assignedTo && (
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() =>
                void call(
                  `/platform/tickets/${ticket.id}`,
                  'PATCH',
                  { assignedTo: null, reason: 'سحب الإسناد ليعود إلى الصندوق' },
                  'سُحب الإسناد.',
                )
              }
            >
              اسحب الإسناد
            </button>
          )}
        </div>
        {notice && (
          <p className={`alert ${notice.kind === 'ok' ? 'ok' : 'danger'}`} style={{ margin: 0 }}>
            {notice.text}
          </p>
        )}
      </section>
    </div>
  );
}
