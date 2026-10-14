'use client';

import { useMemo, useState } from 'react';

import { Screen } from '../../../components/screen';
import { code128Bars, sanitizeBarcode } from '../../../lib/barcode';
import { itemLabel, listItems, money, type Item } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/** The value printed under the bars: the item's barcode, else its SKU. */
function barcodeOf(item: Item): string {
  return sanitizeBarcode(item.barcode ?? item.sku ?? '');
}

/**
 * Barcode label sheet.
 *
 * The browser's print dialog is the label driver here: pick items, set how many labels
 * each needs, then print. `.no-print` keeps the pickers off the paper.
 */
export default function BarcodesPage() {
  const items = useQuery<Item[]>(() => listItems(), []);
  const [copies, setCopies] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [showPrice, setShowPrice] = useState(true);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const data = items.data ?? [];
    if (!needle) return data.slice(0, 60);
    return data.filter((item) => `${itemLabel(item)} ${item.barcode ?? ''}`.toLowerCase().includes(needle)).slice(0, 60);
  }, [items.data, search]);

  const labels = useMemo(
    () =>
      (items.data ?? [])
        .filter((item) => (copies[item.id] ?? 0) > 0 && barcodeOf(item).length > 0)
        .flatMap((item) => Array.from({ length: Math.min(copies[item.id] ?? 0, 60) }, (_, index) => ({ item, key: `${item.id}-${index}` }))),
    [items.data, copies],
  );

  const missingCode = (items.data ?? []).some((item) => (copies[item.id] ?? 0) > 0 && barcodeOf(item).length === 0);

  return (
    <Screen
      title="طباعة الباركود"
      subtitle="اختر الأصناف وعدد الملصقات لكل صنف، ثم اطبع الورقة على ورق الملصقات. الترميز Code 128-B قابل للمسح."
      crumbs={['المستودعات', 'العمليات']}
      actions={
        <button type="button" className="btn primary" disabled={labels.length === 0} onClick={() => window.print()}>
          طباعة ({labels.length})
        </button>
      }
    >
      <div className="card no-print">
        <div className="toolbar">
          <label className="field">
            <span>بحث عن صنف</span>
            <input className="input" value={search} placeholder="اسم الصنف أو الباركود" onChange={(event) => setSearch(event.target.value)} />
          </label>
          <label className="field">
            <span>السعر على الملصق</span>
            <select className="input" value={showPrice ? 'yes' : 'no'} onChange={(event) => setShowPrice(event.target.value === 'yes')}>
              <option value="yes">يظهر</option>
              <option value="no">لا يظهر</option>
            </select>
          </label>
          <button type="button" className="btn" onClick={() => setCopies({})}>
            تفريغ الورقة
          </button>
        </div>

        {missingCode ? <div className="alert warn">بعض الأصناف المختارة بلا باركود أو رمز صنف، ولن تُطبع لها ملصقات.</div> : null}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الصنف</th>
                <th>الباركود</th>
                <th>السعر</th>
                <th>عدد الملصقات</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id}>
                  <td>{itemLabel(item)}</td>
                  <td dir="ltr">{barcodeOf(item) || '—'}</td>
                  <td className="num">{money(item.salePrice ?? item.sale_price ?? '0')}</td>
                  <td>
                    <input
                      className="input"
                      dir="ltr"
                      type="number"
                      min={0}
                      max={60}
                      value={copies[item.id] ?? 0}
                      onChange={(event) => setCopies({ ...copies, [item.id]: Math.max(0, Math.min(60, Number(event.target.value) || 0)) })}
                    />
                  </td>
                </tr>
              ))}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    لا توجد أصناف مطابقة.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {labels.length > 0 ? (
        <div className="card">
          <h3 className="no-print">معاينة الورقة</h3>
          <div className="label-sheet">
            {labels.map(({ item, key }) => {
              const value = barcodeOf(item);
              const { bars, width } = code128Bars(value);
              return (
                <div className="label" key={key}>
                  <span className="label-name">{itemLabel(item)}</span>
                  <svg className="label-bars" viewBox={`0 0 ${width} 40`} preserveAspectRatio="none" role="img" aria-label={value}>
                    {bars.map((bar) => (
                      <rect key={`${bar.x}`} x={bar.x} y={0} width={bar.width} height={40} fill="var(--text)" />
                    ))}
                  </svg>
                  <span className="label-code" dir="ltr">
                    {value}
                  </span>
                  {showPrice ? <span className="label-price">{money(item.salePrice ?? item.sale_price ?? '0')}</span> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </Screen>
  );
}
