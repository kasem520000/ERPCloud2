'use client';

import { use, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { DataTable, Notice, QueryView } from '../../../../components/data-view';
import { FormFields, type FormValues } from '../../../../components/directory';
import { Screen } from '../../../../components/screen';
import { ApiError, apiList, apiPost } from '../../../../lib/api';
import { money, shortDate, statusLabel } from '../../../../lib/lookups';
import { useQuery } from '../../../../lib/use-query';

type Invoice = { id: string; number: string | null; branchId: string; status: string; total: string; partyId: string | null; cashCustomerName: string | null; postedAt: string | null };
type Note = { id: string; number: string | null; kind: string; status: string; reason: string; amount: string; invoiceNumber: string | null; createdAt: string; postedAt: string | null };

const KIND_TITLES: Record<string, { title: string; hint: string }> = {
  credit: {
    title: 'إشعار دائن (مبيعات)',
    hint: 'يُنقص قيمة فاتورة مرحّلة — خصم لاحق، أو تسوية سعر لصالح العميل.',
  },
  debit: {
    title: 'إشعار مدين (مبيعات)',
    hint: 'يزيد قيمة فاتورة مرحّلة — فرق سعر أو رسوم إضافية على العميل.',
  },
};

/**
 * Adjustment notes are issued **against a posted invoice**, never standalone: the API
 * refuses a note on a draft, which is what keeps the audit trail honest.
 */
export default function SalesNotePage({ params }: { params: Promise<{ kind: string }> }) {
  const kind = use(params).kind === 'debit' ? 'debit' : 'credit';
  const searchParams = useSearchParams();
  const highlightedId = searchParams.get('id');
  const meta = KIND_TITLES[kind]!;
  const invoices = useQuery<Invoice[]>(() => apiList<Invoice>('/sales/invoices'), []);
  const notes = useQuery<Note[]>(() => apiList<Note>(`/sales/adjustment-notes?kind=${kind}`), [kind]);
  const [values, setValues] = useState<FormValues>({ invoiceId: '', reason: '', amountText: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const posted = useMemo(() => (invoices.data ?? []).filter((invoice) => invoice.status === 'posted'), [invoices.data]);
  const selected = posted.find((invoice) => invoice.id === values.invoiceId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await apiPost(`/sales/invoices/${selected.id}/adjustment-notes`, {
        branchId: selected.branchId,
        kind,
        reason: String(values.reason),
        amount: String(values.amountText),
      });
      setNotice({ kind: 'ok', text: 'تم إنشاء الإشعار كمسودة. رحّله ليصبح نافذاً.' });
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
      await apiPost(`/sales/adjustment-notes/${note.id}/post`, {});
      setNotice({ kind: 'ok', text: 'تم ترحيل الإشعار.' });
      notes.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={meta.title} subtitle={meta.hint} crumbs={['المبيعات', 'الإشعارات']}>
      {highlightedId && (
        <div className="card tight" style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn-line)' }}>
          🔍 تم فتح الإشعار <code dir="ltr">{highlightedId}</code> من تقرير عمولات المندوب — الصف المميز أدناه هو المطلوب.
        </div>
      )}
      <form className="card" onSubmit={submit}>
        <h3>إشعار جديد</h3>
        <FormFields
          fields={[
            {
              name: 'invoiceId',
              label: 'الفاتورة المرحّلة',
              type: 'select',
              required: true,
              wide: true,
              options: posted.map((invoice) => ({
                id: invoice.id,
                label: `${invoice.number ?? invoice.id.slice(0, 8)} — ${invoice.cashCustomerName ?? 'عميل'} — ${money(invoice.total)} — ${shortDate(invoice.postedAt)}`,
              })),
              hint: posted.length === 0 ? 'لا توجد فواتير مرحّلة بعد؛ الإشعار لا يصدر على مسودة.' : undefined,
            },
            { name: 'amountText', label: 'المبلغ', type: 'number', required: true },
            { name: 'reason', label: 'السبب', required: true, wide: true, placeholder: 'خصم متفق عليه بعد التسليم' },
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
              activeKey={highlightedId ?? undefined}
              columns={[
                { key: 'number', header: 'رقم الإشعار', align: 'ltr', cell: (row: Note) => row.number ?? 'مسودة' },
                { key: 'invoice', header: 'الفاتورة', align: 'ltr', cell: (row: Note) => row.invoiceNumber ?? '—' },
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
