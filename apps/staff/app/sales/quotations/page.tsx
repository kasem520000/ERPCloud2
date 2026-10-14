'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { InvoiceLines, TotalsPanel, computeTotals, emptyLine, filledLines, toApiLines, type LineDraft } from '../../../components/invoice-editor';
import { Screen } from '../../../components/screen';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import {
  arabicName,
  branchOptions,
  defaultOf,
  listBranches,
  listItems,
  listParties,
  listTaxGroups,
  listWarehouses,
  money,
  partyLabel,
  shortDate,
  today,
  type Branch,
  type Item,
  type Party,
  type TaxGroup,
  type Warehouse,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Quotation = {
  id: string;
  number: string | null;
  status: string;
  partyId: string | null;
  cashCustomerName: string | null;
  total: string;
  validUntil: string | null;
  convertedInvoiceId: string | null;
  createdAt: string;
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'مفتوح',
  converted: 'حُوِّل إلى فاتورة',
  voided: 'ملغى',
  signed: 'موقّع',
};

/**
 * Quotations (عرض سعر).
 *
 * A quote is priced exactly like an invoice but touches nothing: no stock, no ledger.
 * Converting it produces a **draft** sales invoice with the same lines, which is then
 * posted through the normal invoice screen — so the accounting entry happens once.
 */
export default function QuotationsPage() {
  const router = useRouter();
  const { can } = useSession();
  const quotations = useQuery<Quotation[]>(() => apiList<Quotation>('/sales/quotations'), []);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const parties = useQuery<Party[]>(() => listParties('customer'), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const taxGroups = useQuery<TaxGroup[]>(() => listTaxGroups(), []);

  const [open, setOpen] = useState(false);
  const [branchId, setBranchId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [partyId, setPartyId] = useState('');
  const [cashName, setCashName] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [includesVat, setIncludesVat] = useState(false);
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const branchRows = branches.data ?? [];
  const warehouseRows = warehouses.data ?? [];
  const effectiveBranch = branchId || defaultOf(branchRows)?.id || '';
  const effectiveWarehouse = warehouseId || defaultOf(warehouseRows.filter((row) => !effectiveBranch || row.branchId === effectiveBranch))?.id || '';
  const totals = computeTotals(lines, { priceIncludesVat: includesVat });

  const customerOf = (row: Quotation) => {
    if (row.cashCustomerName) return `${row.cashCustomerName} (نقدي)`;
    const party = (parties.data ?? []).find((entry) => entry.id === row.partyId);
    return party ? partyLabel(party) : '—';
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      if (filledLines(lines).length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'أضف سطراً واحداً على الأقل.');
      if (!partyId && !cashName.trim()) throw new ApiError(422, 'VALIDATION_FAILED', 'اختر عميلاً أو اكتب اسم العميل.');
      const quotation = await apiPost<Quotation>('/sales/quotations', {
        branchId: effectiveBranch,
        warehouseId: effectiveWarehouse || undefined,
        partyId: partyId || undefined,
        cashCustomerName: partyId ? undefined : cashName.trim(),
        validUntil: validUntil || undefined,
        priceIncludesVat: includesVat,
        lines: toApiLines(lines),
      });
      setNotice({ kind: 'ok', text: `تم إصدار عرض السعر ${quotation.number ?? ''}.` });
      setLines([emptyLine()]);
      setCashName('');
      setOpen(false);
      quotations.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function convert(row: Quotation) {
    setBusy(true);
    setNotice(undefined);
    try {
      const invoice = await apiPost<{ id: string }>(`/sales/quotations/${row.id}/convert`, {});
      router.push(`/sales/invoices/${invoice.id}`);
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
      setBusy(false);
    }
  }

  return (
    <Screen
      title="عرض سعر"
      subtitle="عرض مسعّر للعميل بلا أي أثر مخزني أو محاسبي. عند القبول يتحوّل إلى فاتورة مبيعات مسودة بنفس الأسطر."
      crumbs={['المبيعات', 'العمليات']}
      actions={
        can('sales.invoice.create') ? (
          <button type="button" className="btn primary" onClick={() => setOpen((value) => !value)}>
            {open ? 'إغلاق النموذج' : 'عرض سعر جديد'}
          </button>
        ) : null
      }
    >
      {open ? (
        <form className="card" onSubmit={save}>
          <div className="form-grid">
            <label className="field">
              <span>الفرع *</span>
              <select className="input" value={effectiveBranch} onChange={(event) => setBranchId(event.target.value)} required>
                {branchOptions(branchRows).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>المستودع</span>
              <select className="input" value={effectiveWarehouse} onChange={(event) => setWarehouseId(event.target.value)}>
                <option value="">— بدون —</option>
                {warehouseRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {arabicName(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>العميل</span>
              <select className="input" value={partyId} onChange={(event) => setPartyId(event.target.value)}>
                <option value="">— عميل نقدي —</option>
                {(parties.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {partyLabel(row)}
                  </option>
                ))}
              </select>
            </label>
            {!partyId && (
              <label className="field">
                <span>اسم العميل *</span>
                <input className="input" value={cashName} onChange={(event) => setCashName(event.target.value)} required />
              </label>
            )}
            <label className="field">
              <span>صالح حتى</span>
              <input className="input" type="date" value={validUntil} min={today()} onChange={(event) => setValidUntil(event.target.value)} />
            </label>
            <label className="field">
              <span>الأسعار شاملة الضريبة</span>
              <span className="row">
                <input type="checkbox" checked={includesVat} onChange={(event) => setIncludesVat(event.target.checked)} />
                <span className="muted small">تُستخرج الضريبة من السعر بدل إضافتها إليه.</span>
              </span>
            </label>
          </div>

          <h2>الأصناف</h2>
          <InvoiceLines lines={lines} onChange={setLines} items={items.data ?? []} taxGroups={taxGroups.data ?? []} priceField="salePrice" />

          <h2>الإجماليات</h2>
          <TotalsPanel totals={totals} />

          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : 'إصدار عرض السعر'}
          </button>
        </form>
      ) : null}

      <Notice notice={notice} />

      <QueryView query={quotations} empty="لا توجد عروض أسعار" emptyDetail="أصدر عرضاً مسعّراً للعميل، وحوّله إلى فاتورة عند الموافقة.">
        {(rows) => (
          <div className="card">
            <DataTable
              columns={[
                { key: 'number', header: 'رقم العرض', align: 'ltr', cell: (row: Quotation) => row.number ?? '—' },
                { key: 'party', header: 'العميل', cell: (row: Quotation) => customerOf(row) },
                { key: 'total', header: 'الإجمالي', align: 'num', cell: (row: Quotation) => money(row.total) },
                { key: 'validUntil', header: 'صالح حتى', cell: (row: Quotation) => (row.validUntil ? shortDate(row.validUntil) : 'غير محدّد') },
                { key: 'created', header: 'التاريخ', cell: (row: Quotation) => shortDate(row.createdAt) },
                { key: 'status', header: 'الحالة', cell: (row: Quotation) => STATUS_LABELS[row.status] ?? row.status },
                {
                  key: 'actions',
                  header: '',
                  cell: (row: Quotation) => (
                    <span className="row">
                      <button type="button" className="btn sm" onClick={() => router.push(`/sales/quotations/${row.id}`)}>
                        فتح
                      </button>
                      {row.status === 'draft' && can('esign.manage') ? (
                        <button type="button" className="btn sm" disabled={busy} onClick={() => router.push(`/sales/quotations/${row.id}/esign`)}>
                          إرسال للتوقيع
                        </button>
                      ) : null}
                      {row.status === 'converted' && row.convertedInvoiceId ? (
                        <button type="button" className="btn sm" onClick={() => router.push(`/sales/invoices/${row.convertedInvoiceId}`)}>
                          الفاتورة
                        </button>
                      ) : row.status === 'draft' && can('sales.invoice.create') ? (
                        <button type="button" className="btn sm primary" disabled={busy} onClick={() => convert(row)}>
                          تحويل إلى فاتورة
                        </button>
                      ) : row.status !== 'draft' ? (
                        <span className="muted">—</span>
                      ) : null}
                    </span>
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
