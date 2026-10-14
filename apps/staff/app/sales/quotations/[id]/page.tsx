'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { DataTable, QueryView } from '../../../../components/data-view';
import { Screen } from '../../../../components/screen';
import { apiData, apiList } from '../../../../lib/api';
import { listParties, money, partyLabel, shortDate, type Party } from '../../../../lib/lookups';
import { useSession } from '../../../../lib/session';
import { useQuery } from '../../../../lib/use-query';

type Line = {
  id: string;
  lineNo: number;
  description: string | null;
  quantity: string;
  unitPrice: string;
  total: string;
};

type Quotation = {
  id: string;
  number: string | null;
  kind: string;
  status: string;
  partyId: string | null;
  cashCustomerName: string | null;
  currency: string;
  total: string;
  validUntil: string | null;
  lines: Line[];
};

type SignatureRequest = {
  id: string;
  signerEmail: string;
  signerName: string;
  status: string;
  signedAt: string | null;
  expiresAt: string;
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'مفتوح',
  converted: 'حُوِّل إلى فاتورة',
  voided: 'ملغى',
  signed: 'موقّع',
};

const SIGN_LABELS: Record<string, string> = {
  sent: 'أُرسل',
  viewed: 'شُوهد',
  signed: 'موقّع',
  declined: 'مرفوض',
};

export default function QuotationDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { can } = useSession();
  const canSign = can('esign.manage');
  const quotation = useQuery<Quotation>(() => apiData<Quotation>(`/sales/invoices/${id}`), [id]);
  const requests = useQuery<SignatureRequest[]>(
    () => (canSign ? apiList<SignatureRequest>(`/esign/requests?entityId=${id}`) : Promise.resolve([])),
    [id, canSign],
  );
  const parties = useQuery<Party[]>(() => listParties('customer'), []);

  const row = quotation.data;
  const customer = row?.cashCustomerName
    ? `${row.cashCustomerName} (نقدي)`
    : partyLabel((parties.data ?? []).find((party) => party.id === row?.partyId) ?? { id: '', name: '—' });

  return (
    <Screen
      title={row?.number ? `عرض سعر ${row.number}` : 'عرض سعر'}
      subtitle="عرض مسعّر بلا أثر مخزني. التوقيع هنا رسم ورمز لمرة واحدة، وليس توقيعاً مؤهلاً."
      crumbs={['المبيعات', 'عرض سعر']}
      actions={
        row?.kind === 'quotation' && row.status === 'draft' && can('esign.manage') ? (
          <Link className="btn primary" href={`/sales/quotations/${id}/esign`}>
            إرسال للتوقيع
          </Link>
        ) : (
          <Link className="btn" href="/sales/quotations">
            العودة للقائمة
          </Link>
        )
      }
    >
      <QueryView query={quotation} empty="عرض السعر غير موجود">
        {(document) =>
          document.kind !== 'quotation' ? (
            <div className="card">
              <p>هذا المستند ليس عرض سعر.</p>
              <Link href="/sales/quotations">العودة</Link>
            </div>
          ) : (
            <>
              <section className="card">
                <p>العميل: {customer}</p>
                <p>الحالة: {STATUS_LABELS[document.status] ?? document.status}</p>
                <p>صالح حتى: {document.validUntil ? shortDate(document.validUntil) : 'غير محدّد'}</p>
                <p>
                  <strong>الإجمالي {money(document.total, document.currency)}</strong>
                </p>
              </section>
              <div className="card">
                <DataTable
                  columns={[
                    { key: 'line', header: '#', cell: (line: Line) => line.lineNo },
                    { key: 'description', header: 'البيان', cell: (line: Line) => line.description || '—' },
                    { key: 'quantity', header: 'الكمية', align: 'num', cell: (line: Line) => line.quantity },
                    { key: 'unit', header: 'سعر الوحدة', align: 'num', cell: (line: Line) => money(line.unitPrice, document.currency) },
                    { key: 'lineTotal', header: 'الإجمالي', align: 'num', cell: (line: Line) => money(line.total, document.currency) },
                  ]}
                  rows={document.lines}
                  rowKey={(line) => line.id}
                />
              </div>
            </>
          )
        }
      </QueryView>

      {canSign ? <h2>التوقيع الإلكتروني</h2> : null}
      {canSign ? <QueryView query={requests} empty="لم يُرسل هذا العرض للتوقيع بعد">
        {(rows) => (
          <div className="card">
            <DataTable
              columns={[
                { key: 'email', header: 'الموقّع', cell: (entry: SignatureRequest) => entry.signerName || entry.signerEmail },
                { key: 'mail', header: 'البريد', cell: (entry: SignatureRequest) => entry.signerEmail },
                { key: 'status', header: 'الحالة', cell: (entry: SignatureRequest) => SIGN_LABELS[entry.status] ?? entry.status },
                { key: 'signed', header: 'وُقّع في', cell: (entry: SignatureRequest) => (entry.signedAt ? shortDate(entry.signedAt) : '—') },
                { key: 'expires', header: 'ينتهي', cell: (entry: SignatureRequest) => shortDate(entry.expiresAt) },
              ]}
              rows={rows}
              rowKey={(entry) => entry.id}
            />
          </div>
        )}
      </QueryView> : null}
    </Screen>
  );
}
