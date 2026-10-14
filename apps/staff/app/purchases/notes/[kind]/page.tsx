'use client';

import { use, useMemo, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../../components/data-view';
import { FormFields, type FormValues } from '../../../../components/directory';
import { Screen } from '../../../../components/screen';
import { ApiError, apiList, apiPost } from '../../../../lib/api';
import { listParties, money, partyLabel, shortDate, statusLabel, type Party } from '../../../../lib/lookups';
import { useQuery } from '../../../../lib/use-query';

type Invoice = { id: string; number: string | null; branchId: string; status: string; total: string; partyId: string; postedAt: string | null };
type Note = { id: string; number: string | null; kind: string; status: string; reason: string; amount: string; invoiceNumber: string | null; partyId: string | null; createdAt: string; postedAt: string | null };

const KIND_TITLES: Record<string, { title: string; hint: string }> = {
  credit: {
    title: 'إشعار دائن (مشتريات)',
    hint: 'يُنقص قيمة فاتورة مورد مرحّلة — خصم لاحق من المورد أو تسوية سعر لصالحنا.',
  },
  debit: {
    title: 'إشعار مدين (مشتريات)',
    hint: 'يزيد قيمة فاتورة مورد مرحّلة — فرق سعر أو رسوم إضافية يطالب بها المورد.',
  },
};

/**
 * Supplier adjustment notes.
 *
 * Same rule as the sales side: a note attaches to a **posted** invoice, and posting the
 * note allocates its number from the document sequence (`PCN-…` / `PDN-…`).
 */
export default function PurchaseNotePage({ params }: { params: Promise<{ kind: string }> }) {
  const kind = use(params).kind === 'debit' ? 'debit' : 'credit';
  const meta = KIND_TITLES[kind]!;
  const invoices = useQuery<Invoice[]>(() => apiList<Invoice>('/purchase-invoices'), []);
  const notes = useQuery<Note[]>(() => apiList<Note>(`/purchases/adjustment-notes?kind=${kind}`), [kind]);
  const suppliers = useQuery<Party[]>(() => listParties('supplier'), []);
  const [values, setValues] = useState<FormValues>({ invoiceId: '', reason: '', amountText: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const posted = useMemo(() => (invoices.data ?? []).filter((invoice) => invoice.status === 'posted'), [invoices.data]);
  const selected = posted.find((invoice) => invoice.id === values.invoiceId);
  const supplierName = (partyId: string | null) => {
    const party = (suppliers.data ?? []).find((candidate) => candidate.id === partyId);
    return party ? partyLabel(party) : '—';
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await apiPost(`/purchase-invoices/${selected.id}/adjustment-notes`, {
        branchId: selected.branchId,
        kind,
        reason: String(values.reason),
        amount: String(values.amountText),
      });
      setNotice({ kind: 'ok', text: 'تم إنشاء الإشعار كمسودة. رحّله ليأخذ رقمه المتسلسل.' });
      setValues({ invoiceId: '', reason: '', amountText: '' });
      notes.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function postNote(note: Note) {
    setBusy(true);
    try {
      await apiPost(`/purchases/adjustment-notes/${note.id}/post`, {});
      setNotice({ kind: 'ok', text: 'تم ترحيل الإشعار.' });
      notes.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={meta.title} subtitle={meta.hint} crumbs={['المشتريات', 'الإشعارات']}>
      <form className="card" onSubmit={submit}>
        <h3>إشعار جديد</h3>
        <FormFields
          fields={[
            {
              name: 'invoiceId',
              label: 'فاتورة المورد المرحّلة',
              type: 'select',
              required: true,
              wide: true,
              options: posted.map((invoice) => ({
                id: invoice.id,
                label: `${invoice.number ?? invoice.id.slice(0, 8)} — ${supplierName(invoice.partyId)} — ${money(invoice.total)} — ${shortDate(invoice.postedAt)}`,
              })),
              hint: posted.length === 0 ? 'لا توجد فواتير مشتريات مرحّلة بعد؛ الإشعار لا يصدر على مسودة.' : undefined,
            },
            { name: 'amountText', label: 'المبلغ', type: 'number', required: true },
            { name: 'reason', label: 'السبب', required: true, wide: true, placeholder: 'خصم متفق عليه بعد الاستلام' },
          ]}
          values={values}
          onChange={setValues}
        />
        <Notice notice={notice} />
        <button className="btn primary" type="submit" disabled={busy || !selected || !values.reason || !values.amountText}>
          {busy ? 'جارٍ الحفظ…' : 'إنشاء الإشعار'}
        </button>
      </form>

      <QueryView query={notes} empty="لا توجد إشعارات من هذا النوع">
        {(rows) => (
          <div className="card">
            <DataTable
              columns={[
                { key: 'number', header: 'رقم الإشعار', align: 'ltr', cell: (row: Note) => row.number ?? 'مسودة' },
                { key: 'invoice', header: 'الفاتورة', align: 'ltr', cell: (row: Note) => row.invoiceNumber ?? '—' },
                { key: 'party', header: 'المورد', cell: (row: Note) => supplierName(row.partyId) },
                { key: 'reason', header: 'السبب', cell: (row: Note) => row.reason },
                { key: 'amount', header: 'المبلغ', align: 'num', cell: (row: Note) => money(row.amount) },
                { key: 'status', header: 'الحالة', cell: (row: Note) => statusLabel(row.status) },
                { key: 'created', header: 'التاريخ', cell: (row: Note) => shortDate(row.createdAt) },
                {
                  key: 'actions',
                  header: '',
                  cell: (row: Note) =>
                    row.status === 'draft' ? (
                      <button type="button" className="btn sm primary" disabled={busy} onClick={() => postNote(row)}>
                        ترحيل
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    ),
                },
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
