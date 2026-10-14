'use client';

import { useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import { itemLabel, listItems, quantity, type Item } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type Line = { componentItemId: string; qty: string; scrapPercent: string };
type BomCard = {
  id: string;
  name: string;
  version: number;
  productItemId: string;
  isActive: boolean;
  lines: Array<{ componentItemId: string; qty: string; scrapPercent: string }>;
};

const emptyLine = (): Line => ({ componentItemId: '', qty: '1', scrapPercent: '0' });

export default function BomsPage() {
  const items = useQuery<Item[]>(() => listItems(), []);
  const cards = useQuery<BomCard[]>(() => apiList<BomCard>('/manufacturing/boms'), []);
  const [name, setName] = useState('');
  const [productItemId, setProductItemId] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string }>();
  const itemRows = items.data ?? [];
  const nameOf = (id: string) => {
    const found = itemRows.find((row) => row.id === id);
    return found ? itemLabel(found) : id;
  };

  return (
    <Screen
      title="قوائم المواد"
      subtitle="الكمية لكل وحدة منتج. نسبة الهدر تُضاف على الصرف عند التنفيذ."
      crumbs={['التصنيع', 'قوائم المواد']}
    >
      <Notice notice={notice} />
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void apiPost('/manufacturing/boms', {
            name,
            productItemId,
            lines: lines.filter((line) => line.componentItemId),
          })
            .then(() => cards.reload())
            .then(() => setNotice({ kind: 'ok', text: 'حُفظت قائمة المواد.' }))
            .catch((error: unknown) => setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : 'تعذر الحفظ' }));
        }}
      >
        <div className="form-grid">
          <label className="field"><span>الاسم</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label className="field">
            <span>المنتج النهائي</span>
            <select className="input" value={productItemId} onChange={(event) => setProductItemId(event.target.value)} required>
              <option value="">اختر</option>
              {itemRows.map((row) => <option key={row.id} value={row.id}>{itemLabel(row)}</option>)}
            </select>
          </label>
        </div>
        {lines.map((line, index) => (
          <div className="form-grid" key={index}>
            <label className="field">
              <span>مكوّن {index + 1}</span>
              <select
                className="input"
                value={line.componentItemId}
                onChange={(event) => setLines((current) => current.map((entry, at) => at === index ? { ...entry, componentItemId: event.target.value } : entry))}
              >
                <option value="">اختر</option>
                {itemRows.map((row) => <option key={row.id} value={row.id}>{itemLabel(row)}</option>)}
              </select>
            </label>
            <label className="field">
              <span>الكمية</span>
              <input className="input" dir="ltr" value={line.qty} onChange={(event) => setLines((current) => current.map((entry, at) => at === index ? { ...entry, qty: event.target.value } : entry))} />
            </label>
            <label className="field">
              <span>هدر %</span>
              <input className="input" dir="ltr" value={line.scrapPercent} onChange={(event) => setLines((current) => current.map((entry, at) => at === index ? { ...entry, scrapPercent: event.target.value } : entry))} />
            </label>
          </div>
        ))}
        <button className="btn" type="button" onClick={() => setLines((current) => [...current, emptyLine()])}>مكوّن آخر</button>
        <button className="btn primary" type="submit">حفظ القائمة</button>
      </form>
      <DataTable
        rows={cards.data ?? []}
        rowKey={(row) => row.id}
        columns={[
          { key: 'name', header: 'القائمة', cell: (row) => `${row.name} · v${row.version}` },
          { key: 'product', header: 'المنتج', cell: (row) => nameOf(row.productItemId) },
          {
            key: 'lines',
            header: 'المكوّنات',
            cell: (row) => row.lines.map((line) => `${nameOf(line.componentItemId)} × ${quantity(line.qty)}`).join(' + '),
          },
        ]}
      />
    </Screen>
  );
}
