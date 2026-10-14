'use client';

import { useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiList, apiPatch, apiPost } from '../../../lib/api';
import { arabicName, itemLabel, listItems, listWarehouses, type Item, type Warehouse } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type Bin = {
  id: string;
  warehouseId: string;
  code: string;
  zone: string | null;
  isActive: boolean;
};

export default function WarehouseBinsPage() {
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const [warehouseId, setWarehouseId] = useState('');
  const bins = useQuery<Bin[]>(
    () => apiList<Bin>(`/inventory/bins${warehouseId ? `?warehouse_id=${warehouseId}` : ''}`),
    [warehouseId],
  );
  const [code, setCode] = useState('A-01-01');
  const [zone, setZone] = useState('A');
  const [aisle, setAisle] = useState('01');
  const [rack, setRack] = useState('01');
  const [level, setLevel] = useState('01');
  const [binId, setBinId] = useState('');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('10');
  const [unitCost, setUnitCost] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string }>();

  const warehouseRows = warehouses.data ?? [];
  const itemRows = items.data ?? [];
  const binRows = bins.data ?? [];

  function fail(error: unknown) {
    setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر تنفيذ العملية' });
  }

  function move(path: 'receive' | 'issue') {
    void apiPost(`/inventory/bins/${binId}/${path}`, { itemId, qty, unitCost: unitCost || undefined })
      .then(() => setNotice({ kind: 'ok', text: path === 'issue' ? 'صُرف من الرف وانخفض رصيد المستودع.' : 'استُلم في الرف وارتفع رصيد المستودع.' }))
      .catch(fail);
  }

  return (
    <Screen
      title="رفوف المستودع"
      subtitle="العنوان مثل A-01-01. الاستلام والصرف يحرّكان رصيد الرف ورصيد المستودع معاً."
      crumbs={['المستودعات', 'الرفوف']}
    >
      <Notice notice={notice} />
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void apiPost('/inventory/bins', { warehouseId, code, zone, aisle, rack, level })
            .then(() => bins.reload())
            .then(() => setNotice({ kind: 'ok', text: `أُنشئ الرف ${code}.` }))
            .catch(fail);
        }}
      >
        <div className="form-grid">
          <label className="field">
            <span>المستودع</span>
            <select className="input" value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)} required>
              <option value="">اختر</option>
              {warehouseRows.map((row) => (
                <option key={row.id} value={row.id}>{arabicName(row)}</option>
              ))}
            </select>
          </label>
          <label className="field"><span>رمز الرف</span><input className="input" dir="ltr" value={code} onChange={(event) => setCode(event.target.value)} required /></label>
          <label className="field"><span>المنطقة</span><input className="input" value={zone} onChange={(event) => setZone(event.target.value)} /></label>
          <label className="field"><span>الممر</span><input className="input" dir="ltr" value={aisle} onChange={(event) => setAisle(event.target.value)} /></label>
          <label className="field"><span>الرف</span><input className="input" dir="ltr" value={rack} onChange={(event) => setRack(event.target.value)} /></label>
          <label className="field"><span>المستوى</span><input className="input" dir="ltr" value={level} onChange={(event) => setLevel(event.target.value)} /></label>
        </div>
        <button className="btn primary" type="submit">إنشاء رف</button>
      </form>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
        {binRows.map((row) => (
          <button
            key={row.id}
            type="button"
            className="card"
            style={{ textAlign: 'right', borderColor: binId === row.id ? 'var(--brand, #2563eb)' : undefined, opacity: row.isActive ? 1 : 0.55 }}
            onClick={() => setBinId(row.id)}
          >
            <strong dir="ltr">{row.code}</strong>
            <p>{row.zone ?? 'بدون منطقة'}{row.isActive ? '' : ' · متوقف'}</p>
          </button>
        ))}
      </section>
      {bins.status === 'success' && binRows.length === 0 ? <p className="card">لا توجد رفوف بعد.</p> : null}

      <section className="card">
        <div className="form-grid">
          <label className="field">
            <span>الرف</span>
            <select className="input" value={binId} onChange={(event) => setBinId(event.target.value)}>
              <option value="">اختر</option>
              {binRows.map((row) => (
                <option key={row.id} value={row.id}>{row.code}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>المادة</span>
            <select className="input" value={itemId} onChange={(event) => setItemId(event.target.value)}>
              <option value="">اختر</option>
              {itemRows.map((row) => (
                <option key={row.id} value={row.id}>{itemLabel(row)}</option>
              ))}
            </select>
          </label>
          <label className="field"><span>الكمية</span><input className="input" dir="ltr" value={qty} onChange={(event) => setQty(event.target.value)} /></label>
          <label className="field"><span>تكلفة الوحدة عند الاستلام</span><input className="input" dir="ltr" value={unitCost} onChange={(event) => setUnitCost(event.target.value)} /></label>
        </div>
        <button className="btn primary" type="button" onClick={() => move('receive')}>استلام</button>
        <button className="btn" type="button" onClick={() => move('issue')}>صرف</button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            const row = binRows.find((entry) => entry.id === binId);
            if (!row) return;
            void apiPatch(`/inventory/bins/${row.id}`, { isActive: !row.isActive }).then(() => bins.reload()).catch(fail);
          }}
        >
          تفعيل / إيقاف
        </button>
      </section>
    </Screen>
  );
}
