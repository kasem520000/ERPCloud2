'use client';

import { useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Directory } from '../../../components/directory';
import { apiList, apiPost } from '../../../lib/api';
import { itemLabel, listItems, money, quantity, shortDate, today, type Item } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type Offer = {
  id: string;
  code: string;
  name: string;
  validFrom: string;
  validTo: string;
  status: string;
  targetType: string;
  targetValue: string;
  discountType: string;
  discountValue: string;
};

type Evaluation = { eligible: boolean; discount: string; reason?: string };

const REASONS: Record<string, string> = { OFFER_NOT_VALID: 'العرض موقوف أو خارج فترة صلاحيته', TARGET_NOT_MET: 'الكمية/القيمة أقل من الحد الأدنى' };

const TARGETS: Record<string, string> = { quantity: 'كمية', value: 'قيمة' };
const DISCOUNTS: Record<string, string> = { percent: 'نسبة %', amount: 'مبلغ ثابت' };

/**
 * Sales offers.
 *
 * An offer is a rule ("buy 10 → 5% off"); the evaluator below answers the only question
 * that matters at the counter: does this rule apply to this line, and by how much.
 */
export default function OffersPage() {
  const offers = useQuery<Offer[]>(() => apiList<Offer>('/sales/offers'), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const [probe, setProbe] = useState({ offerId: '', itemId: '', quantity: '1', value: '0' });
  const [result, setResult] = useState<Evaluation | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  async function evaluate() {
    setNotice(undefined);
    setResult(null);
    try {
      const evaluation = await apiPost<Evaluation>(`/sales/offers/${probe.offerId}/evaluate`, {
        itemId: probe.itemId,
        quantity: probe.quantity,
        value: probe.value,
      });
      setResult(evaluation);
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <Directory<Offer>
      title="العروض"
      subtitle="قواعد الخصم الترويجي: الشرط (كمية أو قيمة) والخصم الناتج، محدودة بفترة صلاحية."
      crumbs={['الإعدادات', 'المبيعات']}
      query={offers}
      createLabel="عرض جديد"
      formTitle="بطاقة عرض"
      empty="لا توجد عروض"
      emptyDetail="أنشئ عرضاً ثم جرّبه بالحاسبة أسفل الشاشة قبل تفعيله."
      initial={{ validFrom: today(), validTo: today(), targetType: 'quantity', discountType: 'percent', status: 'active' }}
      fields={[
        { name: 'code', label: 'الرمز', required: true, ltr: true },
        { name: 'name', label: 'اسم العرض', required: true },
        { name: 'validFrom', label: 'من تاريخ', type: 'date', required: true },
        { name: 'validTo', label: 'إلى تاريخ', type: 'date', required: true },
        { name: 'targetType', label: 'الشرط على', type: 'select', required: true, options: [{ id: 'quantity', label: 'الكمية' }, { id: 'value', label: 'قيمة السطر' }] },
        { name: 'targetValue', label: 'الحد الأدنى', required: true, placeholder: '10' },
        { name: 'discountType', label: 'نوع الخصم', type: 'select', required: true, options: [{ id: 'percent', label: 'نسبة %' }, { id: 'amount', label: 'مبلغ ثابت' }] },
        { name: 'discountValue', label: 'قيمة الخصم', required: true, placeholder: '5' },
        { name: 'status', label: 'الحالة', type: 'select', options: [{ id: 'active', label: 'مفعّل' }, { id: 'inactive', label: 'موقوف' }] },
      ]}
      onCreate={(values) =>
        apiPost('/sales/offers', {
          code: String(values.code),
          name: String(values.name),
          validFrom: new Date(`${String(values.validFrom)}T00:00:00Z`).toISOString(),
          validTo: new Date(`${String(values.validTo)}T23:59:59Z`).toISOString(),
          status: String(values.status || 'active'),
          targetType: String(values.targetType),
          targetValue: String(values.targetValue),
          discountType: String(values.discountType),
          discountValue: String(values.discountValue),
        })
      }
      successText={(values) => `تم حفظ العرض «${String(values.name)}».`}
      columns={[
        { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code },
        { key: 'name', header: 'العرض', cell: (row) => row.name },
        { key: 'target', header: 'الشرط', cell: (row) => `${TARGETS[row.targetType] ?? row.targetType} ≥ ${quantity(row.targetValue)}` },
        { key: 'discount', header: 'الخصم', cell: (row) => `${DISCOUNTS[row.discountType] ?? row.discountType} ${row.discountValue}` },
        { key: 'from', header: 'من', cell: (row) => shortDate(row.validFrom) },
        { key: 'to', header: 'إلى', cell: (row) => shortDate(row.validTo) },
        { key: 'status', header: 'الحالة', cell: (row) => (row.status === 'active' ? 'مفعّل' : 'موقوف') },
      ]}
      rowKey={(row) => row.id}
    >
      <div className="card">
        <h3>حاسبة العرض</h3>
        <p className="muted small">جرّب العرض على صنف وكمية قبل استخدامه في الفواتير.</p>
        <div className="toolbar">
          <label className="field">
            <span>العرض</span>
            <select className="input" value={probe.offerId} onChange={(event) => setProbe({ ...probe, offerId: event.target.value })}>
              <option value="">—</option>
              {(offers.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.code} — {row.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>الصنف</span>
            <select className="input" value={probe.itemId} onChange={(event) => setProbe({ ...probe, itemId: event.target.value })}>
              <option value="">—</option>
              {(items.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {itemLabel(row)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>الكمية</span>
            <input className="input" dir="ltr" value={probe.quantity} onChange={(event) => setProbe({ ...probe, quantity: event.target.value })} />
          </label>
          <label className="field">
            <span>قيمة السطر</span>
            <input className="input" dir="ltr" value={probe.value} onChange={(event) => setProbe({ ...probe, value: event.target.value })} />
          </label>
          <button type="button" className="btn" disabled={!probe.offerId || !probe.itemId} onClick={evaluate}>
            احسب
          </button>
        </div>
        <Notice notice={notice} />
        {result ? (
          <div className={`alert ${result.eligible ? 'ok' : 'info'}`}>
            {result.eligible
              ? `ينطبق العرض — الخصم ${money(result.discount)}`
              : `لا ينطبق العرض${result.reason ? ` — ${REASONS[result.reason] ?? result.reason}` : ''}`}
          </div>
        ) : null}
      </div>
    </Directory>
  );
}
