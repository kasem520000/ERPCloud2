'use client';

import { useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiPost } from '../../../lib/api';
import { useSession } from '../../../lib/session';

type SupportTicket = {
  id: string;
  subject: string;
  status: 'open' | 'pending' | 'resolved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  category: string | null;
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  messageCount: number;
};

type TicketMessage = {
  id: string;
  authorLabel: string | null;
  authorKind: 'operator' | 'customer' | 'system';
  body: string;
  createdAt: string;
};

type TicketDetail = SupportTicket & {
  messages: TicketMessage[];
};

const STATUS_LABELS: Record<SupportTicket['status'], string> = {
  open: 'مفتوحة — بانتظار رد الدعم',
  pending: 'تم الرد — بانتظارك',
  resolved: 'تم الحل',
  closed: 'مغلقة',
};

const PRIORITY_LABELS: Record<SupportTicket['priority'], string> = {
  low: 'منخفضة',
  normal: 'عادية',
  high: 'عالية',
  urgent: 'عاجلة',
};

const CATEGORIES = [
  'محاسبة وقيود',
  'المخزون والمستودعات',
  'المبيعات ونقطة البيع (POS)',
  'الفوترة الإلكترونية (ZATCA)',
  'توزيع المناديب والمخابز',
  'سوق الإضافات والباقات',
  'الموارد البشرية وتطبيق الموظف',
  'استفسار عام / اقتراح',
];

export default function HelpPage() {
  const { me } = useSession();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0] ?? 'محاسبة وقيود');
  const [priority, setPriority] = useState<SupportTicket['priority']>('normal');
  const [body, setBody] = useState('');
  const [replyText, setReplyText] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string }>();

  async function reload(selectId?: string) {
    const list = await apiData<SupportTicket[]>('/support/tickets');
    const rows = Array.isArray(list) ? list : [];
    setTickets(rows);
    const targetId = selectId ?? selected?.id ?? rows[0]?.id;
    if (targetId) {
      const detail = await apiData<TicketDetail>(`/support/tickets/${targetId}`).catch(() => null);
      setSelected(detail);
    }
  }

  useEffect(() => {
    void reload().catch((error: unknown) =>
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر تحميل التذاكر' }),
    );
  }, []);

  async function submitNewTicket(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const created = await apiPost<TicketDetail>('/support/tickets', {
        subject: subject.trim(),
        category,
        priority,
        body: body.trim(),
      });
      setSubject('');
      setBody('');
      setCreating(false);
      setNotice({
        kind: 'ok',
        text: `تم إرسال طلب المساعدة «${created.subject}» إلى مدير المنصة بنجاح. سيصلك إشعار فور الرد.`,
      });
      await reload(created.id);
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : 'تعذر إرسال طلب المساعدة',
      });
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !replyText.trim()) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const updated = await apiPost<TicketDetail>(`/support/tickets/${selected.id}/reply`, {
        body: replyText.trim(),
      });
      setReplyText('');
      setSelected(updated);
      setNotice({ kind: 'ok', text: 'تم إرسال ردك إلى فريق الدعم الفني بالمنصة.' });
      await reload(updated.id);
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : 'تعذر إرسال الرد',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="🛟 طلب المساعدة والدعم الفني"
      subtitle="تواصل مباشر مع إدارة المنصة — أرسل استفسارك أو مشكلتك وسيظهر إشعار فوري لمدير المنصة، وعند الرد يصلك إشعار في جرس التنبيهات."
      crumbs={['طلب المساعدة']}
      actions={
        <button className="btn primary" type="button" onClick={() => setCreating(!creating)}>
          {creating ? 'إغلاق النموذج' : '➕ فتح طلب مساعدة جديد'}
        </button>
      }
    >
      {notice ? <Notice notice={notice} /> : null}

      {(creating || tickets.length === 0) && (
        <form className="card" onSubmit={submitNewTicket} style={{ display: 'grid', gap: 12 }}>
          <h2 style={{ margin: 0 }}>📩 إرسال رسالة / تذكرة جديدة لمدير المنصة</h2>
          <p className="muted" style={{ margin: 0 }}>
            المنشأة: <strong>{me?.membership.tenantName}</strong> (<span dir="ltr">{me?.membership.tenantCode}</span>) · المستخدم:{' '}
            <span dir="ltr">{me?.user.email}</span>
          </p>
          <div className="form-grid">
            <label className="field">
              <span>عنوان الطلب *</span>
              <input
                className="input"
                required
                minLength={3}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="مثال: استفسار حول تفعيل باقة التوزيع أو إعداد ضريبة القيمة المضافة"
              />
            </label>
            <label className="field">
              <span>القسم / التصنيف</span>
              <select className="input" value={category} onChange={(event) => setCategory(event.target.value)}>
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>الأولوية</span>
              <select
                className="input"
                value={priority}
                onChange={(event) => setPriority(event.target.value as SupportTicket['priority'])}
              >
                <option value="low">منخفضة</option>
                <option value="normal">عادية</option>
                <option value="high">عالية</option>
                <option value="urgent">عاجلة</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>تفاصيل المشكلة أو الطلب *</span>
            <textarea
              className="input"
              rows={4}
              required
              minLength={3}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="اشرح ما تحتاجه بالتفصيل ليتمكن فريق المنصة من خدمتك فوراً…"
            />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" type="submit" disabled={busy || subject.trim().length < 3 || body.trim().length < 3}>
              {busy ? 'جارٍ الإرسال…' : '🚀 إرسال إلى إدارة المنصة'}
            </button>
          </div>
        </form>
      )}

      <div className="split">
        <div className="card tight split-list">
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
            <strong>سجل تذاكر الدعم ({tickets.length})</strong>
          </div>
          {tickets.length === 0 ? (
            <p className="muted" style={{ padding: 14 }}>
              لا توجد تذاكر سابقة. افتح تذكرة جديدة للتواصل مع الدعم الفني.
            </p>
          ) : (
            tickets.map((ticket) => (
              <button
                key={ticket.id}
                type="button"
                className={`list-row${selected?.id === ticket.id ? ' active' : ''}`}
                onClick={() => {
                  void apiData<TicketDetail>(`/support/tickets/${ticket.id}`).then(setSelected);
                }}
              >
                <span className="list-title">{ticket.subject}</span>
                <span className="list-sub">
                  {ticket.category ?? 'عام'} · {new Date(ticket.createdAt).toLocaleDateString('ar-SA')}
                </span>
                <span className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
                  <span
                    className={`badge ${
                      ticket.status === 'pending'
                        ? 'ok'
                        : ticket.status === 'open'
                          ? 'warn'
                          : 'neutral'
                    }`}
                  >
                    {STATUS_LABELS[ticket.status]}
                  </span>
                  <span className="muted small">{PRIORITY_LABELS[ticket.priority]}</span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="card split-detail">
          {!selected ? (
            <p className="muted">اختر تذكرة من القائمة لعرض المحادثة والردود.</p>
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <h2 style={{ margin: 0 }}>{selected.subject}</h2>
                  <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                    {selected.category ?? 'عام'} · الأولوية: {PRIORITY_LABELS[selected.priority]} · فُتحت في:{' '}
                    {new Date(selected.createdAt).toLocaleString('ar-SA')}
                  </p>
                </div>
                <span
                  className={`badge ${
                    selected.status === 'pending' ? 'ok' : selected.status === 'open' ? 'warn' : 'neutral'
                  }`}
                >
                  {STATUS_LABELS[selected.status]}
                </span>
              </div>

              <div style={{ display: 'grid', gap: 10 }}>
                {selected.messages.map((msg) => (
                  <div
                    key={msg.id}
                    style={{
                      padding: 12,
                      borderRadius: 12,
                      border: '1px solid var(--line)',
                      background: msg.authorKind === 'operator' ? 'var(--surface-2)' : 'var(--surface)',
                    }}
                  >
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                      <strong>
                        {msg.authorKind === 'operator'
                          ? `👨‍💻 دعم المنصة (${msg.authorLabel ?? 'الإدارة'})`
                          : `👤 أنت (${msg.authorLabel ?? me?.user.fullName ?? 'العميل'})`}
                      </strong>
                      <span className="muted small" dir="ltr">
                        {new Date(msg.createdAt).toLocaleString('ar-SA')}
                      </span>
                    </div>
                    <p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{msg.body}</p>
                  </div>
                ))}
              </div>

              {selected.status !== 'closed' && (
                <form onSubmit={sendReply} style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                  <label className="field">
                    <span>إضافة رد أو توضيح لفريق الدعم</span>
                    <textarea
                      className="input"
                      rows={3}
                      value={replyText}
                      onChange={(event) => setReplyText(event.target.value)}
                      placeholder="اكتب ردك هنا…"
                    />
                  </label>
                  <div>
                    <button className="btn primary" type="submit" disabled={busy || !replyText.trim()}>
                      {busy ? 'جارٍ الإرسال…' : 'إرسال الرد'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </Screen>
  );
}
