'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import { listParties, money, partyLabel, percent, shortDate, statusLabel, today, type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type OfferLine = { lineNo: number; code: string; description: string; qty: string; unitValue: string; lineValue: string };
type Offer = {
  id: string;
  number: string;
  partyId: string;
  projectId: string | null;
  title: string;
  status: string;
  offerDate: string;
  validUntil: string | null;
  totalValue: string;
  retentionPct: string;
  rejectionReason: string | null;
  lines: OfferLine[];
};

type LineDraft = { code: string; description: string; qty: string; unitValue: string };

const STATUS_LABELS: Record<string, string> = { draft: 'مسودة', sent: 'مُرسل', accepted: 'مقبول', rejected: 'مرفوض', expired: 'منتهي', converted: 'محوّل لمشروع' };
const emptyLine = (): LineDraft => ({ code: '', description: '', qty: '1', unitValue: '' });
const lineValue = (line: LineDraft) => Number(line.qty || 0) * Number(line.unitValue || 0);

/** عروض المشاريع — an offer that is accepted becomes a project whose BOQ is these lines. */
export default function ProjectOffersPage() {
  const { can } = useSession();
  const customers = useQuery<Party[]>(() => listParties('customer'), []);
  const offers = useQuery<Offer[]>(() => apiList<Offer>('/contracting/offers'), []);

  const [partyId, setPartyId] = useState('');
  const [title, setTitle] = useState('');
  const [offerDate, setOfferDate] = useState(today());
  const [validUntil, setValidUntil] = useState('');
  const [retentionPct, setRetentionPct] = useState('5');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(), emptyLine(), emptyLine()]);
  const [expanded, setExpanded] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const filled = lines.filter((line) => line.description.trim() !== '' && line.unitValue.trim() !== '');
  const draftTotal = filled.reduce((sum, line) => sum + lineValue(line), 0);
  const customerName = (id: string) => {
    const party = (customers.data ?? []).find((row) => row.id === id);
    return party ? partyLabel(party) : id;
  };

  function setLine(index: number, patch: Partial<LineDraft>) {
    setLines((current) => current.map((line, position) => (position === index ? { ...line, ...patch } : line)));
  }

  async function create() {
    setBusy(true);
    setNotice(undefined);
    try {
      if (!partyId) throw new ApiError(422, 'VALIDATION_FAILED', 'اختر العميل.');
      if (filled.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'أضف بنداً واحداً على الأقل.');
      const created = await apiPost<Offer>('/contracting/offers', {
        partyId,
        title: title.trim(),
        offerDate,
        validUntil: validUntil || undefined,
        retentionPct,
        notes: notes.trim() || undefined,
        lines: filled.map((line) => ({ code: line.code.trim() || undefined, description: line.description.trim(), qty: line.qty || '1', unitValue: line.unitValue })),
      });
      setNotice({ kind: 'ok', text: `تم إنشاء العرض ${created.number} بقيمة ${money(created.totalValue)}.` });
      setTitle('');
      setNotes('');
      setLines([emptyLine(), emptyLine(), emptyLine()]);
      offers.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function act(offer: Offer, action: 'send' | 'accept' | 'reject' | 'convert') {
    setBusy(true);
    setNotice(undefined);
    try {
      if (action === 'reject') {
        const reason = window.prompt('سبب الرفض؟');
        if (!reason) throw new ApiError(422, 'VALIDATION_FAILED', 'الرفض يحتاج سبباً.');
        await apiPost<Offer>(`/contracting/offers/${offer.id}/reject`, { reason });
        setNotice({ kind: 'ok', text: `تم رفض العرض ${offer.number}.` });
      } else if (action === 'convert') {
        const project = await apiPost<{ code: string; name: string }>(`/contracting/offers/${offer.id}/convert`, {});
        setNotice({ kind: 'ok', text: `تم تحويل العرض ${offer.number} إلى المشروع ${project.code} — ${project.name}، ونُقلت بنوده إلى جدول الكميات.` });
      } else {
        await apiPost<Offer>(`/contracting/offers/${offer.id}/${action}`, {});
        setNotice({ kind: 'ok', text: action === 'send' ? `تم إرسال العرض ${offer.number}.` : `تم قبول العرض ${offer.number}؛ يمكن تحويله إلى مشروع.` });
      }
      offers.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const openOffer = (offers.data ?? []).find((row) => row.id === expanded) ?? null;

  return (
    <Screen
      title="عروض المشاريع"
      subtitle="عروض الأسعار للمشاريع: تُرسل، تُقبل أو تُرفض، والمقبول منها يتحول إلى مشروع ببنود جدول كميات مطابقة للعرض."
      crumbs={['إدارة المشاريع', 'العمليات']}
    >
      {notice && <Notice notice={notice} />}

      {can('projects.manage') && (
        <div className="card">
          <h3>عرض جديد</h3>
          <div className="form-grid">
            <label className="field">
              <span>العميل</span>
              <select className="input" value={partyId} onChange={(event) => setPartyId(event.target.value)}>
                <option value="">— اختر —</option>
                {(customers.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>{partyLabel(row)}</option>
                ))}
              </select>
            </label>
            <label className="field wide">
              <span>موضوع العرض</span>
              <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="عرض تنفيذ فيلا سكنية" />
            </label>
            <label className="field">
              <span>تاريخ العرض</span>
              <input className="input" type="date" value={offerDate} onChange={(event) => setOfferDate(event.target.value)} />
            </label>
            <label className="field">
              <span>صالح حتى</span>
              <input className="input" type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />
            </label>
            <label className="field">
              <span>نسبة الاحتجاز %</span>
              <input className="input" value={retentionPct} onChange={(event) => setRetentionPct(event.target.value)} inputMode="decimal" />
            </label>
            <label className="field wide">
              <span>ملاحظات</span>
              <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>
          </div>

          <h4>بنود العرض</h4>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الرمز</th>
                  <th>الوصف</th>
                  <th>الكمية</th>
                  <th>سعر الوحدة</th>
                  <th>القيمة</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index}>
                    <td>
                      <input className="input" value={line.code} onChange={(event) => setLine(index, { code: event.target.value })} placeholder="تلقائي" />
                    </td>
                    <td>
                      <input className="input" value={line.description} onChange={(event) => setLine(index, { description: event.target.value })} />
                    </td>
                    <td>
                      <input className="input" value={line.qty} onChange={(event) => setLine(index, { qty: event.target.value })} inputMode="decimal" />
                    </td>
                    <td>
                      <input className="input" value={line.unitValue} onChange={(event) => setLine(index, { unitValue: event.target.value })} inputMode="decimal" />
                    </td>
                    <td className="num">{money(lineValue(line))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="toolbar">
            <button className="btn sm" type="button" onClick={() => setLines((current) => [...current, emptyLine()])}>
              إضافة سطر
            </button>
            <span className="chip on">{`إجمالي العرض: ${money(draftTotal)}`}</span>
            <button className="btn primary" type="button" onClick={create} disabled={busy}>
              {busy ? 'جارٍ الحفظ…' : 'حفظ العرض'}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3>العروض</h3>
        <QueryView query={offers} empty="لا توجد عروض" emptyDetail="أنشئ عرضاً من النموذج أعلاه.">
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              columns={[
                { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => (
                  <button className="btn sm" type="button" onClick={() => setExpanded(row.id === expanded ? '' : row.id)}>{row.number}</button>
                ) },
                { key: 'party', header: 'العميل', cell: (row) => customerName(row.partyId) },
                { key: 'title', header: 'الموضوع', cell: (row) => row.title },
                { key: 'date', header: 'التاريخ', align: 'ltr', cell: (row) => shortDate(row.offerDate) },
                { key: 'valid', header: 'صالح حتى', align: 'ltr', cell: (row) => (row.validUntil ? shortDate(row.validUntil) : '—') },
                { key: 'total', header: 'القيمة', align: 'num', cell: (row) => money(row.totalValue) },
                { key: 'retention', header: 'الاحتجاز', align: 'num', cell: (row) => percent(Number(row.retentionPct) / 100) },
                { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{STATUS_LABELS[row.status] ?? statusLabel(row.status)}</span> },
                {
                  key: 'actions',
                  header: '',
                  cell: (row) =>
                    can('projects.manage') ? (
                      <div className="row">
                        {row.status === 'draft' && (
                          <button className="btn sm" type="button" disabled={busy} onClick={() => act(row, 'send')}>
                            إرسال
                          </button>
                        )}
                        {(row.status === 'draft' || row.status === 'sent') && (
                          <button className="btn sm primary" type="button" disabled={busy} onClick={() => act(row, 'accept')}>
                            قبول
                          </button>
                        )}
                        {(row.status === 'draft' || row.status === 'sent') && (
                          <button className="btn sm danger" type="button" disabled={busy} onClick={() => act(row, 'reject')}>
                            رفض
                          </button>
                        )}
                        {row.status === 'accepted' && (
                          <button className="btn sm primary" type="button" disabled={busy} onClick={() => act(row, 'convert')}>
                            تحويل لمشروع
                          </button>
                        )}
                      </div>
                    ) : null,
                },
              ]}
            />
          )}
        </QueryView>
      </div>

      {openOffer && (
        <div className="card">
          <h3>
            {openOffer.number} — {openOffer.title}
          </h3>
          <div className="chips">
            <span className="chip">{`الحالة: ${STATUS_LABELS[openOffer.status] ?? statusLabel(openOffer.status)}`}</span>
            <span className="chip">{`الإجمالي: ${money(openOffer.totalValue)}`}</span>
            {openOffer.projectId && <span className="chip on">حُوِّل إلى مشروع</span>}
            {openOffer.rejectionReason && <span className="chip">{`سبب الرفض: ${openOffer.rejectionReason}`}</span>}
          </div>
          <DataTable
            rows={openOffer.lines}
            rowKey={(row) => String(row.lineNo)}
            columns={[
              { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code },
              { key: 'description', header: 'الوصف', cell: (row) => row.description },
              { key: 'qty', header: 'الكمية', align: 'num', cell: (row) => row.qty },
              { key: 'unit', header: 'سعر الوحدة', align: 'num', cell: (row) => money(row.unitValue) },
              { key: 'value', header: 'القيمة', align: 'num', cell: (row) => money(row.lineValue) },
            ]}
          />
        </div>
      )}
    </Screen>
  );
}
