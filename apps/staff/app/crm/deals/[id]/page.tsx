'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Notice } from '../../../../components/data-view';
import { Screen } from '../../../../components/screen';
import { ApiError } from '../../../../lib/api';
import {
  addActivity,
  closeDeal,
  getDeal,
  listTemplates,
  sendDealWhatsapp,
  type CrmActivity,
  type CrmDealDetail,
  type CrmTemplate,
} from '../../../../lib/crm';

const types = [
  { id: 'call', label: 'اتصال' },
  { id: 'meeting', label: 'اجتماع' },
  { id: 'email', label: 'بريد مسجّل' },
  { id: 'note', label: 'ملاحظة' },
];

export default function CrmDealPage() {
  const params = useParams<{ id: string }>();
  const [deal, setDeal] = useState<CrmDealDetail>();
  const [templates, setTemplates] = useState<CrmTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [message, setMessage] = useState('');
  const [note, setNote] = useState('');
  const [type, setType] = useState('note');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string }>();

  async function reload() {
    setBusy(true);
    try {
      const [next, nextTemplates] = await Promise.all([getDeal(params.id), listTemplates()]);
      setDeal(next);
      setTemplates(nextTemplates);
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [params.id]);

  async function act(work: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await work();
      setNotice({ kind: 'ok', text: ok });
      setDeal(await getDeal(params.id));
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title={deal?.title ?? 'الصفقة'}
      subtitle={deal ? `${deal.value} · احتمال ${deal.probability}% · ${deal.partyName || 'بدون عميل'}` : undefined}
      crumbs={['المبيعات', 'مسار المبيعات', 'الصفقة']}
      actions={<Link className="btn" href="/crm/pipelines">العودة للمسار</Link>}
    >
      <Notice notice={notice} />
      <div className="card">
        <h3>واتساب</h3>
        <p className="muted">الرسالة الصادرة تُحفظ نشاطاً من نوع واتساب. لا يوجد إرسال بريد ولا اتصال مباشر.</p>
        <label className="field">
          <span>قالب</span>
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            <option value="">ترحيب افتراضي</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>نص بديل</span>
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="مرحبا {name} بخصوص {deal}" />
        </label>
        <button
          className="btn primary"
          type="button"
          disabled={busy}
          onClick={() =>
            void act(
              () => sendDealWhatsapp(params.id, { templateId: templateId || undefined, message: message || undefined }),
              'أُرسلت الرسالة وظهرت في الأنشطة.',
            )
          }
        >
          إرسال واتساب
        </button>
      </div>
      <div className="card">
        <h3>نشاط</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="field">
            <span>النوع</span>
            <select value={type} onChange={(event) => setType(event.target.value)}>
              {types.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>الوصف</span>
            <input value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
        </div>
        <button
          className="btn"
          type="button"
          disabled={busy || !note.trim()}
          onClick={() => void act(() => addActivity(params.id, type, note), 'سُجّل النشاط.')}
        >
          حفظ النشاط
        </button>
      </div>
      <div className="card">
        <h3>إغلاق</h3>
        <label className="field">
          <span>سبب الخسارة</span>
          <input value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="flex gap-2">
          <button className="btn" type="button" disabled={busy || deal?.status !== 'open'} onClick={() => void act(() => closeDeal(params.id, 'won'), 'رُبحت الصفقة.')}>
            ربح
          </button>
          <button className="btn" type="button" disabled={busy || deal?.status !== 'open'} onClick={() => void act(() => closeDeal(params.id, 'lost', reason), 'أُغلقت بخسارة.')}>
            خسارة
          </button>
        </div>
      </div>
      <div className="card">
        <h3>الأنشطة</h3>
        {(deal?.activities ?? []).map((activity: CrmActivity) => (
          <article key={activity.id} className="border-t py-2">
            <strong>{activity.type}</strong>
            {activity.direction ? <span className="muted"> · {activity.direction === 'out' ? 'صادر' : 'وارد'}</span> : null}
            <p>{activity.description}</p>
          </article>
        ))}
      </div>
    </Screen>
  );
}
