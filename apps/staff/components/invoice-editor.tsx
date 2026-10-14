'use client';

import { calculateInvoiceTotals, type InvoiceTotals } from '@erp/contracts';

import { arabicName, itemLabel, money, type CostCenter, type Item, type TaxGroup, type Unit } from '../lib/lookups';

/**
 * The line grid shared by the sales invoice, the purchase invoice and the POS ticket.
 *
 * Totals are computed with `calculateInvoiceTotals` from `@erp/contracts` — the very
 * function the API uses when it stores the invoice — so what the user reads before saving
 * is what the server persists, down to the last of the four decimals.
 */
export type LineDraft = {
  itemId: string;
  description: string;
  quantityText: string;
  unitPriceText: string;
  discountRateText: string;
  taxRateText: string;
  taxGroupId: string;
  /**
   * R8 — الأرقام التي يقرؤها المُدخِل من العبوة: «📁 رقم الدفعة» و«🔢 التسلسلي» (واحداً
   * واحداً، يفصلهما سطرٌ أو فاصلة). تُحفظ في المسودّة، ويُحسم معناها على الخادم عند
   * الترحيل — تُصرف القطعة في البيع وتعود في المرتجع.
   */
  batchNo: string;
  serialText: string;
  /**
   * R9 — 📊 مركز التكلفة على السطر (`Inv_Sub.ItemCostCenter`). الفراغ يعني «مركز رأس
   * الفاتورة» — تماماً كما في الديسكتوب: القائمة في الرأس تحكم، والسطر يستطيع أن يخالفها.
   */
  costCenterId: string;
};

export function emptyLine(taxRateText = '15'): LineDraft {
  return { itemId: '', description: '', quantityText: '1', unitPriceText: '', discountRateText: '', taxRateText, taxGroupId: '', batchNo: '', serialText: '', costCenterId: '' };
}

/** الأرقام التسلسلية المكتوبة في خانةٍ واحدة: واحدٌ في كل سطر أو مفصولةٌ بفاصلة. */
export function serialList(text: string): string[] {
  return [...new Set(text.split(/[\n,،;]+/).map((value) => value.trim()).filter(Boolean))];
}

const numeric = (value: string) => (value.trim() === '' || Number.isNaN(Number(value)) ? '0' : value.trim());

export function filledLines(lines: LineDraft[]): LineDraft[] {
  return lines.filter((line) => (line.itemId || line.description.trim()) && Number(line.quantityText) > 0);
}

export function computeTotals(lines: LineDraft[], options: { priceIncludesVat?: boolean; invoiceDiscount?: string } = {}): InvoiceTotals {
  return calculateInvoiceTotals({
    lines: filledLines(lines).map((line) => ({
      quantity: numeric(line.quantityText),
      unitPrice: numeric(line.unitPriceText),
      discountRate: numeric(line.discountRateText),
      discountAmount: '0',
      taxRate: numeric(line.taxRateText),
    })),
    priceIncludesVat: options.priceIncludesVat,
    invoiceDiscount: options.invoiceDiscount ? numeric(options.invoiceDiscount) : '0',
  });
}

/** Maps the draft grid onto the `lines` payload both invoice services accept. */
export function toApiLines(lines: LineDraft[]) {
  return filledLines(lines).map((line) => ({
    itemId: line.itemId || undefined,
    description: line.description.trim() || undefined,
    quantity: numeric(line.quantityText),
    unitPrice: numeric(line.unitPriceText),
    discountRate: numeric(line.discountRateText),
    taxRate: numeric(line.taxRateText),
    taxGroupId: line.taxGroupId || undefined,
    batchNo: line.batchNo.trim() || undefined,
    serialNos: serialList(line.serialText).length ? serialList(line.serialText) : undefined,
    costCenterId: line.costCenterId || undefined,
  }));
}

/** هل يحمل السطر أرقاماً فعلاً؟ (يُقرأ في «📄 الوثائق» وفي مطالبة الحذف) */
export function lineHasNumbers(line: LineDraft): boolean {
  return Boolean(line.batchNo.trim() || line.serialText.trim());
}

/**
 * أعمدة الشبكة بأسماء نافذة الديسكتوب `Form_WPF/frmInvSale.xaml`:
 * «📦 الصنف» L695 · «الوحدة» L759 · «الكمية» L769 · «السعر» L779 · «المجموع» L789 ·
 * «الخصم» L799 · «الضريبة» L811 · «الإجمالي» L821 · «الصافي» L831 — وعند الديسكتوب
 * «الإجمالي» هو الصافي بعد الخصم وقبل الضريبة، و«الصافي» هو الإجمالي مع الضريبة،
 * وهو نفسه ترتيب `calculateInvoiceTotals` في السحابة (`net` ثم `total`).
 *
 * المُدخَلان (`خصم %` و`ضريبة %`) يبقيان بنسبتهما: عمود الديسكتوب «الخصم» مبلغٌ
 * (`ItemDiscount` ب`StringFormat=N2`)، والسحابة تأخذ النسبة ثم تحسب مبلغ الخصم —
 * فيظهر المبلغ المحسوب في عمود «الخصم» المجاور تماماً كما يُطبع في الديسكتوب.
 */
export function InvoiceLines({
  lines,
  onChange,
  items,
  taxGroups,
  units = [],
  priceField = 'salePrice',
  withNumbers = false,
  costCenters = [],
}: {
  lines: LineDraft[];
  onChange: (next: LineDraft[]) => void;
  items: Item[];
  taxGroups: TaxGroup[];
  /** وحدات التنظيم لعمود «الوحدة»؛ تُترك فارغة فيظهر الشرطة. */
  units?: Unit[];
  /** Which catalogue price pre-fills a new line. */
  priceField?: 'salePrice' | 'purchasePrice';
  /**
   * «📁 رقم الدفعة» و«🔢 التسلسلي» — عمودان يظهران في نافذتَي البيع والشراء
   * (`frmInvSale.xaml` L876 و`frmItemSerialNo.xaml` L434–460 للأرقام التسلسلية
   * والدفعة). تذكرة نقطة البيع لا تعرضهما: الكاشير يمرّر الباركود، والأرقام تُكتب في
   * شاشة الفاتورة.
   */
  withNumbers?: boolean;
  /**
   * R9 — 📊 مراكز التكلفة: عند تمرير القائمة يظهر عمود «📊 مركز التكلفة» على السطر
   * (`Inv_Sub.ItemCostCenter`). والخيار الفارغ يعني «مركز رأس الفاتورة» لا «بلا مركز» —
   * وهي علاقة الميراث نفسها التي في الديسكتوب (L2432 ثم L2461).
   */
  costCenters?: CostCenter[];
}) {
  const totals = computeTotals(lines);
  const unitOf = (line: LineDraft): string => {
    const item = items.find((row) => row.id === line.itemId);
    const unitId = item?.baseUnitId ?? item?.base_unit_id;
    const unit = units.find((row) => row.id === unitId);
    return unit ? (unit.nameAr ?? unit.name_ar ?? unit.code) : '—';
  };

  /**
   * عدّاد صغير تحت خانة الأرقام: «٢/٢». الأرقام على الخادم تُقاس بالقطع
   * (`SERIAL_COUNT_MISMATCH`)، فالمستخدم يرى الحساب قبل أن يُرسل لا بعده.
   */
  function serialHint(line: LineDraft): string {
    const written = serialList(line.serialText).length;
    const pieces = Number(line.quantityText || '0');
    if (!written) return 'عدد الأرقام = عدد القطع';
    return written === pieces
      ? `${written} من ${pieces} ✓`
      : `${written} من ${pieces} — العدد لا يطابق الكمية`;
  }

  function update(index: number, patch: Partial<LineDraft>) {
    onChange(lines.map((line, position) => (position === index ? { ...line, ...patch } : line)));
  }

  function pickItem(index: number, itemId: string) {
    const item = items.find((row) => row.id === itemId);
    const catalogue = item ? ((priceField === 'salePrice' ? item.salePrice ?? item.sale_price : item.purchasePrice ?? item.purchase_price) ?? '') : '';
    const group = item?.taxGroupId ? taxGroups.find((row) => row.id === item.taxGroupId) : undefined;
    update(index, {
      itemId,
      unitPriceText: lines[index]?.unitPriceText || String(catalogue ?? ''),
      taxGroupId: group?.id ?? lines[index]?.taxGroupId ?? '',
      taxRateText: group ? String(Number(group.rate) * 100) : (lines[index]?.taxRateText ?? '15'),
    });
  }

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ minWidth: '14rem' }}>📦 الصنف</th>
              <th>الوحدة</th>
              <th>الكمية</th>
              <th>السعر</th>
              <th>خصم %</th>
              <th>ضريبة %</th>
              {withNumbers && <th>📁 رقم الدفعة</th>}
              {withNumbers && <th>🔢 التسلسلي</th>}
              {costCenters.length > 0 && <th>📊 مركز التكلفة</th>}
              <th>المجموع</th>
              <th>الخصم</th>
              <th>الإجمالي</th>
              <th>الضريبة</th>
              <th>الصافي</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const computed = totals.lines[filledLines(lines).indexOf(line)];
              return (
                <tr key={index}>
                  <td>
                    <select className="input" value={line.itemId} onChange={(event) => pickItem(index, event.target.value)}>
                      <option value="">— بند حر —</option>
                      {items.map((row) => (
                        <option key={row.id} value={row.id}>
                          {itemLabel(row)}
                        </option>
                      ))}
                    </select>
                    {!line.itemId && (
                      <input
                        className="input"
                        placeholder="وصف البند"
                        value={line.description}
                        onChange={(event) => update(index, { description: event.target.value })}
                      />
                    )}
                  </td>
                  <td>{unitOf(line)}</td>
                  <td>
                    <input className="input" dir="ltr" inputMode="decimal" value={line.quantityText} onChange={(event) => update(index, { quantityText: event.target.value })} />
                  </td>
                  <td>
                    <input className="input" dir="ltr" inputMode="decimal" value={line.unitPriceText} onChange={(event) => update(index, { unitPriceText: event.target.value })} />
                  </td>
                  <td>
                    <input className="input" dir="ltr" inputMode="decimal" value={line.discountRateText} onChange={(event) => update(index, { discountRateText: event.target.value })} />
                  </td>
                  <td>
                    <input className="input" dir="ltr" inputMode="decimal" value={line.taxRateText} onChange={(event) => update(index, { taxRateText: event.target.value })} />
                  </td>
                  {withNumbers && (
                    <td>
                      <input
                        className="input"
                        dir="ltr"
                        placeholder="رقم الدفعة"
                        value={line.batchNo}
                        onChange={(event) => update(index, { batchNo: event.target.value })}
                      />
                    </td>
                  )}
                  {withNumbers && (
                    <td>
                      <input
                        className="input"
                        dir="ltr"
                        placeholder="رقم في كل سطر"
                        value={line.serialText}
                        onChange={(event) => update(index, { serialText: event.target.value })}
                        title={serialHint(line)}
                      />
                      {serialList(line.serialText).length > 0 && (
                        <span className={serialList(line.serialText).length === Number(line.quantityText || '0') ? 'badge ready' : 'badge draft'}>
                          {serialHint(line)}
                        </span>
                      )}
                    </td>
                  )}
                  {costCenters.length > 0 && (
                    <td>
                      <select
                        className="input"
                        value={line.costCenterId}
                        onChange={(event) => update(index, { costCenterId: event.target.value })}
                        title="اتركه فارغاً ليأخذ مركز رأس الفاتورة"
                      >
                        <option value="">— مركز الفاتورة —</option>
                        {costCenters.map((center) => (
                          <option key={center.id} value={center.id}>
                            {center.code} — {arabicName(center)}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  {/* ترتيب أعمدة الديسكتوب: المجموع · الخصم · الإجمالي · الضريبة · الصافي */}
                  <td className="num">{computed ? money(computed.gross) : '—'}</td>
                  <td className="num">{computed ? money(Number(computed.discount) + Number(computed.headerDiscountShare)) : '—'}</td>
                  <td className="num">{computed ? money(computed.net) : '—'}</td>
                  <td className="num">{computed ? money(computed.tax) : '—'}</td>
                  <td className="num">{computed ? money(computed.total) : '—'}</td>
                  <td>
                    <button className="btn sm" type="button" onClick={() => onChange(lines.filter((_, position) => position !== index))}>
                      حذف
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button className="btn sm" type="button" onClick={() => onChange([...lines, emptyLine()])}>
        + سطر
      </button>
    </>
  );
}

/**
 * صفوف الإجماليات كما في نافذة الديسكتوب:
 * «📊 المجموع:» L942 · «🔻 الخصم:» L948 · «💵 الإجمالي:» L955 · «🧾 الضريبة:» L961 ·
 * «✅ الصافي:» L967 (`frmInvSale.xaml`)، ومعانيها من `frmInvSale.xaml.cs` L1420–1432:
 * المجموع = `Invoic.SumPrice` (مجموع إجمالي السطور)، الخصم = خصم السطور + خصم الرأس،
 * الإجمالي = الصافي قبل الضريبة، الصافي = الإجمالي بعد الضريبة.
 * ونافذة المشتريات `frmInvPurch.xaml` L1056–1101 تكرر الصفوف الخمسة بالكلمات نفسها بلا رموز.
 */
const TOTALS_LABELS = {
  sales: {
    sum: '📊 المجموع:',
    discount: '🔻 الخصم:',
    net: '💵 الإجمالي:',
    tax: '🧾 الضريبة:',
    total: '✅ الصافي:',
  },
  purchase: {
    sum: 'المجموع :',
    discount: 'الخصم :',
    net: 'الإجمالي :',
    tax: 'الضريبة :',
    total: 'الصافي :',
  },
} as const;

export function TotalsPanel({
  totals,
  currency = 'SAR',
  variant = 'sales',
}: {
  totals: InvoiceTotals;
  currency?: string;
  /** نافذة المبيعات أو نافذة المشتريات — نفس الصفوف بكلمات كل نافذة. */
  variant?: 'sales' | 'purchase';
}) {
  const labels = TOTALS_LABELS[variant];
  const grossSum = totals.lines.reduce((sum, line) => sum + Number(line.gross), 0);
  const discountSum = totals.lines.reduce((sum, line) => sum + Number(line.discount) + Number(line.headerDiscountShare), 0);
  return (
    <dl className="kv">
      <dt>{labels.sum}</dt>
      <dd>{money(grossSum, currency)}</dd>
      <dt>{labels.discount}</dt>
      <dd>{money(discountSum, currency)}</dd>
      <dt>{labels.net}</dt>
      <dd>{money(totals.subtotal, currency)}</dd>
      <dt>{labels.tax}</dt>
      <dd>{money(totals.tax, currency)}</dd>
      <dt>{labels.total}</dt>
      <dd>
        <strong>{money(totals.total, currency)}</strong>
      </dd>
    </dl>
  );
}
