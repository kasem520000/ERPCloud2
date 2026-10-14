'use client';

import { useState } from 'react';

import { Directory } from '../../../components/directory';
import { Notice } from '../../../components/data-view';
import { FilterBar } from '../../../components/ui';
import { ApiError, apiPost } from '../../../lib/api';
import { deleteLot, itemLabel, listItems, listLots, shortDate, type Item, type Lot } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

export default function LotsPage() {
  const { can } = useSession();
  const manage = can('inventory.adjust');
  const [itemId, setItemId] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();
  const lots = useQuery<Lot[]>(() => listLots({ itemId: itemId || undefined, q: search.trim() || undefined }), [itemId, search]);
  const items = useQuery<Item[]>(() => listItems(), []);
  const itemRows = items.data ?? [];
  const lotRows = lots.data ?? [];
  const today = new Date().toISOString().slice(0, 10);

  async function drop(row: Lot) {
    if (!window.confirm(`حذف الدفعة ${row.lotNo}؟`)) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await deleteLot(row.id);
      setNotice({ kind: 'ok', text: `حُذفت الدفعة ${row.lotNo}.` });
      lots.reload();
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Directory<Lot>
      title="صلاحية المواد (الدفعات)"
      subtitle="دفعات الإنتاج وتواريخ انتهاء الصلاحية المرتبطة بالمواد."
      crumbs={['المستودعات', 'تقارير مستودعية']}
      query={lots}
      canCreate={manage}
      createLabel="دفعة جديدة"
      blocked={itemRows.length === 0 ? 'أضف مادة واحدة على الأقل من «دليل المواد».' : undefined}
      fields={[
        { name: 'itemId', label: 'المادة', type: 'select', required: true, options: itemRows.map((row) => ({ id: row.id, label: itemLabel(row) })) },
        { name: 'lotNo', label: '📁 رقم الدفعة', required: true, ltr: true },
        { name: 'productionDate', label: '📅 تاريخ الإنتاج', type: 'date' },
        { name: 'expiryDate', label: '⏳ تاريخ الانتهاء', type: 'date' },
        // تاريخ الاستلام كان يُكتب باسم «📅 تاريخ الإنتاج» — وهو عنوانٌ لا يصف العمود (R5).
        { name: 'receivedAt', label: '📥 تاريخ الاستلام', type: 'date' },
      ]}
      onCreate={(values) =>
        apiPost('/inventory/lots', {
          itemId: String(values.itemId),
          lotNo: String(values.lotNo).trim(),
          productionDate: String(values.productionDate) || undefined,
          expiryDate: String(values.expiryDate) || undefined,
          receivedAt: String(values.receivedAt) || undefined,
        })
      }
      successText={(values) => `تمت إضافة الدفعة ${String(values.lotNo)}.`}
      rowKey={(row) => row.id}
      tiles={[
        { label: 'عدد الدفعات', value: lotRows.length, hint: 'دفعة مسجّلة', tone: 'brand' },
        {
          label: 'منتهية',
          value: lotRows.filter((row) => row.expiryDate && row.expiryDate < today).length,
          hint: 'تجاوزت تاريخ الصلاحية',
          tone: lotRows.some((row) => row.expiryDate && row.expiryDate < today) ? 'danger' : 'ok',
        },
        {
          label: 'دفعات منتهية خلال شهر',
          value: lotRows.filter((row) => {
            if (!row.expiryDate || row.expiryDate < today) return false;
            const days = Math.round((new Date(row.expiryDate).getTime() - Date.now()) / 86400000);
            return days <= 30;
          }).length,
          hint: 'تحتاج متابعة',
          tone: 'warn',
        },
        {
          label: 'بدون تاريخ صلاحية',
          value: lotRows.filter((row) => !row.expiryDate).length,
          hint: 'لن تظهر في تقرير الصلاحية',
        },
        { label: 'مواد لها دفعات', value: new Set(lotRows.map((row) => row.itemId)).size, hint: 'مادة' },
      ]}
      empty="لا توجد دفعات"
      children={
        <>
          {notice ? <Notice notice={notice} /> : null}
          <FilterBar>
          <label className="field">
            <span>المادة</span>
            <select className="input" value={itemId} onChange={(event) => setItemId(event.target.value)}>
              <option value="">كل المواد</option>
              {itemRows.map((row) => (
                <option key={row.id} value={row.id}>
                  {itemLabel(row)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>بحث برقم الدفعة</span>
            <input
              className="input"
              dir="ltr"
              placeholder="LOT-1"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          </FilterBar>
        </>
      }
      columns={[
        {
          key: 'item',
          header: 'المادة',
          cell: (row) => {
            const item = itemRows.find((entry) => entry.id === row.itemId);
            return item ? itemLabel(item) : row.itemId;
          },
        },
        { key: 'lot', header: '📁 رقم الدفعة', align: 'ltr', cell: (row) => row.lotNo },
        { key: 'produced', header: '📅 تاريخ الإنتاج', align: 'ltr', cell: (row) => shortDate(row.productionDate) },
        { key: 'expiry', header: '⏳ تاريخ الانتهاء', align: 'ltr', cell: (row) => shortDate(row.expiryDate) },
        { key: 'received', header: '📥 تاريخ الاستلام', align: 'ltr', cell: (row) => shortDate(row.receivedAt) },
        ...(manage
          ? [
              {
                key: 'actions',
                header: '',
                cell: (row: Lot) => (
                  <button className="btn sm danger" type="button" disabled={busy} onClick={() => void drop(row)}>
                    حذف
                  </button>
                ),
              },
            ]
          : []),
      ]}

    />
  );
}
