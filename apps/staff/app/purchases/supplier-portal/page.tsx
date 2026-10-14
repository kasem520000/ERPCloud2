'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import { listParties, money, partyLabel, shortDate, type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type PortalUser = { id: string; partyId: string; email: string; isActive: boolean; createdAt: string };
type Rfq = { id: string; number: string; partyId: string; title: string; status: string; offer: string | null; responseNote: string | null; createdAt: string };
type Upload = { id: string; partyId: string; referenceNo: string; declaredTotal: string; note: string; status: string; createdAt: string };

const RFQ_STATUS: Record<string, string> = { open: 'مفتوح', responded: 'تم الرد', closed: 'مغلق' };

export default function SupplierPortalAdminPage() {
  const { can } = useSession();
  const manage = can('supplier_portal.access');
  const users = useQuery<PortalUser[]>(() => apiList<PortalUser>('/supplier-portal/users'), []);
  const rfqs = useQuery<Rfq[]>(() => apiList<Rfq>('/supplier-portal/rfqs'), []);
  const uploads = useQuery<Upload[]>(() => apiList<Upload>('/supplier-portal/uploads'), []);
  const suppliers = useQuery<Party[]>(() => listParties('supplier'), []);
  const [partyId, setPartyId] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();
  const [issued, setIssued] = useState<string | undefined>();

  const partyOf = (id: string) => {
    const party = (suppliers.data ?? []).find((row) => row.id === id);
    return party ? partyLabel(party) : id.slice(0, 8);
  };

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    setIssued(undefined);
    try {
      const created = await apiPost<{ email: string; temporaryPassword: string | null }>('/supplier-portal/users', {
        partyId,
        email: email.trim(),
      });
      setEmail('');
      users.reload();
      if (created.temporaryPassword) setIssued(`${created.email} — ${created.temporaryPassword}`);
      else setNotice({ kind: 'ok', text: 'تم تحديث الدعوة.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function createRfq(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const created = await apiPost<{ number: string }>('/supplier-portal/rfqs', { partyId, title: title.trim(), note });
      setTitle('');
      setNote('');
      rfqs.reload();
      setNotice({ kind: 'ok', text: `أُرسل الطلب ${created.number}.` });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="بوابة الموردين"
      subtitle="دعوة مورد، وإرسال طلب عرض سعر، وقراءة الفواتير التي يرفعها. الرفع لا يُنشئ قيد مشتريات. المورد يدخل من /supplier-portal."
      crumbs={['المشتريات', 'العمليات']}
    >
      <Notice notice={notice} />
      {issued ? (
        <div className="card">
          <strong>كلمة المرور تُعرض مرة واحدة</strong>
          <p>{issued}</p>
          <p className="muted small">انسخها الآن. البريد في وضع التطوير لا يطبع نص الرسالة.</p>
        </div>
      ) : null}

      {manage ? (
        <form className="card" onSubmit={invite}>
          <h2>دعوة مورد</h2>
          <div className="form-grid">
            <label className="field">
              <span>المورد *</span>
              <select className="input" value={partyId} onChange={(event) => setPartyId(event.target.value)} required>
                <option value="">— اختر —</option>
                {(suppliers.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {partyLabel(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>البريد *</span>
              <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </label>
          </div>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : 'إنشاء الدخول'}
          </button>
        </form>
      ) : null}

      <QueryView query={users} empty="لا توجد دعوات">
        {(rows) => (
          <div className="card">
            <DataTable
              columns={[
                { key: 'party', header: 'المورد', cell: (row: PortalUser) => partyOf(row.partyId) },
                { key: 'email', header: 'البريد', cell: (row: PortalUser) => row.email },
                { key: 'active', header: 'الحالة', cell: (row: PortalUser) => (row.isActive ? 'نشط' : 'موقوف') },
                { key: 'created', header: 'التاريخ', cell: (row: PortalUser) => shortDate(row.createdAt) },
              ]}
              rows={rows}
              rowKey={(row) => row.id}
            />
          </div>
        )}
      </QueryView>

      {manage ? (
        <form className="card" onSubmit={createRfq}>
          <h2>طلب عرض سعر</h2>
          <div className="form-grid">
            <label className="field">
              <span>العنوان *</span>
              <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} />
            </label>
            <label className="field">
              <span>ملاحظة</span>
              <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
          </div>
          <button className="btn" type="submit" disabled={busy || !partyId}>
            إرسال الطلب للمورد المختار
          </button>
        </form>
      ) : null}

      <QueryView query={rfqs} empty="لا توجد طلبات">
        {(rows) => (
          <div className="card">
            <DataTable
              columns={[
                { key: 'number', header: 'الرقم', cell: (row: Rfq) => row.number },
                { key: 'party', header: 'المورد', cell: (row: Rfq) => partyOf(row.partyId) },
                { key: 'title', header: 'العنوان', cell: (row: Rfq) => row.title },
                { key: 'status', header: 'الحالة', cell: (row: Rfq) => RFQ_STATUS[row.status] ?? row.status },
                { key: 'offer', header: 'العرض', align: 'num', cell: (row: Rfq) => (row.offer ? money(row.offer) : '—') },
                { key: 'response', header: 'الملاحظة', cell: (row: Rfq) => row.responseNote ?? '—' },
              ]}
              rows={rows}
              rowKey={(row) => row.id}
            />
          </div>
        )}
      </QueryView>

      <h2>فواتير رفعها الموردون</h2>
      <QueryView query={uploads} empty="لا توجد فواتير مرفوعة">
        {(rows) => (
          <div className="card">
            <DataTable
              columns={[
                { key: 'party', header: 'المورد', cell: (row: Upload) => partyOf(row.partyId) },
                { key: 'ref', header: 'الرقم', cell: (row: Upload) => row.referenceNo },
                { key: 'declared', header: 'الإجمالي', align: 'num', cell: (row: Upload) => money(row.declaredTotal) },
                { key: 'status', header: 'الحالة', cell: (row: Upload) => (row.status === 'submitted' ? 'بانتظار القيد' : row.status) },
                { key: 'created', header: 'التاريخ', cell: (row: Upload) => shortDate(row.createdAt) },
              ]}
              rows={rows}
              rowKey={(row) => row.id}
            />
          </div>
        )}
      </QueryView>
    </Screen>
  );
}
