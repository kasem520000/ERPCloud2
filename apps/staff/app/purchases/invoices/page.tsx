'use client';

import Link from 'next/link';
import { useState } from 'react';

import { DataTable, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { apiList } from '../../../lib/api';
import { listParties, money, partyLabel, shortDate, statusLabel, type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Invoice = {
  id: string;
  number: string | null;
  kind: string;
  status: string;
  partyId: string;
  supplierReferenceNo: string | null;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  paidTotal: string;
  createdAt: string;
};

const KIND_LABELS: Record<string, string> = { purchase: 'مشتريات', purchase_return: 'مردود مشتريات' };

export default function PurchaseInvoicesPage() {
  const { can } = useSession();
  const [kind, setKind] = useState('');
  const invoices = useQuery<Invoice[]>(() => apiList<Invoice>('/purchase-invoices'), []);
  const suppliers = useQuery<Party[]>(() => listParties('supplier'), []);
  const rows = (invoices.data ?? []).filter((row) => !kind || row.kind === kind);

  return (
    <Screen
      title="فواتير المشتريات"
      subtitle="فواتير الموردين بما فيها التكاليف الإضافية التي تُحمَّل على تكلفة الأصناف عند الترحيل."
      crumbs={['المشتريات', 'العمليات']}
      actions={
        <>
          {can('purchase.ocr.use') && <Link className="btn" href="/purchases/invoices/ocr">قراءة فاتورة بالـ OCR</Link>}
          {can('purchase.invoice.create') && (
            <Link className="btn primary" href="/purchases/invoices/new">
              فاتورة مشتريات جديدة
            </Link>
          )}
        </>
      }
    >
      <div className="card toolbar">
        <label className="field">
          <span>النوع</span>
          <select className="input" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">الكل</option>
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <QueryView query={invoices} isEmpty={() => rows.length === 0} empty="لا توجد فواتير مشتريات" emptyDetail="سجّل أول فاتورة مورد.">
        {() => (
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => <Link href={`/purchases/invoices/${row.id}`}>{row.number ?? 'مسودة'}</Link> },
              { key: 'kind', header: 'النوع', cell: (row) => KIND_LABELS[row.kind] ?? row.kind },
              {
                key: 'supplier',
                header: 'المورد',
                cell: (row) => {
                  const party = (suppliers.data ?? []).find((entry) => entry.id === row.partyId);
                  return party ? partyLabel(party) : '—';
                },
              },
              { key: 'ref', header: 'مرجع المورد', align: 'ltr', cell: (row) => row.supplierReferenceNo ?? '—' },
              { key: 'date', header: 'التاريخ', align: 'ltr', cell: (row) => shortDate(row.createdAt) },
              { key: 'net', header: 'قبل الضريبة', align: 'num', cell: (row) => money(row.subtotal) },
              { key: 'tax', header: 'الضريبة', align: 'num', cell: (row) => money(row.taxTotal) },
              { key: 'total', header: 'الإجمالي', align: 'num', cell: (row) => money(row.total) },
              { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{statusLabel(row.status)}</span> },
              {
                key: 'print',
                header: '',
                cell: (row) => (
                  <Link className="btn sm" href={`/print/purchase-invoice/${row.id}`}>
                    طباعة
                  </Link>
                ),
              },
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
