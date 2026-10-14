'use client';

import { useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import { itemLabel, listItems, quantity, type Item } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type BinBalanceRow = {
  id: string;
  binId: string;
  binCode: string;
  warehouseId: string;
  itemId: string;
  itemSku: string;
  itemName: string;
  quantity: string;
};

type Bin = { id: string; code: string; warehouseId: string };

export default function BinBalancesPage() {
  const rows = useQuery<BinBalanceRow[]>(() => apiList<BinBalanceRow>('/inventory/bin-balances'), []);
  const bins = useQuery<Bin[]>(() => apiList<Bin>('/inventory/bins'), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const [fromBinId, setFromBinId] = useState('');
  const [toBinId, setToBinId] = useState('');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('1');
  const [countBinId, setCountBinId] = useState('');
  const [countedQty, setCountedQty] = useState('0');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string }>();

  const binRows = bins.data ?? [];
  const itemRows = items.data ?? [];

  function fail(error: unknown) {
    setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر تنفيذ العملية' });
  }

  return (
    <Screen
      title="أرصدة الرفوف"
      subtitle="النقل بين رفوف المستودع نفسه لا يغيّر رصيد المستودع. الجرد يسوّي فرق الرف على المستودع."
      crumbs={['المستودعات', 'أرصدة الرفوف']}
    >
      <Notice notice={notice} />
      <section className="card">
        <div className="form-grid">
          <label className="field">
            <span>من رف</span>
            <select className="input" value={fromBinId} onChange={(event) => setFromBinId(event.target.value)}>
              <option value="">اختر</option>
              {binRows.map((row) => <option key={row.id} value={row.id}>{row.code}</option>)}
            </select>
          </label>
          <label className="field">
            <span>إلى رف</span>
            <select className="input" value={toBinId} onChange={(event) => setToBinId(event.target.value)}>
              <option value="">اختر</option>
              {binRows.map((row) => <option key={row.id} value={row.id}>{row.code}</option>)}
            </select>
          </label>
          <label className="field">
            <span>المادة</span>
            <select className="input" value={itemId} onChange={(event) => setItemId(event.target.value)}>
              <option value="">اختر</option>
              {itemRows.map((row) => <option key={row.id} value={row.id}>{itemLabel(row)}</option>)}
            </select>
          </label>
          <label className="field"><span>الكمية</span><input className="input" dir="ltr" value={qty} onChange={(event) => setQty(event.target.value)} /></label>
        </div>
        <button
          className="btn primary"
          type="button"
          onClick={() => {
            void apiPost('/inventory/bin-transfers', { fromBinId, toBinId, itemId, qty })
              .then(() => rows.reload())
              .then(() => setNotice({ kind: 'ok', text: 'نُقلت الكمية بين الرفين.' }))
              .catch(fail);
          }}
        >
          نقل
        </button>
      </section>
      <section className="card">
        <div className="form-grid">
          <label className="field">
            <span>رف الجرد</span>
            <select className="input" value={countBinId} onChange={(event) => setCountBinId(event.target.value)}>
              <option value="">اختر</option>
              {binRows.map((row) => <option key={row.id} value={row.id}>{row.code}</option>)}
            </select>
          </label>
          <label className="field"><span>الكمية المعدودة</span><input className="input" dir="ltr" value={countedQty} onChange={(event) => setCountedQty(event.target.value)} /></label>
        </div>
        <button
          className="btn"
          type="button"
          onClick={() => {
            void apiPost('/inventory/bin-counts', { binId: countBinId, itemId, countedQty })
              .then(() => rows.reload())
              .then(() => setNotice({ kind: 'ok', text: 'سُجّل الجرد.' }))
              .catch(fail);
          }}
        >
          تسجيل الجرد
        </button>
      </section>
      <DataTable
        rows={rows.data ?? []}
        rowKey={(row) => row.id}
        columns={[
          { key: 'bin', header: 'الرف', cell: (row) => row.binCode },
          { key: 'item', header: 'المادة', cell: (row) => `${row.itemSku} — ${row.itemName}` },
          { key: 'qty', header: 'الكمية', align: 'num', cell: (row) => quantity(row.quantity) },
        ]}
      />
    </Screen>
  );
}
