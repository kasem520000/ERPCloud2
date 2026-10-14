'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
import { itemLabel, listItems, money, quantity, shortDate, type Item } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type InvoiceLine = { id: string; lineNo: number; itemId: string | null; description: string | null; quantity: string; unitPrice: string; taxRate: string; discountRate: string };
type Invoice = {
  id: string;
  number: string | null;
  kind: string;
  status: string;
  branchId: string;
  warehouseId: string | null;
  partyId: string | null;
  cashCustomerName: string | null;
  total: string;
  createdAt: string;
  lines: InvoiceLine[];
};

/**
 * A sales return is always *against* a posted invoice: the service refuses quantities the
 * original never sold. So the screen starts from the invoice and only lets the user say
 * "how much of this line comes back".
 */
export default function SalesReturnsPage() {
  const router = useRouter();
  const { can } = useSession();
  const invoices = useQuery<Invoice[]>(() => apiList<Invoice>('/sales/invoices'), []);
  const items = useQuery<Item[]>(() => listItems(), []);

  const [invoiceId, setInvoiceId] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const source = useQuery<Invoice | null>(() => (invoiceId ? apiData<Invoice>(`/sales/invoices/${invoiceId}`) : Promise.resolve(null)), [invoiceId]);
  const postedSales = (invoices.data ?? []).filter((row) => row.status === 'posted' && row.kind === 'sale');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const doc = source.data;
      if (!doc) throw new ApiError(422, 'VALIDATION_FAILED', 'اختر الفاتورة الأصلية.');
      const lines = doc.lines
        .filter((line) => line.itemId && Number(quantities[line.id] ?? 0) > 0)
        .map((line) => ({
          itemId: line.itemId as string,
          quantity: String(quantities[line.id]),
          unitPrice: line.unitPrice,
          taxRate: line.taxRate,
          discountRate: line.discountRate,
        }));
      if (lines.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'حدّد كمية مرتجعة لسطر واحد على الأقل.');

      const created = await apiPost<{ id: string }>(`/sales/invoices/${doc.id}/return`, {
        branchId: doc.branchId,
        warehouseId: doc.warehouseId ?? undefined,
        partyId: doc.partyId ?? undefined,
        cashCustomerName: doc.partyId ? undefined : (doc.cashCustomerName ?? undefined),
        lines,
      });
      router.push(`/sales/invoices/${created.id}`);
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
      setBusy(false);
    }
  }

  if (!can('sales.return.create')) {
    return (
      <Screen title="مردود المبيعات" crumbs={['المبيعات', 'العمليات']}>
        <div className="card state">
          <strong>لا تملك صلاحية إنشاء مردودات المبيعات</strong>
        </div>
      </Screen>
    );
  }

  return (
    <Screen title="مردود المبيعات" subtitle="إرجاع أصناف من فاتورة مرحّلة؛ يُنشأ مستند مردود كمسودة تُرحّل بعد المراجعة." crumbs={['المبيعات', 'العمليات']}>
      <form className="card" onSubmit={submit}>
        <label className="field">
          <span>الفاتورة الأصلية *</span>
          <select
            className="input"
            value={invoiceId}
            onChange={(event) => {
              setInvoiceId(event.target.value);
              setQuantities({});
            }}
            required
          >
            <option value="">— اختر —</option>
            {postedSales.map((row) => (
              <option key={row.id} value={row.id}>
                {`${row.number ?? row.id.slice(0, 8)} — ${shortDate(row.createdAt)} — ${money(row.total)}`}
              </option>
            ))}
          </select>
        </label>

        {source.data && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المادة</th>
                  <th>الكمية المباعة</th>
                  <th>السعر</th>
                  <th>الكمية المرتجعة</th>
                </tr>
              </thead>
              <tbody>
                {source.data.lines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      {(() => {
                        const item = (items.data ?? []).find((entry) => entry.id === line.itemId);
                        return item ? itemLabel(item) : (line.description ?? '—');
                      })()}
                    </td>
                    <td className="num">{quantity(line.quantity)}</td>
                    <td className="num">{money(line.unitPrice)}</td>
                    <td>
                      <input
                        className="input"
                        dir="ltr"
                        inputMode="decimal"
                        disabled={!line.itemId}
                        value={quantities[line.id] ?? ''}
                        onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Notice notice={notice} />
        <button className="btn primary" type="submit" disabled={busy || !invoiceId}>
          {busy ? 'جارٍ الإنشاء…' : 'إنشاء المردود'}
        </button>
      </form>
    </Screen>
  );
}
