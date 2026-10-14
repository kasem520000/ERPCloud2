'use client';

import { useEffect, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { DocField, DocHead, FilterBar, StatTile, StatTiles, Tabs, Totals } from '../../../components/ui';
import { ApiError, apiDelete, apiList, apiPatch, apiPost } from '../../../lib/api';
import {
  arabicName,
  listCategories,
  listItemComponents,
  listItemUnits,
  listItems,
  listTaxGroups,
  listUnits,
  listWarehouses,
  money,
  quantity,
  removeItemComponent,
  setItemComponent,
  type Category,
  type Item,
  type ItemComponent,
  type ItemUnit,
  type TaxGroup,
  type Unit,
  type Warehouse,
} from '../../../lib/lookups';
import { getCustomFieldValues, saveCustomFieldValues, type CustomFieldValue } from '../../../lib/custom-fields';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/** The four tabs of the item card, exactly as `frmItems.xaml` lays them out. */
type CardTab = 'general' | 'units' | 'opening' | 'components';

const CARD_TABS: Array<{ id: CardTab; label: string }> = [
  { id: 'general', label: 'عام' },
  { id: 'units', label: 'وحدات' },
  { id: 'opening', label: 'بضاعة أول المدة' },
  { id: 'components', label: 'المكونات' },
];

type Level = { itemId: string; warehouseId: string; quantity: string; value: string; averageCost: string };

export default function ItemsPage() {
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const items = useQuery<Item[]>(() => listItems(applied || undefined), [applied]);
  const categories = useQuery<Category[]>(() => listCategories(), []);
  const units = useQuery<Unit[]>(() => listUnits(), []);
  const taxGroups = useQuery<TaxGroup[]>(() => listTaxGroups(), []);

  const [open, setOpen] = useState(false);
  /**
   * حد الطلب / حد الطلب الأقصى وتتبع الدفعات والأرقام التسلسلية: the fields that turn a
   * catalogue card into something the stock engine can act on — a reorder report needs
   * `minQty`, and a lot-controlled item cannot be received without naming its lot.
   */
  const blank = {
    sku: '',
    barcode: '',
    nameAr: '',
    nameEn: '',
    categoryId: '',
    baseUnitId: '',
    kind: 'stock',
    salePrice: '',
    purchasePrice: '',
    taxGroupId: '',
    minQty: '',
    maxQty: '',
    trackLot: false,
    trackSerial: false,
  };
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<Item | undefined>();
  const [selectedId, setSelectedId] = useState('');
  const [customValues, setCustomValues] = useState<CustomFieldValue[]>([]);
  const [customDraft, setCustomDraft] = useState<Record<string, unknown>>({});
  const [customBusy, setCustomBusy] = useState(false);
  const [tab, setTab] = useState<CardTab>('general');
  const [componentDraft, setComponentDraft] = useState({
    componentItemId: '',
    qty: '1',
    unitId: '',
    warehouseId: '',
    kind: 'component',
  });
  const [componentBusy, setComponentBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  function startEdit(row: Item) {
    setEditing(row);
    setForm({
      sku: row.sku,
      barcode: row.barcode ?? '',
      nameAr: row.nameAr ?? row.name_ar ?? '',
      nameEn: row.nameEn ?? '',
      categoryId: row.categoryId ?? row.category_id ?? '',
      baseUnitId: row.baseUnitId ?? row.base_unit_id ?? '',
      kind: row.kind ?? 'stock',
      salePrice: row.salePrice ?? row.sale_price ?? '',
      purchasePrice: row.purchasePrice ?? row.purchase_price ?? '',
      taxGroupId: row.taxGroupId ?? row.tax_group_id ?? '',
      minQty: row.minQty ?? row.min_qty ?? '',
      maxQty: row.maxQty ?? row.max_qty ?? '',
      trackLot: Boolean(row.trackLot ?? row.track_lot),
      trackSerial: Boolean(row.trackSerial ?? row.track_serial),
    });
    setNotice(undefined);
    setOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelEdit() {
    setEditing(undefined);
    setForm(blank);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      if (editing) {
        // The base unit is intentionally absent from the patch: every stored quantity and
        // moving-average cost of this item is expressed in it, so it stays as issued.
        await apiPatch(`/organization/catalog/items/${editing.id}`, {
          sku: form.sku.trim(),
          barcode: form.barcode.trim() || null,
          nameAr: form.nameAr.trim(),
          nameEn: form.nameEn.trim() || null,
          categoryId: form.categoryId,
          kind: form.kind,
          salePrice: form.salePrice.trim() || undefined,
          purchasePrice: form.purchasePrice.trim() || undefined,
          taxGroupId: form.taxGroupId || null,
          minQty: form.minQty.trim() || undefined,
          maxQty: form.maxQty.trim() || null,
          trackLot: form.trackLot,
          trackSerial: form.trackSerial,
        });
        setNotice({ kind: 'ok', text: `تم حفظ تعديل المادة ${form.sku}.` });
        cancelEdit();
      } else {
        await apiPost('/organization/catalog/items', {
          sku: form.sku.trim(),
          barcode: form.barcode.trim() || undefined,
          nameAr: form.nameAr.trim(),
          nameEn: form.nameEn.trim() || undefined,
          categoryId: form.categoryId,
          baseUnitId: form.baseUnitId,
          kind: form.kind,
          salePrice: form.salePrice.trim() || undefined,
          purchasePrice: form.purchasePrice.trim() || undefined,
          taxGroupId: form.taxGroupId || undefined,
          minQty: form.minQty.trim() || undefined,
          maxQty: form.maxQty.trim() || undefined,
          trackLot: form.trackLot,
          trackSerial: form.trackSerial,
        });
        setNotice({ kind: 'ok', text: `تمت إضافة المادة ${form.sku}.` });
        setForm({
          ...blank,
          categoryId: form.categoryId,
          baseUnitId: form.baseUnitId,
          taxGroupId: form.taxGroupId,
        });
      }
      items.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: Item) {
    if (!window.confirm(`هل تريد حذف المادة ${row.sku}؟ إذا كانت لها حركات فسيتم أرشفتها فقط.`)) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await apiDelete<{ archived?: boolean }>(`/organization/catalog/items/${row.id}`);
      setNotice({
        kind: 'ok',
        text: result?.archived
          ? `للمادة ${row.sku} حركات سابقة، فتمت أرشفتها بدل حذفها.`
          : `تم حذف المادة ${row.sku}.`,
      });
      if (editing?.id === row.id) cancelEdit();
      items.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const categoryRows = categories.data ?? [];
  const unitRows = units.data ?? [];
  const missingRefs = categoryRows.length === 0 || unitRows.length === 0;

  const rows = items.data ?? [];
  const selected = rows.find((row) => row.id === selectedId);
  useEffect(() => {
    if (!selected) { setCustomValues([]); setCustomDraft({}); return; }
    void getCustomFieldValues('item', selected.id).then((values) => {
      setCustomValues(values);
      setCustomDraft(Object.fromEntries(values.map((field) => [field.key, field.value ?? (field.type === 'boolean' ? false : '')])));
    }).catch(() => { setCustomValues([]); setCustomDraft({}); });
  }, [selectedId, selected]);
  const cardUnits = useQuery<ItemUnit[]>(
    () => (selected ? listItemUnits(selected.id) : Promise.resolve([])),
    [selectedId],
  );
  const cardLevels = useQuery<Level[]>(
    () => (selected ? apiList<Level>(`/inventory/levels?item_id=${selected.id}`) : Promise.resolve([])),
    [selectedId],
  );
  const stockQty = (cardLevels.data ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  const stockValue = (cardLevels.data ?? []).reduce((sum, row) => sum + Number(row.value), 0);

  // مكوّنات الصنف — the bill of materials, and the units of the component being added.
  const warehouseRows = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const components = useQuery<ItemComponent[]>(
    () => (selected ? listItemComponents(selected.id) : Promise.resolve([])),
    [selectedId],
  );
  const componentUnits = useQuery<ItemUnit[]>(
    () => (componentDraft.componentItemId ? listItemUnits(componentDraft.componentItemId) : Promise.resolve([])),
    [componentDraft.componentItemId],
  );
  const componentRows = components.data ?? [];
  const manage = can('catalog.item.manage');

  async function saveComponent(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setComponentBusy(true);
    setNotice(undefined);
    try {
      await setItemComponent(selected.id, {
        componentItemId: componentDraft.componentItemId,
        qty: componentDraft.qty,
        unitId: componentDraft.unitId || undefined,
        warehouseId: componentDraft.warehouseId || undefined,
        kind: componentDraft.kind,
      });
      setNotice({ kind: 'ok', text: 'حُفظ المكوّن في بطاقة الصنف.' });
      setComponentDraft({ ...componentDraft, componentItemId: '', qty: '1', unitId: '' });
      components.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setComponentBusy(false);
    }
  }

  async function saveCustomValues() {
    if (!selected) return;
    setCustomBusy(true);
    try {
      await saveCustomFieldValues('item', selected.id, customDraft);
      setNotice({ kind: 'ok', text: 'تم حفظ الحقول الإضافية للصنف.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setCustomBusy(false);
    }
  }

  async function dropComponent(row: ItemComponent) {
    if (!selected) return;
    if (!window.confirm(`إزالة المكوّن ${row.sku} — ${row.nameAr ?? ''} من بطاقة الصنف؟`)) return;
    setComponentBusy(true);
    setNotice(undefined);
    try {
      await removeItemComponent(selected.id, row.componentItemId);
      setNotice({ kind: 'ok', text: 'أُزيل المكوّن من البطاقة.' });
      components.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setComponentBusy(false);
    }
  }

  return (
    <Screen
      title="دليل المواد"
      subtitle="بطاقات الأصناف: الرمز، المجموعة، وحدة القياس، الأسعار والضريبة."
      crumbs={['المستودعات', 'التعاريف']}
      actions={
        can('catalog.item.manage') ? (
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              if (open) cancelEdit();
              setOpen(!open);
            }}
          >
            {open ? 'إغلاق' : 'مادة جديدة'}
          </button>
        ) : null
      }
    >
      {open && (
        <form className="card" onSubmit={submit}>
          <h2>{editing ? `تعديل بطاقة المادة ${editing.sku}` : 'بطاقة مادة جديدة'}</h2>
          {missingRefs && !editing && (
            <p className="alert warn">
              يلزم وجود مجموعة واحدة ووحدة قياس واحدة على الأقل. أنشئها من «بطاقة مجموعة» و«بطاقة وحدة».
            </p>
          )}
          <div className="form-grid">
            <label className="field">
              <span>الرمز (SKU) *</span>
              <input className="input" dir="ltr" value={form.sku} onChange={set('sku')} required />
            </label>
            <label className="field">
              <span>الباركود</span>
              <input
                className="input"
                dir="ltr"
                value={form.barcode}
                onChange={set('barcode')}
                placeholder="يُستخدم الرمز (SKU) عند تركه فارغاً"
              />
            </label>
            <label className="field">
              <span>الاسم العربي *</span>
              <input className="input" value={form.nameAr} onChange={set('nameAr')} required />
            </label>
            <label className="field">
              <span>الاسم الإنجليزي</span>
              <input className="input" dir="ltr" value={form.nameEn} onChange={set('nameEn')} />
            </label>
            <label className="field">
              <span>المجموعة *</span>
              <select className="input" value={form.categoryId} onChange={set('categoryId')} required>
                <option value="">— اختر —</option>
                {categoryRows.map((row) => (
                  <option key={row.id} value={row.id}>{`${row.code} — ${arabicName(row)}`}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>وحدة القياس *</span>
              <select
                className="input"
                value={form.baseUnitId}
                onChange={set('baseUnitId')}
                required
                disabled={Boolean(editing)}
              >
                <option value="">— اختر —</option>
                {unitRows.map((row) => (
                  <option key={row.id} value={row.id}>{`${row.code} — ${arabicName(row)}`}</option>
                ))}
              </select>
              {editing && <span className="muted small">وحدة القياس الأساسية ثابتة بعد إنشاء المادة.</span>}
            </label>
            <label className="field">
              <span>النوع</span>
              <select className="input" value={form.kind} onChange={set('kind')}>
                <option value="stock">مخزنية</option>
                <option value="service">خدمة</option>
                <option value="composite">مركبة</option>
              </select>
            </label>
            <label className="field">
              <span>سعر البيع</span>
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={form.salePrice}
                onChange={set('salePrice')}
              />
            </label>
            <label className="field">
              <span>سعر الشراء</span>
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={form.purchasePrice}
                onChange={set('purchasePrice')}
              />
            </label>
            <label className="field">
              <span>حد الطلب (أدنى رصيد)</span>
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={form.minQty}
                onChange={set('minQty')}
                placeholder="0"
              />
            </label>
            <label className="field">
              <span>الحد الأقصى</span>
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={form.maxQty}
                onChange={set('maxQty')}
                placeholder="—"
              />
            </label>
            <label className="field">
              <span>تتبع بدفعات / تواريخ صلاحية</span>
              <select
                className="input"
                value={form.trackLot ? 'yes' : 'no'}
                onChange={(event) =>
                  setForm((current) => ({ ...current, trackLot: event.target.value === 'yes' }))
                }
              >
                <option value="no">لا</option>
                <option value="yes">نعم</option>
              </select>
            </label>
            <label className="field">
              <span>تتبع بأرقام تسلسلية</span>
              <select
                className="input"
                value={form.trackSerial ? 'yes' : 'no'}
                onChange={(event) =>
                  setForm((current) => ({ ...current, trackSerial: event.target.value === 'yes' }))
                }
              >
                <option value="no">لا</option>
                <option value="yes">نعم</option>
              </select>
            </label>
            <label className="field">
              <span>المجموعة الضريبية</span>
              <select className="input" value={form.taxGroupId} onChange={set('taxGroupId')}>
                <option value="">— بدون —</option>
                {(taxGroups.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {arabicName(row)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Notice notice={notice} />
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || (missingRefs && !editing)}>
              {busy ? 'جارٍ الحفظ…' : editing ? 'حفظ التعديل' : 'حفظ المادة'}
            </button>
            {editing && (
              <button className="btn" type="button" onClick={cancelEdit} disabled={busy}>
                إلغاء التعديل
              </button>
            )}
          </div>
        </form>
      )}

      <StatTiles>
        <StatTile label="عدد المواد" value={rows.length} hint="بطاقة صنف مسجّلة" tone="brand" />
        <StatTile
          label="مواد مخزنية"
          value={rows.filter((row) => (row.kind ?? 'stock') === 'stock').length}
          hint="تُدار أرصدتها"
        />
        <StatTile
          label="خدمات"
          value={rows.filter((row) => row.kind === 'service').length}
          hint="بلا مخزون"
        />
        <StatTile
          label="أصناف مركبة"
          value={rows.filter((row) => row.kind === 'composite').length}
          hint="لها مكونات"
          tone={rows.some((row) => row.kind === 'composite') ? 'warn' : 'default'}
        />
        <StatTile
          label="بدون باركود"
          value={rows.filter((row) => !row.barcode).length}
          hint="لن تُقرأ بالقارئ"
          tone={rows.filter((row) => !row.barcode).length > 0 ? 'warn' : 'ok'}
        />
      </StatTiles>

      <FilterBar
        actions={<span className="small muted">{applied ? `نتيجة البحث عن «${applied}»` : `${rows.length} مادة`}</span>}
      >
        <label className="field">
          <span>بحث</span>
          <input
            className="input"
            placeholder="بحث بالاسم العربي…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setApplied(search.trim());
            }}
          />
        </label>
        <button className="btn" type="button" onClick={() => setApplied(search.trim())}>
          بحث
        </button>
        {applied && (
          <button
            className="btn"
            type="button"
            onClick={() => {
              setSearch('');
              setApplied('');
            }}
          >
            إلغاء الفلتر
          </button>
        )}
      </FilterBar>

      {!open && notice && <Notice notice={notice} />}

      <div className="split">
        <div className="card tight split-list">
          <QueryView query={items} empty="لا توجد مواد" emptyDetail="ابدأ بإضافة بطاقة مادة جديدة.">
            {() => (
              <>
                {rows.length === 0 ? (
                  <p className="muted" style={{ padding: 12 }}>لا مواد مطابقة.</p>
                ) : (
                  rows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className={`list-row${row.id === selectedId ? ' active' : ''}`}
                      onClick={() => setSelectedId(row.id)}
                    >
                      <span className="list-title">{arabicName(row)}</span>
                      <span className="list-sub" dir="ltr">{`${row.sku}${row.barcode ? ` · ${row.barcode}` : ''}`}</span>
                      <span className="row" style={{ justifyContent: 'space-between' }}>
                        <span className="badge">
                          {row.kind === 'service' ? 'خدمة' : row.kind === 'composite' ? 'مركبة' : 'مخزنية'}
                        </span>
                        <span className="list-sub" dir="ltr">{money(row.salePrice ?? row.sale_price)}</span>
                      </span>
                    </button>
                  ))
                )}
              </>
            )}
          </QueryView>
        </div>

        <div className="card">
          {!selected ? (
            <p className="muted">اختر مادة من القائمة لعرض بطاقتها بتبويباتها.</p>
          ) : (
            <>
              <div className="section-title">
                <h2>{arabicName(selected)}</h2>
                <span className="badge">
                  {selected.kind === 'service' ? 'خدمة' : selected.kind === 'composite' ? 'مركبة' : 'مخزنية'}
                </span>
              </div>

              <Tabs items={CARD_TABS} value={tab} onChange={setTab} />

              {tab === 'general' && (
                <>
                  <DocHead>
                    <DocField label="الرمز">
                      <span dir="ltr">{selected.sku}</span>
                    </DocField>
                    <DocField label="الباركود">
                      <span dir="ltr">{selected.barcode ?? '—'}</span>
                    </DocField>
                    <DocField label="الاسم">{arabicName(selected)}</DocField>
                    <DocField label="الاسم الإنجليزي">{selected.nameEn ?? '—'}</DocField>
                    <DocField label="المجموعة">
                      {arabicName(
                        categories.data?.find((row) => row.id === (selected.categoryId ?? selected.category_id)) ?? {},
                      )}
                    </DocField>
                    <DocField label="الوحدة الأساسية">
                      {arabicName(units.data?.find((row) => row.id === (selected.baseUnitId ?? selected.base_unit_id)) ?? {})}
                    </DocField>
                    <DocField label="سعر البيع">
                      <span dir="ltr">{money(selected.salePrice ?? selected.sale_price)}</span>
                    </DocField>
                    <DocField label="سعر الشراء">
                      <span dir="ltr">{money(selected.purchasePrice ?? selected.purchase_price)}</span>
                    </DocField>
                    <DocField label="حد الطلب">
                      <span dir="ltr">{quantity(selected.minQty ?? selected.min_qty)}</span>
                    </DocField>
                    <DocField label="الحد الأعلى">
                      <span dir="ltr">{quantity(selected.maxQty ?? selected.max_qty)}</span>
                    </DocField>
                    <DocField label="تتبع الدفعات">{selected.trackLot ?? selected.track_lot ? 'نعم' : 'لا'}</DocField>
                    <DocField label="تتبع الأرقام التسلسلية">
                      {selected.trackSerial ?? selected.track_serial ? 'نعم' : 'لا'}
                    </DocField>
                  </DocHead>

                  {customValues.length > 0 && (
                    <section className="card tight" style={{ marginTop: 16 }}>
                      <div className="section-title"><h3>الحقول الإضافية</h3><span className="muted small">قيم typed خاصة بهذا الصنف</span></div>
                      <div className="form-grid">
                        {customValues.map((field) => (
                          <label className="field" key={field.id}>
                            <span>{field.label}{field.required ? ' *' : ''}</span>
                            {field.type === 'select' ? <select className="input" value={String(customDraft[field.key] ?? '')} onChange={(event) => setCustomDraft((current) => ({ ...current, [field.key]: event.target.value }))}><option value="">— اختر —</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select> : field.type === 'boolean' ? <input type="checkbox" checked={Boolean(customDraft[field.key])} onChange={(event) => setCustomDraft((current) => ({ ...current, [field.key]: event.target.checked }))} /> : <input className="input" type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} value={String(customDraft[field.key] ?? '')} onChange={(event) => setCustomDraft((current) => ({ ...current, [field.key]: field.type === 'number' ? Number(event.target.value) : event.target.value }))} />}
                          </label>
                        ))}
                      </div>
                      {can('custom_fields.manage') ? <button className="btn primary no-print" type="button" disabled={customBusy} onClick={() => void saveCustomValues()}>{customBusy ? 'جارٍ الحفظ…' : 'حفظ الحقول الإضافية'}</button> : null}
                    </section>
                  )}

                  <Totals
                    items={[
                      { label: 'الرصيد الحالي', value: quantity(stockQty) },
                      { label: 'قيمة الرصيد', value: money(stockValue) },
                      { label: 'المستودعات', value: (cardLevels.data ?? []).length },
                    ]}
                  />

                  <div className="toolbar no-print">
                    {can('catalog.item.manage') && (
                      <>
                        <button className="btn" type="button" onClick={() => startEdit(selected)} disabled={busy}>
                          تعديل البطاقة
                        </button>
                        <button className="btn danger" type="button" onClick={() => void remove(selected)} disabled={busy}>
                          حذف
                        </button>
                      </>
                    )}
                    <button className="btn" type="button" onClick={() => window.print()}>
                      طباعة
                    </button>
                  </div>
                </>
              )}

              {tab === 'units' && (
                <QueryView query={cardUnits} empty="لا وحدات لهذه المادة" emptyDetail="أضف وحداتها من شاشة وحدات الصنف.">
                  {(unitRows) => (
                    <DataTable
                      rows={unitRows}
                      rowKey={(row) => `${row.itemId}:${row.unitId}`}
                      footer={[<>{`المجموع (${unitRows.length})`}</>, '', '', '', '']}
                      columns={[
                        { key: 'unit', header: 'الوحدة', cell: (row) => row.unitNameAr ?? row.unitCode ?? '—' },
                        {
                          key: 'ratio',
                          header: 'معامل التحويل',
                          align: 'num',
                          cell: (row) => (
                            <span dir="ltr">{`×${Number(row.ratio).toLocaleString('ar-EG')}`}</span>
                          ),
                        },
                        {
                          key: 'example',
                          header: 'مثال',
                          cell: (row) => (
                            <span dir="ltr">
                              {`1 ${row.unitNameAr ?? row.unitCode ?? ''} = ${Number(row.ratio).toLocaleString('ar-EG')} ${
                                arabicName(units.data?.find((unit) => unit.id === (selected.baseUnitId ?? selected.base_unit_id)) ?? {}) ||
                                'وحدة أساسية'
                              }`}
                            </span>
                          ),
                        },
                        { key: 'sale', header: 'سعر البيع', align: 'num', cell: (row) => money(row.salePrice) },
                        { key: 'barcode', header: 'الباركود', align: 'ltr', cell: (row) => row.barcode ?? '—' },
                      ]}
                    />
                  )}
                </QueryView>
              )}

              {tab === 'opening' && (
                <>
                  <p className="muted">
                    بضاعة أول المدة هي رصيد الافتتاح الذي يُقيَّد في حساب بضاعة أول المدة عند الترحيل. الرصيد الحالي
                    لهذه المادة مبيّن أدناه؛ سجّل الافتتاح بسند من نوع «بضاعة أول المدة».
                  </p>
                  <Totals
                    items={[
                      { label: 'الرصيد الحالي', value: quantity(stockQty) },
                      { label: 'قيمة الرصيد', value: money(stockValue) },
                      {
                        label: 'متوسط التكلفة',
                        value: stockQty > 0 ? money(stockValue / stockQty) : '—',
                      },
                    ]}
                  />
                  <div className="toolbar no-print">
                    <a className="btn primary" href="/inventory/vouchers?kind=opening">
                      سند بضاعة أول المدة
                    </a>
                    <a className="btn" href={`/inventory/item-card`}>
                      بطاقة الصنف (الحركات)
                    </a>
                  </div>
                </>
              )}

              {tab === 'components' && (
                <>
                  <p className="muted">
                    🔧 مكونات الصنف — ما يُصنع منه هذا الصنف، بالوحدة التي تُقاس بها كل كمية، والمستودع الذي
                    يُصرف منه. أمر إنتاج بلا مكوّنات يُملأ تلقائياً من هذا الجدول، مضروباً في الكمية المنتجة.
                  </p>

                  <QueryView
                    query={components}
                    empty="لا مكوّنات لهذا الصنف"
                    emptyDetail={
                      manage
                        ? 'أضف مكوّناً واحداً على الأقل ليتمكن أمر الإنتاج من تعبئة نفسه تلقائياً.'
                        : undefined
                    }
                  >
                    {() => (
                      <DataTable
                        rows={componentRows}
                        rowKey={(row) => row.componentItemId}
                        footer={[
                          <>المجموع ({componentRows.length})</>,
                          '',
                          quantity(componentRows.reduce((sum, row) => sum + Number(row.qty), 0)),
                          '',
                          '',
                          '',
                          ...(manage ? [''] : []),
                        ]}
                        columns={[
                          {
                            key: 'sku',
                            header: 'رمز الصنف',
                            cell: (row) => row.sku,
                          },
                          {
                            key: 'component',
                            header: 'الصنف',
                            cell: (row) => row.nameAr ?? '—',
                          },
                          {
                            key: 'qty',
                            header: 'الكمية',
                            align: 'num',
                            cell: (row) => quantity(row.qty),
                          },
                          {
                            key: 'unit',
                            header: 'الوحدة',
                            cell: (row) => (
                              <>
                                {row.unitNameAr ?? row.unitCode}
                                {row.unitId !== row.baseUnitId && (
                                  <span className="muted small"> (بوحدة تعبئة)</span>
                                )}
                              </>
                            ),
                          },
                          {
                            key: 'warehouse',
                            header: 'المستودع',
                            cell: (row) => row.warehouseName ?? '—',
                          },
                          {
                            key: 'added',
                            header: 'مادة مضافة',
                            cell: (row) => (row.kind === 'additive' ? 'نعم' : 'لا'),
                          },
                          ...(manage
                            ? [
                                {
                                  key: 'actions',
                                  header: '',
                                  cell: (row: ItemComponent) => (
                                    <button
                                      className="btn sm danger"
                                      type="button"
                                      disabled={componentBusy}
                                      onClick={() => void dropComponent(row)}
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
                    <form className="form-grid" onSubmit={saveComponent}>
                      <label className="field">
                        <span>الصنف *</span>
                        <select
                          className="input"
                          value={componentDraft.componentItemId}
                          onChange={(event) =>
                            setComponentDraft({
                              ...componentDraft,
                              componentItemId: event.target.value,
                              unitId: '',
                            })
                          }
                          required
                        >
                          <option value="">— اختر —</option>
                          {rows
                            .filter((row) => row.id !== selected?.id)
                            .map((row) => (
                              <option key={row.id} value={row.id}>
                                {`${row.sku} — ${arabicName(row)}`}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>الكمية *</span>
                        <input
                          className="input"
                          inputMode="decimal"
                          dir="ltr"
                          value={componentDraft.qty}
                          onChange={(event) => setComponentDraft({ ...componentDraft, qty: event.target.value })}
                          required
                        />
                      </label>
                      <label className="field">
                        <span>الوحدة</span>
                        <select
                          className="input"
                          value={componentDraft.unitId}
                          onChange={(event) => setComponentDraft({ ...componentDraft, unitId: event.target.value })}
                        >
                          <option value="">الوحدة الأساسية</option>
                          {(componentUnits.data ?? []).map((row) => (
                            <option key={row.unitId} value={row.unitId}>
                              {`${row.unitNameAr ?? row.unitCode} (×${Number(row.ratio).toLocaleString('ar-EG')})`}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>المستودع</span>
                        <select
                          className="input"
                          value={componentDraft.warehouseId}
                          onChange={(event) =>
                            setComponentDraft({ ...componentDraft, warehouseId: event.target.value })
                          }
                        >
                          <option value="">— غير محدد —</option>
                          {(warehouseRows.data ?? []).map((row) => (
                            <option key={row.id} value={row.id}>
                              {arabicName(row)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>مادة مضافة</span>
                        <select
                          className="input"
                          value={componentDraft.kind}
                          onChange={(event) => setComponentDraft({ ...componentDraft, kind: event.target.value })}
                        >
                          <option value="component">لا</option>
                          <option value="additive">نعم</option>
                        </select>
                      </label>
                      <div className="row">
                        <button
                          className="btn primary"
                          type="submit"
                          disabled={componentBusy || !componentDraft.componentItemId}
                        >
                          {componentBusy ? 'جارٍ الحفظ…' : 'حفظ المكوّن'}
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}
