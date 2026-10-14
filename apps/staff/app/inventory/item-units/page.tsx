'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { FilterBar, StatTile, StatTiles } from '../../../components/ui';
import { ApiError } from '../../../lib/api';
import {
  addItemBarcode,
  arabicName,
  listItemBarcodes,
  listItemUnits,
  listItems,
  listUnits,
  removeItemBarcode,
  removeItemUnit,
  setItemUnit,
  type Item,
  type ItemBarcode,
  type ItemUnit,
  type Unit,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * وحدات القياس المتعددة والباركود المتعدد — the desktop's `ItemUnits` screen.
 *
 * The stock ledger only ever holds base units, so the ratio written here is what turns
 * «3 كراتين» into 36 pieces when the movement is posted
 * (`ItemPrimaryQnty = ItemQuantity × UnitEquality`). A barcode attached to a unit is
 * what makes a scanner able to sell a whole carton without arithmetic.
 */
export default function ItemUnitsPage() {
  const { can } = useSession();
  const manage = can('catalog.item.manage');

  const items = useQuery<Item[]>(() => listItems(), []);
  const units = useQuery<Unit[]>(() => listUnits(), []);

  const [itemId, setItemId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [ratio, setRatio] = useState('');
  const [unitBarcode, setUnitBarcode] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [defaultSale, setDefaultSale] = useState(false);
  const [label, setLabel] = useState('');
  const [labelUnit, setLabelUnit] = useState('');

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const itemUnits = useQuery<ItemUnit[]>(
    () => (itemId ? listItemUnits(itemId) : Promise.resolve([])),
    [itemId, busy],
  );
  const barcodes = useQuery<ItemBarcode[]>(
    () => (itemId ? listItemBarcodes(itemId) : Promise.resolve([])),
    [itemId, busy],
  );

  const itemRows = items.data ?? [];
  const unitRows = units.data ?? [];
  const selected = itemRows.find((row) => row.id === itemId);
  const unitName = (id?: string | null) =>
    unitRows.find((row) => row.id === id)?.nameAr ?? arabicName(unitRows.find((row) => row.id === id) ?? {});

  async function saveUnit(event: React.FormEvent) {
    event.preventDefault();
    if (!itemId) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await setItemUnit(itemId, {
        unitId,
        ratio,
        barcode: unitBarcode.trim() || null,
        salePrice: salePrice.trim() || undefined,
        purchasePrice: purchasePrice.trim() || undefined,
        isDefaultSale: defaultSale,
      });
      setNotice({
        kind: 'ok',
        text: `تم حفظ الوحدة: 1 ${unitName(unitId)} = ${ratio} ${unitName(selected?.baseUnitId ?? selected?.base_unit_id)}.`,
      });
      setRatio('');
      setUnitBarcode('');
      setSalePrice('');
      setPurchasePrice('');
      setDefaultSale(false);
      setUnitId('');
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function dropUnit(row: ItemUnit) {
    if (!itemId) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await removeItemUnit(itemId, row.unitId);
      setNotice({ kind: 'ok', text: 'تم حذف الوحدة من الصنف.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function saveLabel(event: React.FormEvent) {
    event.preventDefault();
    if (!itemId) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await addItemBarcode(itemId, { barcode: label.trim(), unitId: labelUnit || null });
      setNotice({ kind: 'ok', text: `تم ربط الباركود ${label.trim()} بالصنف.` });
      setLabel('');
      setLabelUnit('');
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function dropLabel(row: ItemBarcode) {
    if (!itemId) return;
    if (!window.confirm(`إزالة الباركود ${row.barcode} من هذا الصنف؟`)) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await removeItemBarcode(itemId, row.barcode);
      setNotice({ kind: 'ok', text: 'تمت إزالة الباركود.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="وحدات القياس والباركود"
      subtitle="لكل صنف وحدة أساسية واحدة، وأي عدد من وحدات التعبئة بباركود خاص لكل منها."
      crumbs={['المستودعات', 'التعاريف']}
    >
      <FilterBar
        actions={
          selected ? (
            <span className="small muted">
              الوحدة الأساسية: <strong>{unitName(selected.baseUnitId ?? selected.base_unit_id)}</strong>
            </span>
          ) : undefined
        }
      >
        <label className="field">
          <span>الصنف</span>
          <select
            className="input"
            value={itemId}
            onChange={(event) => {
              setItemId(event.target.value);
              setNotice(undefined);
            }}
          >
            <option value="">— اختر صنفاً —</option>
            {itemRows.map((row) => (
              <option key={row.id} value={row.id}>
                {`${row.sku} — ${arabicName(row)}`}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      {itemId && (
        <StatTiles>
          <StatTile
            label="الوحدة الأساسية"
            value={unitName(selected?.baseUnitId ?? selected?.base_unit_id)}
            hint="كل كمية في المخزون محفوظة بها"
            tone="brand"
          />
          <StatTile
            label="وحدات التعبئة"
            value={(itemUnits.data ?? []).length}
            hint="علبة · كرتون · عبوة"
          />
          <StatTile
            label="باركودات إضافية"
            value={(barcodes.data ?? []).length}
            hint="ملصق آخر لنفس الصنف"
          />
          <StatTile
            label="وحدات بلا باركود"
            value={(itemUnits.data ?? []).filter((row) => !row.barcode).length}
            hint="لن تُقرأ بالقارئ"
            tone={(itemUnits.data ?? []).some((row) => !row.barcode) ? 'warn' : 'ok'}
          />
        </StatTiles>
      )}

      {itemId && (itemUnits.data ?? []).length > 0 && (
        <div className="tiles">
          {(itemUnits.data ?? []).map((row) => (
            <div className="tile" key={row.unitId}>
              <span className="tile-label">{row.unitNameAr ?? unitName(row.unitId)}</span>
              <span className="tile-value" dir="ltr">
                {`1 = ${Number(row.ratio).toLocaleString('ar-EG')}`}
              </span>
              <span className="tile-hint">
                {`من ${unitName(selected?.baseUnitId ?? selected?.base_unit_id)} · الباركود: ${row.barcode ?? '—'}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {!itemId ? (
        <div className="card">
          <p className="muted">
            اختر صنفاً لتحديد وحداته (علبة، كرتون، عبوة…) وباركوداته الإضافية. الكمية التي تدخلها في أي مستند
            تُضرب بمعامل التحويل لتُخزَّن بالوحدة الأساسية.
          </p>
        </div>
      ) : (
        <>
          <div className="card">
            <h2>وحدات القياس</h2>
            <QueryView
              query={itemUnits}
              empty="لا توجد وحدات إضافية"
              emptyDetail="الوحدة الأساسية وحدها كافية للعمل، وأي وحدة أخرى اختيارية."
            >
              {(rows) => (
                <DataTable
                  rows={rows}
                  rowKey={(row) => row.unitId}
                  columns={[
                    { key: 'unit', header: 'الوحدة', cell: (row) => row.unitNameAr ?? unitName(row.unitId) },
                    {
                      key: 'ratio',
                      header: 'معامل التحويل',
                      align: 'num',
                      cell: (row) => Number(row.ratio).toLocaleString('ar-EG', { maximumFractionDigits: 2 }),
                    },
                    {
                      key: 'eq',
                      header: 'تساوي',
                      cell: (row) =>
                        `1 = ${Number(row.ratio).toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ${unitName(selected?.baseUnitId ?? selected?.base_unit_id)}`,
                    },
                    {
                      key: 'barcode',
                      header: 'باركود الوحدة',
                      align: 'ltr',
                      cell: (row) => row.barcode ?? '—',
                    },
                    { key: 'sale', header: 'سعر البيع', align: 'num', cell: (row) => row.salePrice ?? '—' },
                    {
                      key: 'default',
                      header: 'افتراضي للبيع',
                      cell: (row) => (row.isDefaultSale ? 'نعم' : '—'),
                    },
                    ...(manage
                      ? [
                          {
                            key: 'actions',
                            header: '',
                            cell: (row: ItemUnit) => (
                              <button
                                className="btn sm danger"
                                type="button"
                                onClick={() => void dropUnit(row)}
                                disabled={busy}
                              >
                                حذف
                              </button>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              )}
            </QueryView>

            {manage && (
              <form className="form-grid" onSubmit={saveUnit}>
                <label className="field">
                  <span>الوحدة *</span>
                  <select
                    className="input"
                    value={unitId}
                    onChange={(event) => setUnitId(event.target.value)}
                    required
                  >
                    <option value="">— اختر —</option>
                    {unitRows.map((row) => (
                      <option key={row.id} value={row.id}>
                        {`${row.code} — ${arabicName(row)}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>معامل التحويل (كم وحدة أساسية) *</span>
                  <input
                    className="input"
                    dir="ltr"
                    inputMode="decimal"
                    value={ratio}
                    onChange={(event) => setRatio(event.target.value)}
                    placeholder="12"
                    required
                  />
                </label>
                <label className="field">
                  <span>باركود الوحدة</span>
                  <input
                    className="input"
                    dir="ltr"
                    value={unitBarcode}
                    onChange={(event) => setUnitBarcode(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>سعر البيع بهذه الوحدة</span>
                  <input
                    className="input"
                    dir="ltr"
                    inputMode="decimal"
                    value={salePrice}
                    onChange={(event) => setSalePrice(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>سعر الشراء بهذه الوحدة</span>
                  <input
                    className="input"
                    dir="ltr"
                    inputMode="decimal"
                    value={purchasePrice}
                    onChange={(event) => setPurchasePrice(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>الوحدة الافتراضية للبيع</span>
                  <select
                    className="input"
                    value={defaultSale ? 'yes' : 'no'}
                    onChange={(event) => setDefaultSale(event.target.value === 'yes')}
                  >
                    <option value="no">لا</option>
                    <option value="yes">نعم</option>
                  </select>
                </label>
                <div className="row">
                  <button className="btn primary" type="submit" disabled={busy}>
                    حفظ الوحدة
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="card">
            <h2>باركودات إضافية</h2>
            <QueryView
              query={barcodes}
              empty="لا توجد باركودات إضافية"
              emptyDetail="أضف ملصقاً آخر لنفس الصنف — مثلاً باركود الكرتون كاملاً."
            >
              {(rows) => (
                <DataTable
                  rows={rows}
                  rowKey={(row) => row.barcode}
                  columns={[
                    { key: 'barcode', header: 'الباركود', align: 'ltr', cell: (row) => row.barcode },
                    {
                      key: 'unit',
                      header: 'الوحدة',
                      cell: (row) =>
                        row.unitNameAr ?? (row.unitId ? unitName(row.unitId) : 'الوحدة الأساسية'),
                    },
                    ...(manage
                      ? [
                          {
                            key: 'actions',
                            header: '',
                            cell: (row: ItemBarcode) => (
                              <button
                                className="btn sm danger"
                                type="button"
                                onClick={() => void dropLabel(row)}
                                disabled={busy}
                              >
                                إزالة
                              </button>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              )}
            </QueryView>

            {manage && (
              <form className="form-grid" onSubmit={saveLabel}>
                <label className="field">
                  <span>الباركود *</span>
                  <input
                    className="input"
                    dir="ltr"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>يُقرأ بوحدة</span>
                  <select
                    className="input"
                    value={labelUnit}
                    onChange={(event) => setLabelUnit(event.target.value)}
                  >
                    <option value="">الوحدة الأساسية</option>
                    {unitRows.map((row) => (
                      <option key={row.id} value={row.id}>
                        {`${row.code} — ${arabicName(row)}`}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="row">
                  <button className="btn primary" type="submit" disabled={busy}>
                    ربط الباركود
                  </button>
                </div>
              </form>
            )}
          </div>
        </>
      )}

      <Notice notice={notice} />
    </Screen>
  );
}
