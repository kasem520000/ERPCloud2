import { sql, type SQL } from 'drizzle-orm';

/**
 * Report catalog — one definition per screen in the desktop product's report menus.
 *
 * A definition carries everything a client needs to render the report without knowing
 * anything about it: which filters to offer, which columns to draw, how to format each
 * column and which columns to total. The admin app therefore ships **one** report screen
 * instead of forty hand-written ones, and adding a report here makes it appear there.
 */
/**
 * 🔢 الرقم التسلسلي — `frmRptSerialNo.xaml` L<filter> is a free box the clerk types a
 * number into (`@ItemSerialNo`), so it needs a plain text input rather than a lookup.
 */
export type ReportParamKind =
  | 'date'
  | 'time'
  | 'branch'
  | 'warehouse'
  | 'party'
  | 'item'
  | 'category'
  | 'salesman'
  | 'costCenter'
  | 'account'
  | 'select'
  | 'serial'
  | 'entryNo'
  | 'docNo'
  | 'cashLocation'
  | 'vesselGroup'
  | 'year';

export type ReportParam = {
  name: string;
  labelAr: string;
  kind: ReportParamKind;
  options?: Array<{ value: string; labelAr: string }>;
};

export type ReportColumnType = 'text' | 'money' | 'qty' | 'int' | 'date' | 'percent';

/**
 * A column the report **computes** but never shows — the signed twin of a money column,
 * whose only purpose is the one number under the grid. `Form_WPF/frmRptSalesInPeriod`
 * prints «💰 إجمالي المبيعات:» as `المبيعات − المردودات`, while every row of its grid is
 * positive: the hidden column carries the sign, and `grandTotal` sums it.
 */
export type ReportColumn = { key: string; labelAr: string; type: ReportColumnType; hidden?: boolean };

/** One summary card under the grid: the column it sums and the label it prints. */
export type ReportGrandTotal = { key: string; labelAr: string };

export type ReportGroup = 'sales' | 'purchases' | 'inventory' | 'accounting' | 'pos' | 'hrm' | 'projects' | 'marina' | 'zatca';

export type ReportFilters = {
  from?: string;
  to?: string;
  /** ⏰ الوقت (HH:mm:ss) — `frmRptSalesInPeriod` builds a datetime from a date box + a time box. */
  fromTime?: string;
  toTime?: string;
  /** 🧾 نوع الفاتورة — «مبيعات نقطة البيع» · «مبيعات عادية» · «مبيعات» (`cmbInvType`). */
  invType?: string;
  /** 🔄 نوع العملية — «مبيعات» · «مرتجع» (`proc_type` 1 · 2). */
  procType?: string;
  /** 💵 حالة الدفع — «مدفوع» · «غير مدفوع» · «مدفوع جزئي» (`PaymentStatus` 1 · 0 · 2). */
  paymentStatus?: string;
  /** 💳 نوع الدفع — «نقدية» · «آجلة» · «شبكة» · «بنك» (`pay_type` 1 · −1 · 2). */
  payType?: string;
  /** 🧾 الضريبة — «مع ضريبة» · «بدون ضريبة». */
  vat?: string;
  /** 📄 نوع الإشعار — «إشعار دائن» · «إشعار مدين» (`inv_type` 21 · 22). */
  notificationType?: string;
  /** 📋 نوع التقرير — البعد الذي يُجمَّع عليه «تحليل المبيعات». */
  dimension?: string;
  branchId?: string;
  warehouseId?: string;
  partyId?: string;
  itemId?: string;
  categoryId?: string;
  salesmanId?: string;
  costCenterId?: string;
  status?: string;
  kind?: string;
  /** 🔢 الرقم التسلسلي — the free text box of `frmRptSerialNo` / `frmRptSerialNoSummary`. */
  serial?: string;
  /**
   * 📊 الحساب / الحساب الرئيسي — `cmbAccounts` of `frmRptBalances` («الحساب الرئيسي») and
   * `frmRptCostCenter` («الحساب»). Both are trees: a row belongs to the report when the
   * selected account is one of its ancestors.
   */
  accountId?: string;
  /** 🔢 رقم القيد · 📄 رقم المستند — the two free boxes of `frmRptEntries` («🔍 البحث»). */
  entryNo?: string;
  docNo?: string;
  /** 📆 ربع سنة · شهري — the two period presets of `frmTaxRptPeriod` overwrite the date boxes. */
  quarter?: string;
  month?: string;
  /** 🏦 الصندوق — `cmbSafe` of `frmRptKhzna` (`SELECT id, name FROM Stocks WHERE branch=…`). */
  cashLocationId?: string;
  /** 📅 السنة — `txtYear` of `frmRptSalary`; it only filters together with الشهر. */
  year?: string;
  /** 📁 الفئة — `cmbGroups` of `frmRptRentInvoices` (`GroupMarine`). */
  groupId?: string;
  /**
   * 📄 نوع العملية — `cmbOperation` of `frmRptInventory.xaml.cs` L260-267: eight inventory
   * documents the desktop keeps in one `Inv.inv_type` column (`8/2`, `8/1`, `9/1`, `4/1`,
   * `5/1`, `6/1`, `14/1`, `7/1`). The cloud splits them into real document tables, so the
   * report reads the movement ledger's `doc_type` instead.
   */
  docType?: string;
  /**
   * 🏷️ نوع الحساب — «👤 عملاء» · «🏭 موردين» · «🔵 الكل» (`frmCustAccountGet` L355-L365,
   * whose `Customers.type` is 1 عميل · 2 مورد · 3 كلاهما).
   */
  partyKind?: string;
};

export type ReportDefinition = {
  key: string;
  titleAr: string;
  group: ReportGroup;
  /** One line explaining what the numbers mean — shown under the report title. */
  hintAr?: string;
  params: ReportParam[];
  columns: ReportColumn[];
  /** Column keys that get a grand total in the footer. */
  totals?: string[];
  /**
   * 💰 The number(s) under the grid — the summary cards of the `frmRpt*` windows:
   * «💵 إجمالي صافي البيع» و«📦 إجمالي الكميات» in `frmRptItemsSalesDetails`,
   * «💵 إجمالي صافي البيع» و«💰 إجمالي الربح» in `frmRptItemsProfit`. Summed from the
   * rows, so they always agree with what is on screen, and each may point at a hidden
   * signed column.
   */
  grandTotal?: ReportGrandTotal | ReportGrandTotal[];
  /** What an empty report says — `frmRptSalesInPeriod` says «لا توجد عمليات بالجدول». */
  emptyAr?: string;
  /** «أعده · راجعه · المدير» — the signature strip of `RptSalesInPeriod1/2.repx`. */
  signature?: boolean;
  chart?: 'bar' | 'line';
  build: (tenantId: string, filters: ReportFilters) => SQL;
};

const PERIOD: ReportParam[] = [
  { name: 'from', labelAr: 'من تاريخ', kind: 'date' },
  { name: 'to', labelAr: 'إلى تاريخ', kind: 'date' },
];
/** ⏰ الوقت (HH:mm:ss) — `frmRptSalesInPeriod.xaml` L235 وL246, next to each date box. */
const TIME: ReportParam[] = [
  { name: 'fromTime', labelAr: 'الوقت (HH:mm:ss)', kind: 'time' },
  { name: 'toTime', labelAr: 'الوقت (HH:mm:ss)', kind: 'time' },
];
/**
 * 🧾 نوع الفاتورة — `cmbInvType` L210: «مبيعات نقطة البيع» (index 0) و«مبيعات عادية»
 * (index 1). The desktop reads them as `inv.inv_type = 3` / `= 2`; here a فاتورة نقطة
 * البيع is the cash sale with no عميل (`party_id IS NULL`), which is what every other
 * POS report in this catalogue already reads.
 */
const INVOICE_KIND: ReportParam = {
  name: 'invType',
  labelAr: 'نوع الفاتورة',
  kind: 'select',
  options: [
    { value: 'pos', labelAr: 'مبيعات نقطة البيع' },
    { value: 'sale', labelAr: 'مبيعات عادية' },
  ],
};
/**
 * 🧾 نوع الفاتورة — `frmRptSalesByCategory.xaml.cs` L80 وL81 fill the combo with
 * «مبيعات» (`inv.inv_type = 2`) و«نقطة بيع» (`inv.inv_type = 3`).
 */
const INVOICE_KIND_SALES: ReportParam = {
  name: 'invType',
  labelAr: 'نوع الفاتورة',
  kind: 'select',
  options: [
    { value: 'sale', labelAr: 'مبيعات' },
    { value: 'pos', labelAr: 'نقطة بيع' },
  ],
};
/** 🧾 `frmRptCategorySaleByDay.xaml` L25 وL26 — «فاتورة مبيعات» · «فاتورة نقطة بيع». */
const INVOICE_KIND_DOCS: ReportParam = {
  name: 'invType',
  labelAr: 'نوع الفاتورة',
  kind: 'select',
  options: [
    { value: 'sale', labelAr: 'فاتورة مبيعات' },
    { value: 'pos', labelAr: 'فاتورة نقطة بيع' },
  ],
};
/** ⏰ «وقت البدء (HH:mm)» / «وقت الانتهاء (HH:mm)» — `frmRptItemsSalesDetails.xaml` L397 وL413. */
const TIME_START_END: ReportParam[] = [
  { name: 'fromTime', labelAr: 'وقت البدء (HH:mm)', kind: 'time' },
  { name: 'toTime', labelAr: 'وقت الانتهاء (HH:mm)', kind: 'time' },
];
/** ⏰ «من وقت (HH:mm)» / «إلى وقت (HH:mm)» — `frmRptItemsProfitDetails.xaml` L340 وL356. */
const TIME_FROM_TO: ReportParam[] = [
  { name: 'fromTime', labelAr: 'من وقت (HH:mm)', kind: 'time' },
  { name: 'toTime', labelAr: 'إلى وقت (HH:mm)', kind: 'time' },
];
/**
 * 🔄 نوع العملية — the ثلاثة أزرار `rbAllSales` · `rbSales` · `rbReturn` in every
 * invoice window: `proc_type` 1 (مبيعات) و2 (مرتجع).
 */
const OPERATION_KIND: ReportParam = {
  name: 'procType',
  labelAr: 'نوع العملية',
  kind: 'select',
  options: [
    { value: 'sale', labelAr: 'مبيعات' },
    { value: 'return', labelAr: 'مرتجع' },
  ],
};
/** 💵 حالة الدفع — `PaymentStatus` 1 مدفوع · 0 غير مدفوع · 2 مدفوع جزئي. */
const PAYMENT_STATE: ReportParam = {
  name: 'paymentStatus',
  labelAr: 'حالة الدفع',
  kind: 'select',
  options: [
    { value: 'paid', labelAr: 'مدفوع' },
    { value: 'unpaid', labelAr: 'غير مدفوع' },
    { value: 'partial', labelAr: 'مدفوع جزئي' },
  ],
};
/** 💳 نوع الدفع — «نقدية · آجلة · شبكة · بنك»: `pay_type` 1 · −1 · 2 · 2+bank. */
const PAY_METHOD: ReportParam = {
  name: 'payType',
  labelAr: 'نوع الدفع',
  kind: 'select',
  options: [
    { value: 'cash', labelAr: 'نقدية' },
    { value: 'credit', labelAr: 'آجلة' },
    { value: 'card', labelAr: 'شبكة' },
    { value: 'bank', labelAr: 'بنك' },
  ],
};
/** 🧾 الضريبة — `rbAllVat` · `rbWithVat` · `rbNoVAT`. */
const VAT_FILTER: ReportParam = {
  name: 'vat',
  labelAr: 'الضريبة',
  kind: 'select',
  options: [
    { value: 'with', labelAr: 'مع ضريبة' },
    { value: 'without', labelAr: 'بدون ضريبة' },
  ],
};
/** 📄 نوع الإشعار — `frmRptInvNotfic.xaml.cs` L237 وL239: `inv_type` 21 و22. */
const NOTIFICATION_KIND: ReportParam = {
  name: 'notificationType',
  labelAr: 'نوع الإشعار',
  kind: 'select',
  options: [
    { value: 'credit', labelAr: 'إشعار دائن' },
    { value: 'debit', labelAr: 'إشعار مدين' },
  ],
};
/**
 * 📋 نوع التقرير — the eight radios of `frmRptInvAnalysis.xaml` L254 … L300: المخزن ·
 * العميل · الصنف · مندوب البيع · المستخدم · الأيام · الشهور · مجموعة الصنف.
 */
const ANALYSIS_DIMENSION: ReportParam = {
  name: 'dimension',
  labelAr: 'نوع التقرير',
  kind: 'select',
  options: [
    { value: 'warehouse', labelAr: 'المخزن' },
    { value: 'customer', labelAr: 'العميل' },
    { value: 'item', labelAr: 'الصنف' },
    { value: 'salesman', labelAr: 'مندوب البيع' },
    { value: 'user', labelAr: 'المستخدم' },
    { value: 'day', labelAr: 'الأيام' },
    { value: 'month', labelAr: 'الشهور' },
    { value: 'category', labelAr: 'مجموعة الصنف' },
  ],
};
const BRANCH: ReportParam = { name: 'branchId', labelAr: 'الفرع', kind: 'branch' };
const WAREHOUSE: ReportParam = { name: 'warehouseId', labelAr: 'المستودع', kind: 'warehouse' };
const PARTY: ReportParam = { name: 'partyId', labelAr: 'الطرف', kind: 'party' };
const ITEM: ReportParam = { name: 'itemId', labelAr: 'الصنف', kind: 'item' };
const CATEGORY: ReportParam = { name: 'categoryId', labelAr: 'المجموعة', kind: 'category' };
const SALESMAN: ReportParam = { name: 'salesmanId', labelAr: 'المندوب', kind: 'salesman' };
const COST_CENTER: ReportParam = { name: 'costCenterId', labelAr: 'مركز التكلفة', kind: 'costCenter' };

/**
 * 🔄 حالة المزامنة ZATCA — the three radios of `frmInvsSyncStatusZatca.xaml` (L470-L478):
 * 🔵 الكل · ✅ مرسل · ❌ غير مرسل, read off `Inv.ZatcaSent` (`BuildWhereClause` L900-L904).
 */
const SYNC_STATE: ReportParam = {
  name: 'status',
  labelAr: 'حالة المزامنة ZATCA',
  kind: 'select',
  options: [
    { value: 'sent', labelAr: '✅ مرسل' },
    { value: 'unsent', labelAr: '❌ غير مرسل' },
  ],
};
/**
 * 📋 نوع الفاتورة — `cmbInvType` of the same window (`LoadInvTypes` L87-L105). The five
 * items are «مبيعات» · «نقطة بيع» · «إشعار» · «مقاولات» · «أندرويد», and the desktop
 * translates the selected index into `inv.inv_type` 2 · 3 · 21 · 20 — with «أندرويد»
 * (index 4) falling through the `switch` to **no condition at all** (L913-L920), which is
 * why the window shows every invoice when it is picked. Kept as-is, quirk included.
 */
const ZATCA_INVOICE_KIND: ReportParam = {
  name: 'kind',
  labelAr: 'نوع الفاتورة',
  kind: 'select',
  options: [
    { value: 'sale', labelAr: 'مبيعات' },
    { value: 'pos', labelAr: 'نقطة بيع' },
    { value: 'notice', labelAr: 'إشعار' },
    { value: 'contracting', labelAr: 'مقاولات' },
    { value: 'android', labelAr: 'أندرويد' },
  ],
};
/** 📅 الفترة الزمنية — «من» و«إلى» beside the 📌 كل الفترة check box (L510-L520). */
const ZATCA_PERIOD: ReportParam[] = [
  { name: 'from', labelAr: 'من', kind: 'date' },
  { name: 'to', labelAr: 'إلى', kind: 'date' },
];

const text = (key: string, labelAr: string): ReportColumn => ({ key, labelAr, type: 'text' });
const money = (key: string, labelAr: string): ReportColumn => ({ key, labelAr, type: 'money' });
const qty = (key: string, labelAr: string): ReportColumn => ({ key, labelAr, type: 'qty' });
const int = (key: string, labelAr: string): ReportColumn => ({ key, labelAr, type: 'int' });
const date = (key: string, labelAr: string): ReportColumn => ({ key, labelAr, type: 'date' });
const percent = (key: string, labelAr: string): ReportColumn => ({ key, labelAr, type: 'percent' });

/** `true` when the filter is absent, so every predicate can be `AND`-ed unconditionally. */
const all = sql`true`;
const onDate = (column: SQL, from?: string, to?: string): SQL =>
  sql`${from ? sql`${column} >= ${from}::date` : all} AND ${to ? sql`${column} <= ${to}::date` : all}`;

/**
 * 📅 التاريخ + ⏰ الوقت — `BuildDateTime` in `frmRptSalesInPeriod.xaml.cs` glues the date
 * box to the time box, defaulting to `00:00:00` at the start of the range and `23:59:59`
 * at its end. Reports that have no time box keep `onDate`.
 */
const onDateTime = (column: SQL, from?: string, to?: string, fromTime?: string, toTime?: string): SQL =>
  sql`${from ? sql`${column} >= ((${from}::date) + coalesce(${fromTime ?? null}::time, '00:00:00'::time))::timestamptz` : all}
  AND ${to ? sql`${column} <= ((${to}::date) + coalesce(${toTime ?? null}::time, '23:59:59'::time))::timestamptz` : all}`;

/**
 * 🧾 نوع الفاتورة — «مبيعات نقطة البيع» are the cash sales (`party_id IS NULL`);
 * «مبيعات عادية» are the ones with a عميل. No choice means both.
 */
/**
 * 🧾 POS or not — `inv_type=3` at the desktop. The cloud has no such column: a فاتورة
 * نقطة البيع is the cash sale with no عميل, which is what every other POS report here
 * already reads. `null` means "both".
 */
const posScope = (pos: boolean | null): SQL => (pos === null ? all : pos ? sql`si.party_id IS NULL` : sql`si.party_id IS NOT NULL`);

/**
 * 📦 The item-movement scope every تجميعي report shares: posted documents only —
 * `IS_Deleted=0` — and the filters of the 🔧 خيارات البحث panel.
 */
/**
 * The `opts` switches decide which of the 🔧 خيارات البحث boxes this window actually
 * owns — «أرباح المواد تفصيلي» has a مستودع box and a صنف box and neither a فرع nor a
 * مجموعة, so a shared scope has to be able to leave those two out.
 */
const movementLinesScope = (
  tenantId: string,
  f: ReportFilters,
  pos: boolean | null,
  opts: { invType?: boolean; branch?: boolean; category?: boolean } = {},
): SQL => sql`
  si.tenant_id = ${tenantId}
  AND si.status = 'posted'
  AND si.kind IN ('sale', 'sale_return')
  AND ${onDateTime(sql`si.posted_at`, f.from, f.to, f.fromTime, f.toTime)}
  AND ${posScope(pos)}
  AND ${opts.invType ? kindScope(f.invType) : all}
  AND ${opts.branch === false ? all : eqIf(sql`si.branch_id`, f.branchId)}
  AND ${eqIf(sql`si.warehouse_id`, f.warehouseId)}
  AND ${eqIf(sql`line.item_id`, f.itemId)}
  AND ${opts.category === false ? all : eqIf(sql`item.category_id`, f.categoryId)}
  AND ${eqIf(sql`si.party_id`, f.partyId)}
  AND ${eqIf(sql`si.salesman_id`, f.salesmanId)}
`;

/**
 * 🔄 نوع العملية — `proc_type` 1 (مبيعات) و2 (مرتجع) at the desktop, `kind` here: a بيع
 * adds to the 💰 ملخص and a مرتجع subtracts from it, which is also why the summary cards
 * read the signed columns rather than the ones on screen.
 */
const procScope = (saleKind: string, returnKind: string, procType?: string): SQL =>
  procType === 'sale'
    ? sql`si.kind = ${saleKind}`
    : procType === 'return'
      ? sql`si.kind = ${returnKind}`
      : sql`si.kind IN (${saleKind}, ${returnKind})`;
/** 💵 حالة الدفع — `inv.PaymentStatus` 1 · 0 · 2, and `payment_status` is spelled out. */
const paymentScope = (status?: string): SQL =>
  status === 'paid' || status === 'unpaid' || status === 'partial' ? sql`si.payment_status = ${status}` : all;
/** 💳 نوع الدفع — the four legs of `inv.pay_type`; «آجلة» is the فاتورة nothing was paid on. */
const payScope = (payType?: string): SQL =>
  payType === 'cash'
    ? sql`coalesce(pay.cash, 0) > 0`
    : payType === 'card'
      ? sql`coalesce(pay.card, 0) > 0`
      : payType === 'bank'
        ? sql`coalesce(pay.bank, 0) > 0`
        : payType === 'credit'
          ? sql`si.payment_status = 'unpaid'`
          : all;
/** 🧾 الضريبة — «مع ضريبة» و«بدون ضريبة» read the invoice's own tax, main and extra alike. */
const vatScope = (vat?: string, alias: SQL = sql`si`): SQL =>
  vat === 'with'
    ? sql`(${alias}.tax_total + ${alias}.extra_tax) > 0`
    : vat === 'without'
      ? sql`(${alias}.tax_total + ${alias}.extra_tax) = 0`
      : all;
/**
 * 💳 The three payment legs of one فاتورة — `inv.cash` · `inv.visa` · `inv.bank` at the
 * desktop, one row per method in `invoice_payments` here.
 */
const paymentLegs = sql`
  LEFT JOIN LATERAL (
    SELECT sum(CASE WHEN p.method = 'cash' THEN p.amount ELSE 0 END) AS cash,
           sum(CASE WHEN p.method = 'card' THEN p.amount ELSE 0 END) AS card,
           sum(CASE WHEN p.method = 'bank' THEN p.amount ELSE 0 END) AS bank
    FROM invoice_payments p
    WHERE p.tenant_id = si.tenant_id AND p.invoice_id = si.id
  ) pay ON true`;
/** «المجموع» — Σ(quantity × unit_price), the gross the خصم is measured against. */
const lineGross = sql`
  LEFT JOIN LATERAL (
    SELECT sum(l.quantity * l.unit_price) AS gross
    FROM sales_invoice_lines l
    WHERE l.tenant_id = si.tenant_id AND l.invoice_id = si.id
  ) lines ON true`;

/** 🧾 «المجموع» و«الخصم» … the one row of a فاتورة مبيعات, as every invoice window draws it. */
const invoiceSign = sql`(CASE WHEN si.kind IN ('sale', 'debit_note') THEN 1 ELSE -1 END)`;
const invoiceRow = sql`
  si.id::text AS movement_id,
  -- نوع الفاتورة — InvoiceOper.GetInvoiceTypeAr(inv_type, proc_type, pay_type, TaxType):
  -- TaxType is 2 when the عميل carries a رقم ضريبي and 1 when it does not.
  CASE si.kind
    WHEN 'sale' THEN CASE WHEN coalesce(party.tax_no, '') <> '' THEN 'فاتورة ضريبية' ELSE 'فاتورة ضريبية مبسطة' END
    WHEN 'sale_return' THEN CASE WHEN coalesce(party.tax_no, '') <> '' THEN 'إشعار دائن للفاتورة الضريبية' ELSE 'إشعار دائن للفاتورة الضريبية المبسطة' END
    WHEN 'credit_note' THEN 'إشعار دائن'
    WHEN 'debit_note' THEN 'إشعار مدين'
    ELSE si.kind END AS invoice_type,
  coalesce(si.number, '—') AS number,
  -- 🔗 رقم المرجع — inv.Reff_No at the desktop is a free-text box the cloud does
  -- not carry; what it does carry is the link itself (reference_invoice_id), so the
  -- number of the فاتورة this one refers to is what the column prints.
  coalesce((SELECT ref.number FROM sales_invoices ref WHERE ref.id = si.reference_invoice_id), '—') AS reference,
  si.posted_at::date AS day,
  to_char(si.posted_at, 'HH24:MI:SS') AS time,
  -- نوع الدفع — «آجل · نقدي · شبكة · متعدد · ضيافة» in GetPaymentText; ضيافة has no
  -- counterpart in the cloud's payments, so an unpaid فاتورة is «آجل» and a settled one
  -- is named after the leg that settled it, or «متعدد» when several did.
  CASE si.payment_status
    WHEN 'unpaid' THEN 'آجل'
    WHEN 'paid' THEN CASE
      WHEN coalesce(pay.cash, 0) > 0 AND coalesce(pay.card, 0) = 0 AND coalesce(pay.bank, 0) = 0 THEN 'نقدي'
      WHEN coalesce(pay.card, 0) > 0 AND coalesce(pay.cash, 0) = 0 AND coalesce(pay.bank, 0) = 0 THEN 'شبكة'
      ELSE 'متعدد' END
    ELSE 'متعدد' END AS payment_method,
  si.paid_total::text AS paid,
  coalesce(party.name, si.cash_customer_name, '—') AS customer,
  coalesce(pay.cash, 0)::text AS cash,
  coalesce(pay.card, 0)::text AS network,
  round(coalesce(lines.gross, 0), 2)::text AS sum_price,
  round(coalesce(lines.gross, 0) - si.subtotal, 2)::text AS discount,
  si.subtotal::text AS subtotal,
  si.tax_total::text AS tax,
  si.extra_tax::text AS extra_tax,
  (si.tax_total + si.extra_tax)::text AS total_tax,
  si.total::text AS net,
  coalesce(warehouse.name, '—') AS warehouse,
  coalesce(branch.name_ar, '—') AS branch,
  coalesce(salesman.name, '—') AS salesman,
  coalesce("user".full_name, '—') AS user_name,
  -- 📊 ملخص النتائج — the same ten numbers, signed: a مرتجع or an إشعار دائن subtracts.
  (${invoiceSign} * round(coalesce(lines.gross, 0), 2))::text AS s_sum_price,
  (${invoiceSign} * round(coalesce(lines.gross, 0) - si.subtotal, 2))::text AS s_discount,
  (${invoiceSign} * si.subtotal)::text AS s_subtotal,
  (${invoiceSign} * si.tax_total)::text AS s_tax,
  (${invoiceSign} * si.extra_tax)::text AS s_extra_tax,
  (${invoiceSign} * (si.tax_total + si.extra_tax))::text AS s_total_tax,
  (${invoiceSign} * si.total)::text AS s_net,
  (${invoiceSign} * coalesce(pay.cash, 0))::text AS s_cash,
  (${invoiceSign} * coalesce(pay.card, 0))::text AS s_network,
  (${invoiceSign} * si.paid_total)::text AS s_paid
`;

/** 🧾 The 21 columns of an invoice window — «📄 تفاصيل» و«👁️ عرض» and the four technical ones aside. */
const invoiceColumns = (typeLabel: string, numberLabel: string, dateLabel: string): ReportColumn[] => [
  text('invoice_type', typeLabel),
  text('number', numberLabel),
  text('reference', 'رقم المرجع'),
  date('day', dateLabel),
  text('time', 'الوقت'),
  text('payment_method', 'نوع الدفع'),
  money('paid', 'المدفوع'),
  text('customer', 'العميل'),
  money('cash', 'نقدي'),
  money('network', 'شبكة'),
  money('sum_price', 'المجموع'),
  money('discount', 'الخصم'),
  money('subtotal', 'الإجمالي'),
  money('tax', 'الضريبة'),
  money('extra_tax', 'ضريبة إضافية'),
  money('total_tax', 'إجمالي الضريبة'),
  money('net', 'الصافي'),
  text('warehouse', 'المستودع'),
  text('branch', 'الفرع'),
  text('salesman', 'المندوب'),
  text('user_name', 'المستخدم'),
  { key: 's_sum_price', labelAr: 'المجموع', type: 'money', hidden: true },
  { key: 's_discount', labelAr: 'الخصم', type: 'money', hidden: true },
  { key: 's_subtotal', labelAr: 'الإجمالي', type: 'money', hidden: true },
  { key: 's_tax', labelAr: 'الضريبة', type: 'money', hidden: true },
  { key: 's_extra_tax', labelAr: 'ضريبة إضافية', type: 'money', hidden: true },
  { key: 's_total_tax', labelAr: 'إجمالي الضريبة', type: 'money', hidden: true },
  { key: 's_net', labelAr: 'الصافي', type: 'money', hidden: true },
  { key: 's_cash', labelAr: 'نقدي', type: 'money', hidden: true },
  { key: 's_network', labelAr: 'شبكة', type: 'money', hidden: true },
  { key: 's_paid', labelAr: 'المدفوع', type: 'money', hidden: true },
];

/** 📊 ملخص النتائج — «المجموع · الخصم · الإجمالي · الضريبة · ضريبة إضافية · إجمالي الضريبة · الصافي · نقدي · شبكة» و«المدفوع» حيث يكون. */
const summaryCards = (withPaid: boolean): ReportGrandTotal[] => [
  { key: 's_sum_price', labelAr: 'المجموع' },
  { key: 's_discount', labelAr: 'الخصم' },
  { key: 's_subtotal', labelAr: 'الإجمالي' },
  { key: 's_tax', labelAr: 'الضريبة' },
  { key: 's_extra_tax', labelAr: 'ضريبة إضافية' },
  { key: 's_total_tax', labelAr: 'إجمالي الضريبة' },
  { key: 's_net', labelAr: 'الصافي' },
  { key: 's_cash', labelAr: 'نقدي' },
  { key: 's_network', labelAr: 'شبكة' },
  ...(withPaid ? [{ key: 's_paid', labelAr: 'المدفوع' } satisfies ReportGrandTotal] : []),
];

/** 📄 نوع الإشعار — `inv_type` 21 (مدين) و22 (دائن), `credit_note` و`debit_note` here. */
const notificationScope = (kind?: string): SQL =>
  kind === 'credit' ? sql`si.kind = 'credit_note'` : kind === 'debit' ? sql`si.kind = 'debit_note'` : all;

/**
 * 🔍 خيارات البحث of a فاتورة window — `showInvoice()` in `frmRptInvSalesDetails.xaml.cs`
 * L352 … L432, and the same ten boxes in the POS and الإشعارات windows.
 */
const invoiceScope = (
  tenantId: string,
  f: ReportFilters,
  pos: boolean | null,
  opts: { notifications?: boolean } = {},
): SQL => sql`
  si.tenant_id = ${tenantId}
  AND si.status = 'posted'
  AND si.kind IN ('sale', 'sale_return', 'credit_note', 'debit_note')
  AND ${onDateTime(sql`si.posted_at`, f.from, f.to, f.fromTime, f.toTime)}
  AND ${posScope(pos)}
  -- 📄 نوع الفاتورة — «مبيعات» (inv_type = 2) و«نقطة بيع» (inv_type = 3) in cmbInvType;
  -- the POS window hard-codes 3 already, so the box is its own.
  AND ${pos === null ? kindScope(f.invType) : all}
  AND ${opts.notifications ? sql`si.kind IN ('credit_note', 'debit_note')` : sql`si.kind IN ('sale', 'sale_return')`}
  AND ${opts.notifications ? notificationScope(f.notificationType) : procScope('sale', 'sale_return', f.procType)}
  AND ${eqIf(sql`si.branch_id`, f.branchId)}
  AND ${eqIf(sql`si.warehouse_id`, f.warehouseId)}
  AND ${eqIf(sql`si.party_id`, f.partyId)}
  AND ${eqIf(sql`si.salesman_id`, f.salesmanId)}
  AND ${paymentScope(f.paymentStatus)}
  AND ${payScope(f.payType)}
  AND ${vatScope(f.vat)}
`;

/** 📅 اسم اليوم بالعربية — `ToString("ddd", culture ar)` in the two «حسب اليوم» windows. */
const dayName = sql`
  CASE extract(dow FROM si.posted_at::date)::int
    WHEN 0 THEN 'الأحد' WHEN 1 THEN 'الاثنين' WHEN 2 THEN 'الثلاثاء'
    WHEN 3 THEN 'الأربعاء' WHEN 4 THEN 'الخميس' WHEN 5 THEN 'الجمعة'
    ELSE 'السبت' END`;

/** 🔄 `proc_type` 1 شراء و2 مردود شراء في `frmRptInvPurchaseDetails`. */
const purchaseProcScope = (procType?: string): SQL =>
  procType === 'sale' ? sql`pi.kind = 'purchase'` : procType === 'return' ? sql`pi.kind = 'purchase_return'` : all;
const purchaseSign = sql`(CASE WHEN pi.kind = 'purchase' THEN 1 ELSE -1 END)`;
const purchaseInvoiceScope = (tenantId: string, f: ReportFilters): SQL => sql`
  pi.tenant_id = ${tenantId}
  AND pi.status = 'posted'
  AND pi.kind IN ('purchase', 'purchase_return')
  AND ${onDateTime(sql`pi.posted_at`, f.from, f.to, f.fromTime, f.toTime)}
  AND ${eqIf(sql`pi.branch_id`, f.branchId)}
  AND ${eqIf(sql`pi.warehouse_id`, f.warehouseId)}
  AND ${eqIf(sql`pi.party_id`, f.partyId)}
  AND ${purchaseProcScope(f.procType)}
  AND ${vatScope(f.vat, sql`pi`)}
`;

/** 🏢 One arm of «تقرير الحركة اليومية» — `DoProcess(name, type1, type2)` in frmRptDailyProcess. */
const dailyScope = (tenantId: string, f: ReportFilters, kind: string, withParty: boolean): SQL => sql`
  si.tenant_id = ${tenantId}
  AND si.status = 'posted'
  AND si.kind = ${kind}
  AND ${onDateTime(sql`si.posted_at`, f.from, f.to, f.fromTime, f.toTime)}
  AND ${withParty ? sql`si.party_id IS NOT NULL` : sql`si.party_id IS NULL`}
  AND ${eqIf(sql`si.branch_id`, f.branchId)}
`;
const dailyPurchaseScope = (tenantId: string, f: ReportFilters, kind: string): SQL => sql`
  pi.tenant_id = ${tenantId}
  AND pi.status = 'posted'
  AND pi.kind = ${kind}
  AND ${onDateTime(sql`pi.posted_at`, f.from, f.to, f.fromTime, f.toTime)}
  AND ${eqIf(sql`pi.branch_id`, f.branchId)}
`;

/** 📋 نوع التقرير — the dimension every «تحليل المبيعات» row is grouped by. */
const analysisDimension = (dimension?: string): SQL =>
  dimension === 'customer'
    ? sql`coalesce(party.name, si.cash_customer_name, '—')`
    : dimension === 'item'
      ? sql`coalesce(item.name_ar, '—')`
      : dimension === 'salesman'
        ? sql`coalesce(salesman.name, '—')`
        : dimension === 'user'
          ? sql`coalesce("user".full_name, '—')`
          : dimension === 'day'
            ? sql`si.posted_at::date::text`
            : dimension === 'month'
              ? sql`to_char(si.posted_at, 'YYYY-MM')`
              : dimension === 'category'
                ? sql`coalesce(cat.name_ar, '—')`
                : sql`coalesce(warehouse.name, '—')`;

const purchaseLinesScope = (tenantId: string, f: ReportFilters): SQL => sql`
  pi.tenant_id = ${tenantId}
  AND pi.status = 'posted'
  AND pi.kind IN ('purchase', 'purchase_return')
  AND ${onDateTime(sql`pi.posted_at`, f.from, f.to, f.fromTime, f.toTime)}
  AND ${eqIf(sql`pi.branch_id`, f.branchId)}
  AND ${eqIf(sql`pi.warehouse_id`, f.warehouseId)}
  AND ${eqIf(sql`line.item_id`, f.itemId)}
  AND ${eqIf(sql`item.category_id`, f.categoryId)}
`;

const kindScope = (invType?: string): SQL =>
  invType === 'pos' ? sql`si.party_id IS NULL` : invType === 'sale' ? sql`si.party_id IS NOT NULL` : all;
const eqIf = (column: SQL, value?: string): SQL => (value ? sql`${column} = ${value}::uuid` : all);

/**
 * 📋 نوع الفاتورة of «مزامنة الفواتير - ZATCA» — `BuildWhereClause` L872-L920.
 *
 * A فاتورة نقطة بيع is the sale captured at the till: `order_type` set, or taken inside an
 * open shift. «مقاولات» is the invoice a posted progress bill issued. «أندرويد» is the
 * desktop's fall-through — it adds nothing, so the window shows every invoice.
 */
const zatcaKindScope = (kind?: string): SQL =>
  kind === 'pos'
    ? sql`si.kind IN ('sale', 'sale_return') AND (si.order_type IS NOT NULL OR si.shift_id IS NOT NULL)`
    : kind === 'sale'
      ? sql`si.kind IN ('sale', 'sale_return') AND si.order_type IS NULL AND si.shift_id IS NULL`
      : kind === 'notice'
        ? sql`si.kind IN ('credit_note', 'debit_note')`
        : kind === 'contracting'
          ? sql`EXISTS (SELECT 1 FROM progress_bills pb WHERE pb.tenant_id = si.tenant_id AND pb.invoice_id = si.id)`
          : all;

/** 🔄 حالة المزامنة — `inv.ZatcaSent=1` / `=0` (L899-L904). */
const zatcaSyncScope = (status?: string): SQL =>
  status === 'sent'
    ? sql`si.zatca_status IN ('cleared', 'reported')`
    : status === 'unsent'
      ? sql`coalesce(si.zatca_status, '') NOT IN ('cleared', 'reported')`
      : all;

// Party display name, tolerant of the cash-customer case where no party row exists.
const partyName = sql`coalesce(party.name, '—')`;
const branchName = sql`coalesce(branch.name_ar, '—')`;
const itemName = sql`coalesce(item.name_ar, '—')`;

const salesScope = (tenantId: string, f: ReportFilters, kind: string): SQL => sql`
  si.tenant_id = ${tenantId}
  AND si.kind = ${kind}
  AND si.status = 'posted'
  AND ${onDate(sql`si.posted_at::date`, f.from, f.to)}
  AND ${eqIf(sql`si.branch_id`, f.branchId)}
  AND ${eqIf(sql`si.party_id`, f.partyId)}
  AND ${eqIf(sql`si.salesman_id`, f.salesmanId)}
`;

/**
 * ⛵ «حركة المبيعات» — `Form_WPF/frmRptSalesInPeriod.xaml.cs`: both tabs read the same
 * documents (`inv_type` 3/2 through `cmbInvType`, `proc_type` 1 بيع / 2 مرتجع,
 * `Proc_Type<>3 AND Proc_Type<>4`, `IS_Buy=0`, `IS_Deleted=0`), only grouped differently.
 */
const movementScope = (tenantId: string, f: ReportFilters): SQL => sql`
  si.tenant_id = ${tenantId}
  AND si.status = 'posted'
  AND si.kind IN ('sale', 'sale_return')
  AND ${onDateTime(sql`si.posted_at`, f.from, f.to, f.fromTime, f.toTime)}
  AND ${eqIf(sql`si.branch_id`, f.branchId)}
  AND ${kindScope(f.invType)}
`;

const purchaseScope = (tenantId: string, f: ReportFilters, kind: string): SQL => sql`
  pi.tenant_id = ${tenantId}
  AND pi.kind = ${kind}
  AND pi.status = 'posted'
  AND ${onDate(sql`pi.posted_at::date`, f.from, f.to)}
  AND ${eqIf(sql`pi.branch_id`, f.branchId)}
  AND ${eqIf(sql`pi.party_id`, f.partyId)}
`;

// ═══════════════════════════════════════════════════════════════════════════════
// 📚 «تقارير المخزون والأرقام التسلسلية» — `frmRptInventory` · `frmRptItemsActivity` ·
//    `frmRptItemsActivityDetailed` · `frmRptItemsExpiration` · `frmRptSerialNo` ·
//    `frmRptSerialNoSummary` · `frmRptProducedItems`
//
// The desktop keeps every stock movement in two tables (`Inv` + `Inv_Sub`) and tells the
// documents apart with `inv_type` / `proc_type`. The cloud keeps one movement ledger —
// `inventory_transactions` — whose `doc_type` is the desktop's `inv_type` and whose
// `direction` is its `proc_type`; `base_qty` is always positive, exactly like the `val`
// column `frmRptItemsActivity.xaml.cs` L248 adds and subtracts by hand.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The scope every ledger-backed report shares. `wh` is joined so that the 🏢 الفرع filter
 * works: `inventory_transactions` carries a warehouse, and the warehouse carries the branch.
 */
const ledgerScope = (tenantId: string, f: ReportFilters): SQL => sql`
  it.tenant_id = ${tenantId}
  AND ${onDateTime(sql`it.occurred_at`, f.from, f.to, f.fromTime, f.toTime)}
  AND ${eqIf(sql`it.warehouse_id`, f.warehouseId)}
  AND ${eqIf(sql`it.item_id`, f.itemId)}
  AND ${eqIf(sql`item.category_id`, f.categoryId)}
  AND ${eqIf(sql`wh.branch_id`, f.branchId)}
  AND ${f.partyId ? sql`coalesce(si.party_id, pi.party_id) = ${f.partyId}::uuid` : all}
`;

/** The joins that give a ledger row its document number — one per inventory document table. */
const documentJoins = sql`
  LEFT JOIN stock_transfers tr ON tr.id = it.doc_id AND it.doc_type IN ('stock_transfer', 'stock_transfer_receipt', 'stock_transfer_return', 'stock_transfer_cancel')
  LEFT JOIN stock_deliveries dl ON dl.id = it.doc_id AND it.doc_type = 'stock_delivery'
  LEFT JOIN goods_requests rq ON rq.id = it.doc_id AND it.doc_type = 'goods_request'
  LEFT JOIN stock_adjustments aj ON aj.id = it.doc_id AND it.doc_type = 'stock_adjustment'
  LEFT JOIN stock_vouchers sv ON sv.id = it.doc_id AND it.doc_type IN ('stock_voucher', 'stock_voucher_void', 'opening')
  LEFT JOIN production_orders mo ON mo.id = it.doc_id AND it.doc_type = 'production_order'
  LEFT JOIN sales_invoices si ON si.id = it.doc_id AND it.doc_type IN ('sales_invoice', 'sales_return', 'sales_void')
  LEFT JOIN purchase_invoices pi ON pi.id = it.doc_id AND it.doc_type IN ('purchase_invoice', 'purchase_return', 'purchase_void')
`;

/**
 * 📄 نوع العملية — `frmRptInventory.xaml.cs` L260-267 maps its combo to
 * `Inv.inv_type`/`proc_type` pairs: «مناقلة مرسلة» 8/2 · «مناقلة مستلمة» 8/1 ·
 * «بضاعة أول مدة» 9/1 · «أمر توريد» 4/1 · «أمر صرف» 5/1 · «أمر إنتاج» 6/1 ·
 * «طلب بضاعة» 14/1 · «تسوية جردية» 7/1. The cloud names the documents instead.
 */
const docTypeScope = (docType?: string): SQL => {
  switch (docType) {
    case 'transfer_out':
      return sql`it.doc_type = 'stock_transfer'`;
    case 'transfer_in':
      return sql`it.doc_type = 'stock_transfer_receipt'`;
    case 'opening':
      return sql`it.doc_type = 'opening'`;
    case 'delivery':
      return sql`it.doc_type = 'stock_delivery'`;
    case 'issue':
      return sql`it.doc_type = 'stock_voucher' AND it.direction = 'out'`;
    case 'production':
      return sql`it.doc_type = 'production_order'`;
    case 'request':
      return sql`it.doc_type = 'goods_request'`;
    case 'adjustment':
      return sql`it.doc_type = 'stock_adjustment'`;
    default:
      return all;
  }
};

/**
 * 🔄 نوع العملية — `frmRptItemsActivityDetailed.xaml.cs` L426-455 (`BuildProcTypeCondition`),
 * one branch per `Inv.inv_type`. The cloud reads the same documents by `doc_type`.
 */
const movementProcTypeScope = (procType?: string): SQL => {
  switch (procType) {
    case 'purchase':
      return sql`it.doc_type IN ('purchase_invoice', 'purchase_return')`;
    case 'sale':
      return sql`it.doc_type IN ('sales_invoice', 'sales_return') AND si.party_id IS NOT NULL`;
    case 'pos':
      return sql`it.doc_type IN ('sales_invoice', 'sales_return') AND si.party_id IS NULL`;
    case 'delivery':
      return sql`it.doc_type = 'stock_delivery'`;
    case 'issue':
      return sql`it.doc_type = 'stock_voucher' AND it.direction = 'out'`;
    case 'production':
      return sql`it.doc_type = 'production_order'`;
    case 'transfer':
      return sql`it.doc_type IN ('stock_transfer', 'stock_transfer_receipt', 'stock_transfer_return', 'stock_transfer_cancel')`;
    case 'adjustment':
      return sql`it.doc_type = 'stock_adjustment'`;
    case 'opening':
      return sql`it.doc_type = 'opening'`;
    case 'note_credit':
      return sql`si.kind = 'credit_note'`;
    case 'note_debit':
      return sql`si.kind = 'debit_note'`;
    default:
      return all;
  }
};

/**
 * 📋 أنماط الفواتير — the three radios of `frmRptItemsActivityDetailed.xaml` L446-460:
 * «الكل» · «مشتريات» · «مرتجع مشتريات», which the desktop applies to `inv_type = 1`.
 */
const invoicePatternScope = (pattern?: string): SQL =>
  pattern === 'purchase'
    ? sql`it.doc_type = 'purchase_invoice'`
    : pattern === 'purchase_return'
      ? sql`it.doc_type = 'purchase_return'`
      : all;

/**
 * «نوع الفاتورة» — the desktop reads `InvTypes.name` per `inv_type` (`IsInput` decides the
 * sign, L334-345). The cloud has no such table, so the label is derived from `doc_type`
 * with the Arabic names those very windows print: «فاتورة إدخال» / «فاتورة إخراج» and
 * «تسوية إدخال» / «تسوية إخراج» in `frmRptItemsActivity`, «نقطة البيع» in `frmRptPos`.
 */
/**
 * `direction` is passed when the label is built from a single movement row (so an إذن reads
 * «إذن إدخال» or «إذن إخراج») and left out when it is built from a whole document, which can
 * carry both directions and therefore reads «إذن مخزني» / «تسوية جردية».
 */
const docTypeLabel = (column: SQL = sql`it.doc_type`, sales = false, direction?: SQL): SQL => sql`CASE ${column}
    WHEN 'opening' THEN 'بضاعة أول مدة'
    WHEN 'purchase_invoice' THEN 'مشتريات'
    WHEN 'purchase_return' THEN 'مرتجع مشتريات'
    WHEN 'purchase_void' THEN 'إلغاء فاتورة مشتريات'
    WHEN 'sales_invoice' THEN ${
      sales ? sql`CASE WHEN si.party_id IS NULL THEN 'نقطة البيع' ELSE 'مبيعات' END` : sql`'مبيعات'`
    }
    WHEN 'sales_return' THEN ${
      sales ? sql`CASE WHEN si.party_id IS NULL THEN 'مرتجع نقطة البيع' ELSE 'مرتجع مبيعات' END` : sql`'مرتجع مبيعات'`
    }
    WHEN 'sales_void' THEN 'إلغاء فاتورة مبيعات'
    WHEN 'stock_transfer' THEN 'مناقلة مرسلة'
    WHEN 'stock_transfer_receipt' THEN 'مناقلة مستلمة'
    WHEN 'stock_transfer_return' THEN 'مرتجع مناقلة'
    WHEN 'stock_transfer_cancel' THEN 'إلغاء مناقلة'
    WHEN 'stock_voucher' THEN ${direction ? sql`CASE WHEN ${direction} = 'in' THEN 'إذن إدخال' ELSE 'إذن إخراج' END` : sql`'إذن مخزني'`}
    WHEN 'stock_voucher_void' THEN 'إلغاء إذن'
    WHEN 'stock_adjustment' THEN ${direction ? sql`CASE WHEN ${direction} = 'in' THEN 'تسوية إدخال' ELSE 'تسوية إخراج' END` : sql`'تسوية جردية'`}
    WHEN 'production_order' THEN 'أمر إنتاج'
    WHEN 'goods_request' THEN 'طلب بضاعة'
    WHEN 'stock_delivery' THEN 'أمر توريد'
    ELSE ${column}
  END`;

/** «رقم الفاتورة» — whichever document table the movement belongs to. */
const docNumber = sql`coalesce(tr.number, dl.number, rq.number, aj.number, sv.number, mo.number, si.number, pi.number, '—')`;

/**
 * «رقم المرجع» — `Inv.Reff_No` in the desktop. Part three established the cloud reading of
 * that column: a purchase's `supplier_reference_no`, a sale's referenced invoice number, and
 * 📄 رقم المرجع of `production_orders` for an أمر إنتاج.
 */
const docReference = sql`coalesce(
  mo.reference_no,
  pi.supplier_reference_no,
  (SELECT ref.number FROM sales_invoices ref WHERE ref.id = si.reference_invoice_id),
  '—')`;

/** «التاريخ» — the document's own date, falling back to the moment the movement was posted. */
const docDate = sql`to_char(coalesce(tr.sent_at, dl.delivered_at, rq.requested_at, aj.approved_at, sv.posted_at, mo.order_date, si.posted_at, pi.posted_at, it.occurred_at), 'YYYY-MM-DD')`;

/** 🏭 المستودع · 🏢 الفرع · 👥 الحساب of a movement row. */
const warehouseName = sql`coalesce(wh.name, '—')`;
const movementBranch = sql`coalesce(br.name_ar, '—')`;
const movementParty = sql`coalesce(pt.name, '—')`;

const countCard: ReportColumn = { key: 's_count', labelAr: 'العدد', type: 'int', hidden: true };

/** 📄 نوع العملية — the eight inventory documents of `frmRptInventory`. */
const INVENTORY_OPERATION: ReportParam = {
  name: 'docType',
  labelAr: 'نوع العملية',
  kind: 'select',
  options: [
    { value: 'transfer_out', labelAr: 'مناقلة مرسلة' },
    { value: 'transfer_in', labelAr: 'مناقلة مستلمة' },
    { value: 'opening', labelAr: 'بضاعة أول مدة' },
    { value: 'delivery', labelAr: 'أمر توريد' },
    { value: 'issue', labelAr: 'أمر صرف' },
    { value: 'production', labelAr: 'أمر إنتاج' },
    { value: 'request', labelAr: 'طلب بضاعة' },
    { value: 'adjustment', labelAr: 'تسوية جردية' },
  ],
};

/**
 * 🔄 نوع العملية — `cmbProcType` of «حركة صنف تفصيلي». It rides on the generic `kind`
 * filter because `procType` is taken: every فاتورة window in this catalogue reads it as
 * «مبيعات» / «مرتجع» (`proc_type` 1 · 2), which is a different axis altogether.
 */
const MOVEMENT_PROC_TYPE: ReportParam = {
  name: 'kind',
  labelAr: 'نوع العملية',
  kind: 'select',
  options: [
    { value: 'purchase', labelAr: 'مشتريات' },
    { value: 'sale', labelAr: 'مبيعات' },
    { value: 'pos', labelAr: 'نقطة البيع' },
    { value: 'delivery', labelAr: 'أمر توريد' },
    { value: 'issue', labelAr: 'أمر صرف' },
    { value: 'production', labelAr: 'أمر إنتاج' },
    { value: 'transfer', labelAr: 'مناقلة' },
    { value: 'adjustment', labelAr: 'تسوية جردية' },
    { value: 'opening', labelAr: 'بضاعة أول مدة' },
    { value: 'note_credit', labelAr: 'إشعار دائن' },
    { value: 'note_debit', labelAr: 'إشعار مدين' },
  ],
};

/** 📋 أنماط الفواتير — the «الكل / مشتريات / مرتجع مشتريات» radios. */
const INVOICE_PATTERN: ReportParam = {
  name: 'status',
  labelAr: 'أنماط الفواتير',
  kind: 'select',
  options: [
    { value: 'purchase', labelAr: 'مشتريات' },
    { value: 'purchase_return', labelAr: 'مرتجع مشتريات' },
  ],
};

/** 🔢 الرقم التسلسلي — the free text box of the two serial windows. */
const SERIAL_NO: ReportParam = { name: 'serial', labelAr: 'الرقم التسلسلي', kind: 'serial' };

// ═══════════════════════════════════════════════════════════════════════════════
// 📒 «تقارير المحاسبة» — `frmRptBalances` · `frmRptEntries` · `frmRptIncomeStatement` ·
//    `frmRptCostCenter` · `frmTaxRptPeriod`
//
// The five windows read the same two tables the desktop keeps (`Entry` + `Entry_sub`) that
// the cloud splits into `journal_entries` + `journal_entry_lines`, and three of their rules
// carry over unchanged:
//
//   • `Entry.type = 0` is the «قيد إفتتاحي» (`EntryTypes` Id 0 — `CrystalLiteDB.txt` L3341)
//     and `Entry.type <> 0` is the حركة; every one of the five windows splits its numbers on
//     exactly that line. The cloud names the same document `source_type = 'opening'`, the
//     key its own statement service already prints as «قيد إفتتاحي» (`ENTRY_TYPE_LABELS`
//     in `accounting.service.ts`).
//   • `Accounts_Index.FinalAcc = 2` is the income statement — `CrystalLiteDB.txt` L2515 and
//     L2516 give المصروفات and إيرادات that value and الأصول / الخصوم the value 1. The cloud
//     says the same thing with `accounts.type IN ('revenue', 'expense')`.
//   • «الحساب الرئيسي» and «مركز التكلفة» are trees: a row appears when the selected node is
//     one of its ancestors, which the desktop decides by walking `ParentCode` one step at a
//     time (`GetParent`). `accounts.path` is an ltree, root first, so the same test is
//     `acc.path <@ <selected path>`; `cost_centers` keeps a plain `parent_id`, so the
//     cost-centre report walks it with a recursive CTE.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 🧾 نوع القيد — the desktop's `EntryTypes` table (`CrystalLiteDB.txt` L3341-L3358), read
 * through the `source_type` the cloud writes on a posted entry. «سند قبض من عميل» /
 * «سند صرف لمورد» (Id 5 · 6) collapse into «سند قبض» / «سند صرف» (Id 7 · 8) exactly as the
 * cloud's own `entryTypeOf()` does: the desktop tells the two apart by party, and a voucher
 * row already carries its kind.
 */
const ENTRY_TYPE_OPTIONS: Array<{ value: string; labelAr: string }> = [
  { value: 'opening', labelAr: 'قيد إفتتاحي' },
  { value: 'purchase_invoice', labelAr: 'قيد مشتريات' },
  { value: 'purchase_return', labelAr: 'مرتجع مشتريات' },
  { value: 'sales_invoice', labelAr: 'قيد مبيعات' },
  { value: 'sales_return', labelAr: 'مرتجع مبيعات' },
  { value: 'pos_sale', labelAr: 'قيد نقطة بيع' },
  { value: 'credit_note', labelAr: 'إشعار دائن' },
  { value: 'debit_note', labelAr: 'إشعار مدين' },
  { value: 'stock_adjustment', labelAr: 'تسوية جردية' },
  { value: 'voucher_receipt', labelAr: 'سند قبض' },
  { value: 'voucher_payment', labelAr: 'سند صرف' },
  { value: 'stock_voucher', labelAr: 'إذن مخزني' },
  { value: 'opening_stock', labelAr: 'بضاعة أول مدة' },
  { value: 'shift_close', labelAr: 'إغلاق اليومية' },
  { value: 'manual', labelAr: 'قيد اليومية' },
  { value: 'reversal', labelAr: 'قيد عكسي' },
];

/** The joins that give an entry its source document — one per table `source_type` can name. */
const journalDocumentJoins = sql`
  LEFT JOIN sales_invoices si ON si.id = je.source_id AND je.source_type = 'sales_invoice'
  LEFT JOIN purchase_invoices pi ON pi.id = je.source_id AND je.source_type IN ('purchase_invoice', 'purchase_return')
  LEFT JOIN vouchers v ON v.id = je.source_id AND je.source_type = 'voucher'
  LEFT JOIN stock_vouchers sv ON sv.id = je.source_id AND je.source_type = 'stock_voucher'
`;

/** «رقم المستند» — `Entry.doc_no`, the number of the document the entry was posted from. */
const journalDocNumber = sql`coalesce(si.number, pi.number, v.number, sv.number, '—')`;

/**
 * 🧾 نوع القيد — the Arabic name of an entry, in the words of `EntryTypes`, mirroring
 * `entryTypeOf()` in `accounting.service.ts` L304-311 (قيد عكسي first, then the voucher's
 * kind, then `source_type`) so a printed report and a ledger screen never disagree.
 */
const entryTypeLabel = (): SQL => sql`CASE
    WHEN je.kind = 'reversal' THEN 'قيد عكسي'
    WHEN je.source_type = 'opening' THEN 'قيد إفتتاحي'
    WHEN je.source_type = 'sales_invoice' THEN CASE coalesce(si.kind, 'sale')
      WHEN 'sale' THEN CASE WHEN si.party_id IS NULL THEN 'قيد نقطة بيع' ELSE 'قيد مبيعات' END
      WHEN 'sale_return' THEN 'مرتجع مبيعات'
      WHEN 'credit_note' THEN 'إشعار دائن'
      WHEN 'debit_note' THEN 'إشعار مدين'
      ELSE 'قيد مبيعات' END
    WHEN je.source_type = 'purchase_return' THEN 'مرتجع مشتريات'
    WHEN je.source_type = 'purchase_invoice' THEN 'قيد مشتريات'
    WHEN je.source_type = 'voucher' THEN CASE WHEN v.kind = 'receipt' THEN 'سند قبض' ELSE 'سند صرف' END
    WHEN je.source_type = 'stock_adjustment' THEN 'تسوية جردية'
    WHEN je.source_type = 'shift_close' THEN 'إغلاق اليومية'
    WHEN je.source_type = 'stock_voucher' THEN CASE WHEN sv.kind = 'opening' THEN 'بضاعة أول مدة' ELSE 'إذن مخزني' END
    WHEN je.source_type = 'stock_transfer' THEN 'مناقلة مرسلة'
    WHEN je.source_type = 'stock_transfer_receipt' THEN 'مناقلة مستلمة'
    ELSE 'قيد اليومية' END`;

/** 🧾 نوع القيد — the combo of `frmRptEntries` («🔍 البحث» → `cmbType`). */
const ENTRY_TYPE: ReportParam = { name: 'kind', labelAr: 'نوع القيد', kind: 'select', options: ENTRY_TYPE_OPTIONS };

const entryTypeScope = (kind?: string): SQL => {
  switch (kind) {
    case 'opening':
      return sql`je.source_type = 'opening'`;
    case 'purchase_invoice':
      return sql`je.source_type = 'purchase_invoice'`;
    case 'purchase_return':
      return sql`je.source_type = 'purchase_return'`;
    case 'sales_invoice':
      return sql`je.source_type = 'sales_invoice' AND coalesce(si.kind, 'sale') = 'sale' AND si.party_id IS NOT NULL`;
    case 'sales_return':
      return sql`je.source_type = 'sales_invoice' AND si.kind = 'sale_return'`;
    case 'pos_sale':
      return sql`je.source_type = 'sales_invoice' AND coalesce(si.kind, 'sale') = 'sale' AND si.party_id IS NULL`;
    case 'credit_note':
      return sql`je.source_type = 'sales_invoice' AND si.kind = 'credit_note'`;
    case 'debit_note':
      return sql`je.source_type = 'sales_invoice' AND si.kind = 'debit_note'`;
    case 'stock_adjustment':
      return sql`je.source_type = 'stock_adjustment'`;
    case 'voucher_receipt':
      return sql`je.source_type = 'voucher' AND v.kind = 'receipt'`;
    case 'voucher_payment':
      return sql`je.source_type = 'voucher' AND v.kind = 'payment'`;
    case 'stock_voucher':
      return sql`je.source_type = 'stock_voucher' AND coalesce(sv.kind, '') <> 'opening'`;
    case 'opening_stock':
      return sql`je.source_type = 'stock_voucher' AND sv.kind = 'opening'`;
    case 'shift_close':
      return sql`je.source_type = 'shift_close'`;
    case 'manual':
      return sql`je.source_type IS NULL AND je.kind = 'manual'`;
    case 'reversal':
      return sql`je.kind = 'reversal'`;
    default:
      return all;
  }
};

/**
 * 📋 حالة القيد — `cmbState` in `frmRptEntries` is «معتمد» / «لاغي» (`Entry.state` 1 · 0).
 * The cloud posts a reversal instead of flipping a state, so «لاغي» is the entry a reversal
 * now points at, and a draft is the only unposted state that exists at all.
 */
const ENTRY_STATE: ReportParam = {
  name: 'status',
  labelAr: 'حالة القيد',
  kind: 'select',
  options: [
    { value: 'posted', labelAr: 'معتمد' },
    { value: 'void', labelAr: 'لاغي' },
    { value: 'draft', labelAr: 'مسودة' },
  ],
};

const entryStateScope = (tenantId: string, status?: string): SQL => {
  const reversed = sql`EXISTS (SELECT 1 FROM journal_entries rev WHERE rev.tenant_id = ${tenantId} AND rev.reversal_of = je.id)`;
  if (status === 'posted') return sql`je.status = 'posted' AND NOT ${reversed}`;
  if (status === 'void') return sql`${reversed}`;
  if (status === 'draft') return sql`je.status = 'draft'`;
  return all;
};

/** 🔢 رقم القيد · 📄 رقم المستند — the two free boxes of «🔍 البحث» (`txtNoSrch` · `txtReffNo`). */
const ENTRY_NO: ReportParam = { name: 'entryNo', labelAr: 'رقم القيد', kind: 'entryNo' };
const DOC_NO: ReportParam = { name: 'docNo', labelAr: 'رقم المستند', kind: 'docNo' };

/** The scope every entry-level report shares: posted or not, period, branch, نوع القيد, حالة. */
const journalScope = (tenantId: string, f: ReportFilters): SQL => sql`
  je.tenant_id = ${tenantId}
  AND ${onDate(sql`je.date`, f.from, f.to)}
  AND ${eqIf(sql`je.branch_id`, f.branchId)}
  AND ${entryTypeScope(f.kind)}
  AND ${entryStateScope(tenantId, f.status)}
  AND ${f.entryNo ? sql`je.number = ${f.entryNo}` : all}
  AND ${f.docNo ? sql`${journalDocNumber} = ${f.docNo}` : all}
`;

/** The same scope seen from a line: the line carries the مرکز التکلفة and the مندوب. */
const journalLineScope = (tenantId: string, f: ReportFilters): SQL => sql`
  jel.tenant_id = ${tenantId}
  AND ${onDate(sql`je.date`, f.from, f.to)}
  AND ${eqIf(sql`je.branch_id`, f.branchId)}
  AND ${eqIf(sql`jel.cost_center_id`, f.costCenterId)}
  AND ${eqIf(sql`jel.account_id`, f.accountId)}
  AND ${entryTypeScope(f.kind)}
  AND ${entryStateScope(tenantId, f.status)}
`;

/**
 * 🌳 «الحساب الرئيسي» — `frmRptBalances` refuses to run without one («يرجى اختيار حساب
 * رئيسي») and then keeps only the accounts hanging beneath it. `accounts.path` is an ltree
 * of ids, root first, so a descendant is `path <@ <selected path>`; the selected account
 * itself is excluded, exactly as `GetParent` walks up from a row's own parent.
 */
const accountSubtree = (tenantId: string, accountId?: string): SQL =>
  accountId
    ? sql`acc.path <@ (SELECT root.path FROM accounts root WHERE root.id = ${accountId}::uuid AND root.tenant_id = ${tenantId})
          AND acc.id <> ${accountId}::uuid`
    : all;

/**
 * 🌳 «مركز التكلفة» — the same walk over `cost_centers.parent_id`, which is a plain tree,
 * so it needs the recursive CTE `accounts.path` does not.
 */
const COST_CENTER_TREE = (tenantId: string, costCenterId?: string): SQL => sql`cc_tree AS (
    SELECT c.id FROM cost_centers c
    WHERE c.tenant_id = ${tenantId} AND c.deleted_at IS NULL AND c.id = ${costCenterId ?? null}::uuid
    UNION ALL
    SELECT c.id FROM cost_centers c JOIN cc_tree t ON c.parent_id = t.id
    WHERE c.tenant_id = ${tenantId} AND c.deleted_at IS NULL
  )`;

const costCenterSubtree = (costCenterId?: string): SQL =>
  costCenterId ? sql`cc.id IN (SELECT id FROM cc_tree WHERE id <> ${costCenterId}::uuid)` : all;

/**
 * 📂 «تفصيلي» — `DetailedResults` L276-L282: the window takes the selected centre's
 * **children** one level down, and when the centre has none it reports the centre itself.
 * («تجميعي» keeps every descendant instead — see `costCenterSubtree`.)
 */
const costCenterChildren = (tenantId: string, costCenterId?: string): SQL =>
  costCenterId
    ? sql`(cc.id IN (SELECT c.id FROM cost_centers c
                     WHERE c.tenant_id = ${tenantId} AND c.deleted_at IS NULL AND c.parent_id = ${costCenterId}::uuid)
           OR (cc.id = ${costCenterId}::uuid AND NOT EXISTS (SELECT 1 FROM cost_centers child
                     WHERE child.tenant_id = ${tenantId} AND child.deleted_at IS NULL AND child.parent_id = ${costCenterId}::uuid)))`
    : all;

/**
 * 📆 الفترة الضريبية — `frmTaxRptPeriod` has two checkboxes, «ريع سنة» and «شهري», each
 * with a combo; `SetDate()` (L219-L266) lets them **overwrite** the two date boxes, and the
 * quarter wins when both are ticked. The year comes from the date boxes, or from today.
 */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const taxPeriodRange = (f: ReportFilters): { from?: string; to?: string } => {
  const pad = (value: number) => String(value).padStart(2, '0');
  const year = Number((f.from ?? f.to ?? '').slice(0, 4)) || new Date().getUTCFullYear();
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const length = (month: number) => (month === 2 && leap ? 29 : (MONTH_LENGTHS[month - 1] ?? 31));
  if (f.quarter) {
    const quarter = Math.min(4, Math.max(1, Number(f.quarter) || 1));
    const end = quarter * 3;
    return { from: `${year}-${pad(end - 2)}-01`, to: `${year}-${pad(end)}-${pad(length(end))}` };
  }
  if (f.month) {
    const month = Math.min(12, Math.max(1, Number(f.month) || 1));
    return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(length(month))}` };
  }
  return { from: f.from, to: f.to };
};

/** 📆 ربع سنة — `cmbQuartars` of `frmTaxRptPeriod` (L350-L353). */
const TAX_QUARTER: ReportParam = {
  name: 'quarter',
  labelAr: 'ربع سنة',
  kind: 'select',
  options: [
    { value: '1', labelAr: 'الربع الأول' },
    { value: '2', labelAr: 'الربع الثاني' },
    { value: '3', labelAr: 'الربع الثالث' },
    { value: '4', labelAr: 'الربع الرابع' },
  ],
};
/** 📆 شهري — `cmbMonthly` of `frmTaxRptPeriod` (L375-L386). */
const TAX_MONTH: ReportParam = {
  name: 'month',
  labelAr: 'شهري',
  kind: 'select',
  options: Array.from({ length: 12 }, (_unused, index) => ({ value: String(index + 1), labelAr: `شهر ${index + 1}` })),
};

/** ⏰ «وقت البداية (HH:mm)» / «وقت النهاية (HH:mm)» — `frmRptCostCenter.xaml` L258 و L276. */
const TIME_CC: ReportParam[] = [
  { name: 'fromTime', labelAr: 'وقت البداية (HH:mm)', kind: 'time' },
  { name: 'toTime', labelAr: 'وقت النهاية (HH:mm)', kind: 'time' },
];
const ACCOUNT: ReportParam = { name: 'accountId', labelAr: 'الحساب', kind: 'account' };
/** 📊 الحساب الرئيسي — the one filter `frmRptBalances` will not run without. */
const MAIN_ACCOUNT: ReportParam = { name: 'accountId', labelAr: 'الحساب الرئيسي', kind: 'account' };
/** 📋 نوع التقرير — the «تفصيلي» / «تجميعي» radios of `frmRptCostCenter` (L203 · L210). */
const COST_CENTER_MODE: ReportParam = {
  name: 'kind',
  labelAr: 'نوع التقرير',
  kind: 'select',
  options: [
    { value: 'summary', labelAr: 'تجميعي' },
    { value: 'detailed', labelAr: 'تفصيلي' },
  ],
};

/**
 * 🏦 قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ — `Inventory.InventoryCost(branch, toDate)`
 * of `frmRptIncomeStatement.xaml.cs` L379: the stock a branch still holds at «إلى تاريخ».
 * The cloud keeps the movement ledger, so the same figure is the running value of every
 * movement up to that day.
 */
const stockValueAt = (tenantId: string, f: ReportFilters): SQL => sql`(
  SELECT coalesce(sum(CASE WHEN it.direction = 'in' THEN it.total_cost ELSE -it.total_cost END), 0)
  FROM inventory_transactions it
  JOIN warehouses w ON w.id = it.warehouse_id
  WHERE it.tenant_id = ${tenantId} AND ${onDate(sql`it.occurred_at::date`, undefined, f.to)}
    AND ${eqIf(sql`w.branch_id`, f.branchId)}
)`;

/** 🧾 الضريبة of a voucher — `Receipts.NetVal − Payment` in the window, `vat_amount` here. */
const voucherVat = (alias: string): SQL => sql`sum(CASE
    WHEN ${sql.raw(alias)}.vat_amount > 0 THEN ${sql.raw(alias)}.vat_amount
    ELSE greatest(coalesce(${sql.raw(alias)}.net_amount, 0) - ${sql.raw(alias)}.amount, 0) END)`;

// ═══════════════════════════════════════════════════════════════════════════════
// 💰 «تقارير الخزينة والرواتب والمستخدمين» — `frmRptKhzna` · `frmRptSalary` ·
//    `frmRptReseved` · `frmrptUsersRecords` · `frmRptRentInvoices`
//
// Five windows, five reports. The sixth window of the part, `frmInvRptType`
// «🖨️ افتراضي طباعة الفواتير», is a settings dialog (`UPDATE sett SET val = 1|2 WHERE
// id = 1`) and belongs to the printing part, not to this catalogue.
//
// Two of the five read a table the cloud built in an earlier phase and therefore keep its
// own vocabulary rather than the desktop's:
//   • `frmRptKhzna` — the desktop finds the safe's account by matching its name to an
//     account (`Accounts_Index.AName = Stocks.name AND Type = 2`, L159-L164) and refuses
//     when it finds none; the cloud hangs the account on the box itself
//     (`cash_locations.account_id`) and refuses with the same sentence
//     («لم يتم العثور على حساب مرتبط بهذا الصندوق», `CASH_ACCOUNT_REQUIRED`).
//   • `frmRptSalary` — `SalaryPay`'s `tot_salary · Houses · Travel · salary_add ·
//     salary_sub · salary_net` are `salary_payments.basic · housing · transport ·
//     additions · deductions · net`, and «💰 الإجمالي» stays the number the window
//     recomputes: الإجمالي = الصافي + الخصومات.
// ═══════════════════════════════════════════════════════════════════════════════

/** 🏦 الصندوق — `cmbSafe` of `frmRptKhzna` (`SELECT id, name FROM Stocks WHERE branch=…`). */
const CASH_LOCATION: ReportParam = { name: 'cashLocationId', labelAr: 'الصندوق', kind: 'cashLocation' };

/** 📅 الشهر — `txtMonth` of `frmRptSalary`, a number the window formats itself. */
const SALARY_MONTH: ReportParam = {
  name: 'month',
  labelAr: 'الشهر',
  kind: 'select',
  options: Array.from({ length: 12 }, (_unused, index) => ({ value: String(index + 1), labelAr: `شهر ${index + 1}` })),
};

/** 📅 السنة — `txtYear` of `frmRptSalary`; the window filters only when it reads **both**. */
const SALARY_YEAR: ReportParam = { name: 'year', labelAr: 'السنة', kind: 'year' };

/** 👤 المستخدم — the two windows that pick a person (`cmbUsers` of `frmRptRentInvoices`, `frmrptUsersRecords`). */
const ACTOR: ReportParam = { name: 'salesmanId', labelAr: 'المستخدم', kind: 'salesman' };

/** 📁 الفئة — `cmbGroups` of `frmRptRentInvoices` (`GroupMarine`). */
const VESSEL_GROUP: ReportParam = { name: 'groupId', labelAr: 'الفئة', kind: 'vesselGroup' };

/** 🔢 رقم الفاتورة — `txtInvNo`; the window drops every other filter when it is filled. */
const RENT_INVOICE_NO: ReportParam = { name: 'docNo', labelAr: 'رقم الفاتورة', kind: 'docNo' };

/** 👥 العميل — `cmbCustomers` of `frmRptRentInvoices`. */
const RENT_CUSTOMER: ReportParam = { name: 'partyId', labelAr: 'العميل', kind: 'party' };

/**
 * ⚙️ نوع العملية — `cmbProcType` of `frmRptRentInvoices` (`LoadProcesses`, L232-L239):
 * «الكل · تأجير · مرتجع · معلق · حجوزات», which the desktop applies to `proc_type`
 * (1 تأجير · 2 مرتجع · 3 معلق · 4 حجوزات — `CalcIncome` L263-L270 counts 1 و3 as
 * إيرادات, 2 as مرتجع, and leaves 4 out). The cloud has no `proc_type`: a فاتورة تأجير
 * is a `rental_invoices` row, a مرتجع is one whose فاتورة مبيعات is a `sale_return`,
 * a معلق is one whose فاتورة مبيعات لم تُرحَّل بعد, and a حجوزات is a حجز that has no
 * فاتورة تأجير yet.
 */
const RENT_PROCESS: ReportParam = {
  name: 'kind',
  labelAr: 'نوع العملية',
  kind: 'select',
  options: [
    { value: 'rent', labelAr: 'تأجير' },
    { value: 'return', labelAr: 'مرتجع' },
    { value: 'pending', labelAr: 'معلق' },
    { value: 'reservation', labelAr: 'حجوزات' },
  ],
};

/** 📋 الخطة — the three radios `rdAll` · `rdInPlan` · `rdOutPlan` (L319-L333). */
const RENT_PLAN: ReportParam = {
  name: 'status',
  labelAr: 'الخطة',
  kind: 'select',
  options: [
    { value: 'in_plan', labelAr: 'ضمن الخطة' },
    { value: 'out_plan', labelAr: 'خارج الخطة' },
  ],
};

const rentProcessScope = (kind?: string): SQL => {
  switch (kind) {
    case 'rent':
      return sql`u.proc_type = 1`;
    case 'return':
      return sql`u.proc_type = 2`;
    case 'pending':
      return sql`u.proc_type = 3`;
    case 'reservation':
      return sql`u.proc_type = 4`;
    default:
      return all;
  }
};

/** 👤 المستخدم — an audit row names its actor, the desktop names an employee; the way from one to the other is the membership. */
const actorUserScope = (employeeId?: string): SQL =>
  employeeId
    ? sql`log.actor_user_id IN (SELECT m.user_id FROM memberships m
          WHERE m.id = (SELECT emp.membership_id FROM employees emp WHERE emp.id = ${employeeId}::uuid))`
    : all;

/** 🖥️ الجهاز — `Log4NetLog.Logger` names the class that logged; the cloud names the caller. */
const auditDevice = sql`coalesce(log.meta->>'ip', log.meta->>'ua', log.meta->>'userAgent', log.entity, '—')`;

/** 🏷️ نوع الحساب — «🔵 الكل» · «👤 عملاء» · «🏭 موردين» (`frmCustAccountGet` L355-L365). */
const PARTY_KIND: ReportParam = {
  name: 'partyKind',
  labelAr: 'نوع الحساب',
  kind: 'select',
  options: [
    { value: 'all', labelAr: 'الكل' },
    { value: 'customer', labelAr: 'عملاء' },
    { value: 'supplier', labelAr: 'موردين' },
  ],
};

/** 👤 حسابا الطرف — the receivable and the payable account, as a one-column list. */
const partyAccounts = (alias: SQL): SQL =>
  sql`SELECT x.id FROM (VALUES (${alias}.receivable_account_id), (${alias}.payable_account_id)) AS x(id) WHERE x.id IS NOT NULL`;

/**
 * 👤 حركة الطرف — how a customer's or a supplier's movement is found.
 *
 * `frmCustAccountGet` L336 and `frmCustAccount` L221 read the party's **own account** in
 * the journal (`Entry_sub.acc_no = Customers.AccountCode`) — nothing else. Counting the
 * lines that merely carry the party as well would count a collection twice: the receipt
 * debits the bank *and* credits the customer, and both lines name him. So the account is
 * what counts, and the lines that carry the party are the **fallback** for a party the
 * chart never gave an account — a customer opened in a hurry, whose payments would
 * otherwise vanish from his own statement.
 */
const partyMovement = (alias: SQL): SQL => sql`(
          CASE WHEN ${alias}.receivable_account_id IS NULL AND ${alias}.payable_account_id IS NULL
               THEN jel.party_id = ${alias}.id
               ELSE jel.account_id IN (${partyAccounts(alias)}) END)`;

/** 🏷️ نوع الحساب — «عملاء» · «موردين» · «الكل», as `Customers.type` at the desktop. */
const partyKindScope = (alias: string, partyKind?: string): SQL => {
  switch (partyKind) {
    case 'customer':
      return sql`${sql.raw(alias)}.kind IN ('customer', 'both')`;
    case 'supplier':
      return sql`${sql.raw(alias)}.kind IN ('supplier', 'both')`;
    default:
      return all;
  }
};

/** 💳 · 💵 · ⚖️ — a card riding on the first row, hidden from the grid. */
const card = (key: string, labelAr: string): ReportColumn => ({ key, labelAr, type: 'money', hidden: true });

/**
 * 💳 إجمالي المدين · 💵 إجمالي الدائن · ⚖️ الرصيد المدين · ⚖️ الرصيد الدائن — the four
 * boxes of `frmCustAccountGet` (`UpdateSummary` L583-L609). The window puts the رصيد on
 * **one** side only: the side the money is on, so the two cards can never both be filled.
 */
const statementCards = (
  debitKey = 's_debit',
  creditKey = 's_credit',
  balanceDebitKey = 's_bal_debit',
  balanceCreditKey = 's_bal_credit',
): ReportColumn[] => [
  card(debitKey, 'إجمالي المدين'),
  card(creditKey, 'إجمالي الدائن'),
  card(balanceDebitKey, 'الرصيد المدين'),
  card(balanceCreditKey, 'الرصيد الدائن'),
];

const statementGrandTotal = [
  { key: 's_debit', labelAr: 'إجمالي المدين' },
  { key: 's_credit', labelAr: 'إجمالي الدائن' },
  { key: 's_bal_debit', labelAr: 'الرصيد المدين' },
  { key: 's_bal_credit', labelAr: 'الرصيد الدائن' },
];

const definitions: ReportDefinition[] = [
  // ---------------------------------------------------------------- sales
  {
    key: 'sales-invoices',
    titleAr: 'تقرير فواتير المبيعات',
    group: 'sales',
    hintAr: 'الفواتير المرحّلة فقط — المسودات لا تدخل أي تقرير مالي.',
    params: [...PERIOD, BRANCH, PARTY, SALESMAN],
    columns: [text('number', 'الرقم'), date('day', 'التاريخ'), text('party', 'العميل'), text('branch', 'الفرع'), money('subtotal', 'الصافي قبل الضريبة'), money('tax_total', 'الضريبة'), money('total', 'الإجمالي'), money('paid_total', 'المدفوع'), money('due', 'المتبقي'), text('payment_status', 'حالة السداد')],
    totals: ['subtotal', 'tax_total', 'total', 'paid_total', 'due'],
    build: (tenantId, f) => sql`
      SELECT si.number, si.posted_at::date AS day, ${partyName} AS party, ${branchName} AS branch,
             si.subtotal::text, si.tax_total::text, si.total::text, si.paid_total::text,
             (si.total - si.paid_total)::text AS due, si.payment_status
      FROM sales_invoices si
      LEFT JOIN parties party ON party.id = si.party_id
      LEFT JOIN branches branch ON branch.id = si.branch_id
      WHERE ${salesScope(tenantId, f, 'sale')}
      ORDER BY si.posted_at DESC LIMIT 1000`,
  },
  {
    key: 'sales-returns',
    titleAr: 'تقرير مردود المبيعات',
    group: 'sales',
    params: [...PERIOD, BRANCH, PARTY],
    columns: [text('number', 'الرقم'), date('day', 'التاريخ'), text('party', 'العميل'), text('branch', 'الفرع'), money('subtotal', 'الصافي'), money('tax_total', 'الضريبة'), money('total', 'الإجمالي')],
    totals: ['subtotal', 'tax_total', 'total'],
    build: (tenantId, f) => sql`
      SELECT si.number, si.posted_at::date AS day, ${partyName} AS party, ${branchName} AS branch,
             si.subtotal::text, si.tax_total::text, si.total::text
      FROM sales_invoices si
      LEFT JOIN parties party ON party.id = si.party_id
      LEFT JOIN branches branch ON branch.id = si.branch_id
      WHERE ${salesScope(tenantId, f, 'sale_return')}
      ORDER BY si.posted_at DESC LIMIT 1000`,
  },
  {
    key: 'net-sales',
    titleAr: 'صافي المبيعات',
    group: 'sales',
    hintAr: 'المبيعات ناقص المردودات لكل يوم.',
    params: [...PERIOD, BRANCH],
    columns: [date('day', 'اليوم'), money('sales', 'المبيعات'), money('returns', 'المردودات'), money('net', 'الصافي')],
    totals: ['sales', 'returns', 'net'],
    chart: 'bar',
    build: (tenantId, f) => sql`
      SELECT si.posted_at::date AS day,
             sum(CASE WHEN si.kind = 'sale' THEN si.total ELSE 0 END)::text AS sales,
             sum(CASE WHEN si.kind = 'sale_return' THEN si.total ELSE 0 END)::text AS returns,
             (sum(CASE WHEN si.kind = 'sale' THEN si.total ELSE -si.total END))::text AS net
      FROM sales_invoices si
      WHERE si.tenant_id = ${tenantId} AND si.status = 'posted' AND si.kind IN ('sale', 'sale_return')
        AND ${onDate(sql`si.posted_at::date`, f.from, f.to)} AND ${eqIf(sql`si.branch_id`, f.branchId)}
      GROUP BY si.posted_at::date ORDER BY day`,
  },
  {
    key: 'sales-detail',
    titleAr: 'مبيعات تفصيلية',
    group: 'sales',
    hintAr: 'سطر لكل صنف في كل فاتورة.',
    params: [...PERIOD, BRANCH, PARTY, ITEM, CATEGORY],
    columns: [text('number', 'الفاتورة'), date('day', 'التاريخ'), text('party', 'العميل'), text('item', 'الصنف'), qty('quantity', 'الكمية'), money('unit_price', 'السعر'), money('discount_amount', 'الخصم'), money('net', 'الصافي'), money('tax', 'الضريبة'), money('total', 'الإجمالي')],
    totals: ['quantity', 'discount_amount', 'net', 'tax', 'total'],
    build: (tenantId, f) => sql`
      SELECT si.number, si.posted_at::date AS day, ${partyName} AS party, ${itemName} AS item,
             line.quantity::text, line.unit_price::text, line.discount_amount::text,
             line.net::text, line.tax::text, line.total::text
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN parties party ON party.id = si.party_id
      LEFT JOIN items item ON item.id = line.item_id
      WHERE ${salesScope(tenantId, f, 'sale')}
        AND ${eqIf(sql`line.item_id`, f.itemId)} AND ${eqIf(sql`item.category_id`, f.categoryId)}
      ORDER BY si.posted_at DESC, line.line_no LIMIT 2000`,
  },
  {
    key: 'sales-by-item',
    titleAr: 'مبيعات الأصناف تجميعي',
    group: 'sales',
    params: [...PERIOD, BRANCH, CATEGORY],
    columns: [text('sku', 'الرمز'), text('item', 'الصنف'), qty('quantity', 'الكمية'), money('net', 'الصافي'), money('tax', 'الضريبة'), money('total', 'الإجمالي'), money('cost_total', 'التكلفة'), money('profit', 'الربح')],
    totals: ['quantity', 'net', 'tax', 'total', 'cost_total', 'profit'],
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS sku, ${itemName} AS item,
             sum(line.quantity)::text AS quantity, sum(line.net)::text AS net, sum(line.tax)::text AS tax,
             sum(line.total)::text AS total, sum(line.cost_total)::text AS cost_total,
             (sum(line.net) - sum(line.cost_total))::text AS profit
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      WHERE ${salesScope(tenantId, f, 'sale')} AND ${eqIf(sql`item.category_id`, f.categoryId)}
      GROUP BY item.sku, item.name_ar ORDER BY sum(line.total) DESC LIMIT 500`,
  },
  {
    key: 'sales-by-category',
    titleAr: 'مبيعات بحسب الفئة',
    group: 'sales',
    params: [...PERIOD, BRANCH],
    columns: [text('category', 'الفئة'), qty('quantity', 'الكمية'), money('net', 'الصافي'), money('total', 'الإجمالي'), money('profit', 'الربح')],
    totals: ['quantity', 'net', 'total', 'profit'],
    chart: 'bar',
    build: (tenantId, f) => sql`
      SELECT coalesce(cat.name_ar, '—') AS category, sum(line.quantity)::text AS quantity,
             sum(line.net)::text AS net, sum(line.total)::text AS total,
             (sum(line.net) - sum(line.cost_total))::text AS profit
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      LEFT JOIN item_categories cat ON cat.id = item.category_id
      WHERE ${salesScope(tenantId, f, 'sale')}
      GROUP BY cat.name_ar ORDER BY sum(line.total) DESC`,
  },
  {
    key: 'invoice-profit',
    titleAr: 'أرباح الفواتير',
    group: 'sales',
    hintAr: 'التكلفة هي ما قوّم به المخزون الحركة الخارجة وقت الترحيل.',
    params: [...PERIOD, BRANCH, PARTY],
    columns: [text('number', 'الفاتورة'), date('day', 'التاريخ'), text('party', 'العميل'), money('subtotal', 'الصافي'), money('cost_total', 'التكلفة'), money('profit', 'الربح'), percent('margin', 'هامش الربح')],
    totals: ['subtotal', 'cost_total', 'profit'],
    build: (tenantId, f) => sql`
      SELECT si.number, si.posted_at::date AS day, ${partyName} AS party, si.subtotal::text,
             si.cost_total::text, (si.subtotal - si.cost_total)::text AS profit,
             CASE WHEN si.subtotal = 0 THEN '0' ELSE round((si.subtotal - si.cost_total) / si.subtotal * 100, 2)::text END AS margin
      FROM sales_invoices si
      LEFT JOIN parties party ON party.id = si.party_id
      WHERE ${salesScope(tenantId, f, 'sale')}
      ORDER BY si.posted_at DESC LIMIT 1000`,
  },
  {
    key: 'item-profit',
    titleAr: 'أرباح الأصناف',
    group: 'sales',
    params: [...PERIOD, BRANCH, CATEGORY],
    columns: [text('sku', 'الرمز'), text('item', 'الصنف'), qty('quantity', 'الكمية'), money('revenue', 'الإيراد'), money('cost_total', 'التكلفة'), money('profit', 'الربح'), percent('margin', 'الهامش')],
    totals: ['quantity', 'revenue', 'cost_total', 'profit'],
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS sku, ${itemName} AS item, sum(line.quantity)::text AS quantity,
             sum(line.net)::text AS revenue, sum(line.cost_total)::text AS cost_total,
             (sum(line.net) - sum(line.cost_total))::text AS profit,
             CASE WHEN sum(line.net) = 0 THEN '0' ELSE round((sum(line.net) - sum(line.cost_total)) / sum(line.net) * 100, 2)::text END AS margin
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      WHERE ${salesScope(tenantId, f, 'sale')} AND ${eqIf(sql`item.category_id`, f.categoryId)}
      GROUP BY item.sku, item.name_ar ORDER BY (sum(line.net) - sum(line.cost_total)) DESC LIMIT 500`,
  },
  {
    key: 'item-profit-detail',
    titleAr: 'تفاصيل أرباح الأصناف',
    group: 'sales',
    params: [...PERIOD, BRANCH, ITEM],
    columns: [date('day', 'التاريخ'), text('number', 'الفاتورة'), text('item', 'الصنف'), qty('quantity', 'الكمية'), money('net', 'الإيراد'), money('cost_total', 'التكلفة'), money('profit', 'الربح')],
    totals: ['quantity', 'net', 'cost_total', 'profit'],
    build: (tenantId, f) => sql`
      SELECT si.posted_at::date AS day, si.number, ${itemName} AS item, line.quantity::text,
             line.net::text, line.cost_total::text, (line.net - line.cost_total)::text AS profit
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      WHERE ${salesScope(tenantId, f, 'sale')} AND ${eqIf(sql`line.item_id`, f.itemId)}
      ORDER BY si.posted_at DESC LIMIT 2000`,
  },
  {
    key: 'sales-by-salesman',
    titleAr: 'تقرير المندوبين',
    group: 'sales',
    params: [...PERIOD, BRANCH, SALESMAN],
    columns: [text('salesman', 'المندوب'), int('invoices', 'عدد الفواتير'), money('total', 'الإجمالي'), money('profit', 'الربح')],
    totals: ['invoices', 'total', 'profit'],
    build: (tenantId, f) => sql`
      SELECT coalesce(sm.name, 'بدون مندوب') AS salesman, count(*)::text AS invoices,
             sum(si.total)::text AS total, sum(si.subtotal - si.cost_total)::text AS profit
      FROM sales_invoices si
      LEFT JOIN salesmen sm ON sm.id = si.salesman_id
      WHERE ${salesScope(tenantId, f, 'sale')}
      GROUP BY sm.name ORDER BY sum(si.total) DESC`,
  },
  {
    key: 'invoices-by-customer',
    titleAr: 'الفواتير بحسب العملاء',
    group: 'sales',
    params: [...PERIOD, BRANCH],
    columns: [text('party', 'العميل'), int('invoices', 'عدد الفواتير'), money('total', 'الإجمالي'), money('paid_total', 'المدفوع'), money('due', 'المتبقي')],
    totals: ['invoices', 'total', 'paid_total', 'due'],
    build: (tenantId, f) => sql`
      SELECT ${partyName} AS party, count(*)::text AS invoices, sum(si.total)::text AS total,
             sum(si.paid_total)::text AS paid_total, sum(si.total - si.paid_total)::text AS due
      FROM sales_invoices si
      LEFT JOIN parties party ON party.id = si.party_id
      WHERE ${salesScope(tenantId, f, 'sale')}
      GROUP BY party.name ORDER BY sum(si.total) DESC`,
  },
  {
    key: 'customer-balances',
    titleAr: 'أرصدة حساب العملاء',
    group: 'sales',
    hintAr:
      '`frmCustAccount` L221-L288: لكل عميلٍ حساب، وحركته في الفترة مديناً ودائناً، ورصيده (الفرق مطلقاً) وحالته — «مدين» إن زاد المدين، و«دائن» إن زاد الدائن. ولا يظهر في الجدول من لا حركة له.',
    params: [PARTY, PARTY_KIND, SALESMAN, PERIOD[0]!, PERIOD[1]!],
    columns: [
      int('seq', '#'),
      text('account_code', '🔢 رقم الحساب'),
      text('party', '👤 اسم العميل'),
      money('debit', '💸 حركة مدين'),
      money('credit', '💰 حركة دائن'),
      money('balance', '⚖️ الرصيد'),
      text('status', '📌 الحالة'),
    ],
    totals: ['debit', 'credit', 'balance'],
    emptyAr: 'لا حركة لحسابات العملاء في هذه الفترة — و`frmCustAccount` لا يطبع إلا من تحرك حسابه',
    signature: true,
    build: (tenantId, f) => sql`
      WITH party_move AS (
        SELECT party.id AS party_id, sum(jel.debit) AS debit, sum(jel.credit) AS credit
          FROM parties party
          JOIN journal_entry_lines jel ON jel.tenant_id = ${tenantId} AND ${partyMovement(sql`party`)}
          JOIN journal_entries je ON je.id = jel.entry_id AND je.status = 'posted'
         WHERE party.tenant_id = ${tenantId} AND party.deleted_at IS NULL
           AND ${eqIf(sql`party.id`, f.partyId)}
           AND ${partyKindScope('party', f.partyKind)}
           AND ${onDate(sql`je.date`, f.from, f.to)}
           AND ${eqIf(sql`jel.salesman_id`, f.salesmanId)}
         GROUP BY party.id
      )
      SELECT row_number() OVER (ORDER BY party.code) AS seq,
             coalesce(acc.code, party.code) AS account_code,
             party.name AS party,
             round(coalesce(m.debit, 0), 2)::text AS debit,
             round(coalesce(m.credit, 0), 2)::text AS credit,
             round(abs(coalesce(m.debit, 0) - coalesce(m.credit, 0)), 2)::text AS balance,
             CASE WHEN coalesce(m.debit, 0) >= coalesce(m.credit, 0) THEN 'مدين' ELSE 'دائن' END AS status
        FROM parties party
        LEFT JOIN accounts acc ON acc.id = party.receivable_account_id
        JOIN party_move m ON m.party_id = party.id AND (coalesce(m.debit, 0) <> 0 OR coalesce(m.credit, 0) <> 0)
       WHERE party.tenant_id = ${tenantId} AND party.deleted_at IS NULL
         AND ${eqIf(sql`party.id`, f.partyId)}
         AND ${partyKindScope('party', f.partyKind)}
       ORDER BY party.code LIMIT 1000`,
  },
  {
    key: 'customer-last-payment',
    titleAr: 'حركة آخر سداد للعملاء',
    group: 'sales',
    hintAr:
      '`frmCustLastPay`: آخر قيدٍ حرّك حساب كل عميل — قيمته وتاريخه ونوع سنده — ورصيده الكامل مديناً أو دائناً. بلا فترة: النافذة لا مربّع تاريخ فيها.',
    params: [PARTY, PARTY_KIND],
    columns: [
      text('account_code', 'رقم الحساب'),
      text('party', 'اسم العميل'),
      text('phone', 'الهاتف'),
      money('last_amount', 'قيمة آخر سداد'),
      date('last_day', 'تاريخ آخر سداد'),
      text('entry_type', 'نوع السند'),
      money('balance', 'الرصيد'),
      text('status', 'الحالة'),
      text('entry_no', 'رقم القيد'),
      card('s_total', '💳 الإجمالي'),
      card('s_balance', '⚖️ الرصيد'),
      countCard,
    ],
    totals: ['last_amount', 'balance'],
    grandTotal: [
      { key: 's_total', labelAr: 'الإجمالي' },
      { key: 's_balance', labelAr: 'الرصيد' },
      { key: 's_count', labelAr: 'السجلات' },
    ],
    emptyAr: 'لا حسابات عملاء ذات حركة',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT coalesce(acc.code, party.code) AS account_code,
             party.name AS party,
             coalesce(party.phone, '—') AS phone,
             round(CASE WHEN coalesce(le.debit, 0) = 0 THEN coalesce(le.credit, 0) ELSE le.debit END, 2)::text AS last_amount,
             le.day AS last_day,
             ${entryTypeLabel()} AS entry_type,
             round(abs(coalesce(m.debit, 0) - coalesce(m.credit, 0)), 2)::text AS balance,
             CASE WHEN coalesce(m.debit, 0) >= coalesce(m.credit, 0) THEN 'مدين' ELSE 'دائن' END AS status,
             coalesce(je.number, '—') AS entry_no,
             CASE WHEN row_number() OVER (ORDER BY party.code) = 1
                  THEN round(sum(CASE WHEN coalesce(le.debit, 0) = 0 THEN coalesce(le.credit, 0) ELSE le.debit END) OVER (), 2)::text ELSE '0' END AS s_total,
             CASE WHEN row_number() OVER (ORDER BY party.code) = 1
                  THEN round(sum(coalesce(m.debit, 0) - coalesce(m.credit, 0)) OVER (), 2)::text ELSE '0' END AS s_balance,
             '1' AS s_count
        FROM parties party
        LEFT JOIN accounts acc ON acc.id = party.receivable_account_id
        JOIN LATERAL (
          SELECT sum(jel.debit) AS debit, sum(jel.credit) AS credit
            FROM journal_entry_lines jel
            JOIN journal_entries je ON je.id = jel.entry_id AND je.status = 'posted'
           WHERE jel.tenant_id = ${tenantId} AND ${partyMovement(sql`party`)}
        ) m ON coalesce(m.debit, 0) <> 0 OR coalesce(m.credit, 0) <> 0
        LEFT JOIN LATERAL (
          SELECT je.id AS entry_id, je.date AS day, jel.debit, jel.credit
            FROM journal_entry_lines jel
            JOIN journal_entries je ON je.id = jel.entry_id AND je.status = 'posted'
           WHERE jel.tenant_id = ${tenantId} AND ${partyMovement(sql`party`)}
           ORDER BY je.date DESC, coalesce(je.entry_time, '00:00'::time) DESC, je.created_at DESC, jel.line_no
           LIMIT 1
        ) le ON true
        LEFT JOIN journal_entries je ON je.id = le.entry_id
        ${journalDocumentJoins}
       WHERE party.tenant_id = ${tenantId} AND party.deleted_at IS NULL
         AND ${eqIf(sql`party.id`, f.partyId)}
         AND ${partyKindScope('party', f.partyKind)}
       ORDER BY party.code LIMIT 1000`,
  },

  {
    key: 'customer-settlements',
    titleAr: 'سداد العملاء',
    group: 'sales',
    hintAr: 'كل ما قُبض من العملاء: دفعات الفواتير وسندات القبض المرحّلة.',
    params: [...PERIOD, PARTY],
    columns: [date('day', 'التاريخ'), text('party', 'العميل'), text('source', 'المصدر'), text('method', 'الطريقة'), money('amount', 'المبلغ')],
    totals: ['amount'],
    build: (tenantId, f) => sql`
      SELECT day, party, source, method, amount::text FROM (
        SELECT ip.created_at::date AS day, ${partyName} AS party, 'دفعة فاتورة' AS source, ip.method, ip.amount
        FROM invoice_payments ip
        JOIN sales_invoices si ON si.id = ip.invoice_id
        LEFT JOIN parties party ON party.id = si.party_id
        WHERE ip.tenant_id = ${tenantId} AND ${onDate(sql`ip.created_at::date`, f.from, f.to)} AND ${eqIf(sql`si.party_id`, f.partyId)}
        UNION ALL
        SELECT v.date AS day, coalesce(vp.name, '—') AS party, 'سند قبض' AS source, v.method, v.amount
        FROM vouchers v
        LEFT JOIN parties vp ON vp.id = v.party_id
        WHERE v.tenant_id = ${tenantId} AND v.kind = 'receipt' AND v.status = 'posted'
          AND ${onDate(sql`v.date`, f.from, f.to)} AND ${eqIf(sql`v.party_id`, f.partyId)}
      ) settlements ORDER BY day DESC LIMIT 1000`,
  },
  {
    key: 'sales-by-day',
    titleAr: 'حركة المبيعات اليومية',
    group: 'sales',
    params: [...PERIOD, BRANCH],
    columns: [date('day', 'اليوم'), int('invoices', 'عدد الفواتير'), money('total', 'الإجمالي')],
    totals: ['invoices', 'total'],
    chart: 'bar',
    build: (tenantId, f) => sql`
      SELECT si.posted_at::date AS day, count(*)::text AS invoices, sum(si.total)::text AS total
      FROM sales_invoices si WHERE ${salesScope(tenantId, f, 'sale')}
      GROUP BY si.posted_at::date ORDER BY day`,
  },
  {
    key: 'monthly-sales',
    titleAr: 'المبيعات الشهرية',
    group: 'sales',
    params: [...PERIOD, BRANCH],
    columns: [date('month', 'الشهر'), int('invoices', 'عدد الفواتير'), money('total', 'الإجمالي')],
    totals: ['invoices', 'total'],
    chart: 'bar',
    build: (tenantId, f) => sql`
      SELECT date_trunc('month', si.posted_at)::date AS month, count(*)::text AS invoices, sum(si.total)::text AS total
      FROM sales_invoices si WHERE ${salesScope(tenantId, f, 'sale')}
      GROUP BY date_trunc('month', si.posted_at) ORDER BY month`,
  },
  {
    /**
     * 📈 مخطط المبيعات — `FrmRptSalesChart.xaml` / `FrmRptSalesChart.xaml.cs`:
     * «رسم بياني يوضح مبيعات كل فرع/صنف/مندوب حسب الفترة»، مع 3 تبويبات
     * (مبيعات · مردودات · صافي). السحابة تقدم صافي المبيعات اليومي كأساس للرسم
     * مع خيار الفرع.
     */
    key: 'sales-chart',
    titleAr: 'مخطط المبيعات',
    group: 'sales',
    hintAr: 'مخطط بياني لصافي المبيعات اليومي (المبيعات − المردودات) — `FrmRptSalesChart`.',
    params: [...PERIOD, BRANCH],
    columns: [date('day', 'اليوم'), money('sales', 'المبيعات'), money('returns', 'المردودات'), money('net', 'الصافي')],
    totals: ['sales', 'returns', 'net'],
    chart: 'bar',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT si.posted_at::date AS day,
             sum(CASE WHEN si.kind = 'sale' THEN si.total ELSE 0 END)::text AS sales,
             sum(CASE WHEN si.kind = 'sale_return' THEN si.total ELSE 0 END)::text AS returns,
             (sum(CASE WHEN si.kind = 'sale' THEN si.total ELSE -si.total END))::text AS net
      FROM sales_invoices si
      WHERE si.tenant_id = ${tenantId} AND si.status = 'posted' AND si.kind IN ('sale', 'sale_return')
        AND ${onDate(sql`si.posted_at::date`, f.from, f.to)} AND ${eqIf(sql`si.branch_id`, f.branchId)}
      GROUP BY si.posted_at::date ORDER BY day`,
  },
  {
    key: 'sales-by-payment',
    titleAr: 'المبيعات بحسب حالة السداد',
    group: 'sales',
    params: [...PERIOD, BRANCH],
    columns: [text('payment_status', 'حالة السداد'), int('count', 'العدد'), money('total', 'الإجمالي')],
    totals: ['count', 'total'],
    build: (tenantId, f) => sql`
      SELECT si.payment_status, count(*)::text AS count, sum(si.total)::text AS total
      FROM sales_invoices si WHERE ${salesScope(tenantId, f, 'sale')}
      GROUP BY si.payment_status ORDER BY si.payment_status`,
  },

  {
    key: 'sales-movement-items',
    titleAr: 'حركة المبيعات — إجمالي المبيعات',
    group: 'sales',
    hintAr: '«📊 إجمالي المبيعات» من `frmRptSalesInPeriod`: كل صنفٍ بكميّته الصافية وإجماليه الصافي (المبيعات − المرتجع)، وصنفٌ لم يُبع أصلاً لا يظهر.',
    params: [PERIOD[0]!, TIME[0]!, PERIOD[1]!, TIME[1]!, INVOICE_KIND, BRANCH],
    columns: [text('item_code', 'رقم الصنف'), text('item_name', 'الصنف'), qty('quantity', 'الكمية'), money('total', 'الإجمالي')],
    // 💰 إجمالي المبيعات — `txtSumSale` = Σ(الإجمالي الصافي) كما يجمعها `CalcStock`.
    grandTotal: { key: 'total', labelAr: 'إجمالي المبيعات' },
    emptyAr: 'لا توجد عمليات بالجدول',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS item_code, coalesce(item.name_ar, '—') AS item_name,
             sum(CASE WHEN si.kind = 'sale' THEN line.quantity ELSE -line.quantity END)::text AS quantity,
             round(sum(CASE WHEN si.kind = 'sale' THEN line.total ELSE -line.total END), 2)::text AS total
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      WHERE ${movementScope(tenantId, f)}
      GROUP BY item.id, item.sku, item.name_ar
      -- if (qty == 0.0) continue; — an صنف with no بيع at all is not a row, even when it was returned.
      HAVING sum(CASE WHEN si.kind = 'sale' THEN line.quantity ELSE 0 END) <> 0
      ORDER BY item.id LIMIT 2000`,
  },
  {
    key: 'sales-movement-invoices',
    titleAr: 'حركة المبيعات — عرض الفواتير',
    group: 'sales',
    hintAr: '«🧾 عرض الفواتير» من `frmRptSalesInPeriod`: فاتورةٌ بيع أو مرتجع بسطر، بوقتها ونقدها وشبكتها ومجاميعها الأربعة؛ و«آجل» علامة `pay_type = -1`.',
    params: [PERIOD[0]!, TIME[0]!, PERIOD[1]!, TIME[1]!, INVOICE_KIND, BRANCH],
    columns: [
      text('movement_no', 'رقم الحركة'),
      text('number', 'رقم الفاتورة'),
      text('kind_name', 'نوع الفاتورة'),
      date('day', 'التاريخ'),
      text('time', 'الوقت'),
      text('postponed', 'آجل'),
      money('cash', 'نقدي'),
      money('network', 'شبكة'),
      money('subtotal', 'الإجمالي'),
      money('tax', 'الضريبة'),
      money('discount', 'الخصم'),
      money('net', 'الصافي'),
      // المبيعات ناقص المردودات — what «💰 إجمالي المبيعات:» prints (`_sumSale2`).
      { key: 'net_signed', labelAr: 'صافي الحركة', type: 'money', hidden: true },
    ],
    grandTotal: { key: 'net_signed', labelAr: 'إجمالي المبيعات' },
    emptyAr: 'لا توجد عمليات بالجدول',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT si.id::text AS movement_no, coalesce(si.number, '—') AS number,
             CASE si.kind WHEN 'sale' THEN 'بيع' WHEN 'sale_return' THEN 'مرتجع' ELSE si.kind END AS kind_name,
             si.posted_at::date AS day, to_char(si.posted_at, 'HH24:MI:SS') AS time,
             CASE WHEN si.payment_status = 'unpaid' THEN 'نعم' ELSE '—' END AS postponed,
             coalesce(paid.cash, 0)::text AS cash, coalesce(paid.network, 0)::text AS network,
             si.subtotal::text AS subtotal, si.tax_total::text AS tax,
             si.invoice_discount::text AS discount, si.total::text AS net,
             (CASE WHEN si.kind = 'sale' THEN si.total ELSE -si.total END)::text AS net_signed
      FROM sales_invoices si
      LEFT JOIN (
        SELECT p.invoice_id,
               sum(CASE WHEN p.method = 'cash' THEN p.amount ELSE 0 END) AS cash,
               sum(CASE WHEN p.method = 'card' THEN p.amount ELSE 0 END) AS network
        FROM invoice_payments p
        WHERE p.tenant_id = ${tenantId}
        GROUP BY p.invoice_id
      ) paid ON paid.invoice_id = si.id
      WHERE ${movementScope(tenantId, f)}
      ORDER BY si.posted_at, si.number LIMIT 2000`,
  },
  {
    key: 'items-sales-summary',
    titleAr: 'مبيعات الأصناف تجميعي',
    group: 'sales',
    hintAr: 'كل صنفٍ بكميّته الصافية وصافي بيعه (`OperType = 1`): المبيعات والمردودات معاً، نقطة البيع والبيع العادي معاً.',
    // 🏪 المستودع · 🗂️ المجموعة · 📦 الصنف · 🏢 الفرع · 📅 الفترة الزمنية — the order of the
    // 🔧 خيارات البحث panel itself (L263 … L413).
    params: [WAREHOUSE, CATEGORY, ITEM, BRANCH, PERIOD[0]!, TIME_START_END[0]!, PERIOD[1]!, TIME_START_END[1]!],
    columns: [
      text('item_code', 'رمز الصنف'),
      text('item_name', 'الصنف'),
      text('category', 'المجموعة'),
      qty('quantity', 'الكمية'),
      money('net_sales', 'صافي البيع'),
    ],
    totals: ['quantity', 'net_sales'],
    grandTotal: [
      { key: 'net_sales', labelAr: 'إجمالي صافي البيع' },
      { key: 'quantity', labelAr: 'إجمالي الكميات' },
    ],
    signature: true,
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS item_code, coalesce(item.name_ar, '—') AS item_name,
             coalesce(cat.name_ar, '—') AS category,
             sum(CASE WHEN si.kind = 'sale' THEN line.quantity ELSE -line.quantity END)::text AS quantity,
             round(sum(CASE WHEN si.kind = 'sale' THEN line.total ELSE -line.total END), 2)::text AS net_sales
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      LEFT JOIN item_categories cat ON cat.id = item.category_id
      WHERE ${movementLinesScope(tenantId, f, null)}
      GROUP BY item.id, item.sku, item.name_ar, cat.name_ar
      -- «لا حركة → تجاهل» — if (!hasMovement) continue; in frmRptItemsSalesDetails.xaml.cs L282.
      HAVING sum(line.quantity) <> 0
      ORDER BY item_name LIMIT 2000`,
  },
  {
    key: 'items-pos-sales-summary',
    titleAr: 'مبيعات الأصناف تجميعي - نقطة البيع',
    group: 'sales',
    hintAr: 'النافذة نفسها مقيَّدة بـ`inv.inv_type=3`: فواتير نقطة البيع وحدها (`PosVal − PosRetVal`).',
    // 👤 المستخدم (مؤجَّل) و📅 الفترة الزمنية وحدها — that panel has no مستودع ولا مجموعة.
    params: [PERIOD[0]!, TIME_START_END[0]!, PERIOD[1]!, TIME_START_END[1]!],
    columns: [
      text('item_code', 'رمز الصنف'),
      text('item_name', 'الصنف'),
      text('category', 'المجموعة'),
      qty('quantity', 'الكمية'),
      money('net_sales', 'صافي البيع'),
    ],
    totals: ['quantity', 'net_sales'],
    grandTotal: [
      { key: 'net_sales', labelAr: 'إجمالي صافي البيع' },
      { key: 'quantity', labelAr: 'إجمالي الكميات' },
    ],
    signature: true,
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS item_code, coalesce(item.name_ar, '—') AS item_name,
             coalesce(cat.name_ar, '—') AS category,
             sum(CASE WHEN si.kind = 'sale' THEN line.quantity ELSE -line.quantity END)::text AS quantity,
             round(sum(CASE WHEN si.kind = 'sale' THEN line.total ELSE -line.total END), 2)::text AS net_sales
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      LEFT JOIN item_categories cat ON cat.id = item.category_id
      WHERE ${movementLinesScope(tenantId, f, true)}
      GROUP BY item.id, item.sku, item.name_ar, cat.name_ar
      -- «لا حركة → تجاهل» — if (!hasMovement) continue; in frmRptItemsSalesDetailsPOS.xaml.cs L223.
      HAVING sum(line.quantity) <> 0
      ORDER BY item_name LIMIT 2000`,
  },
  {
    key: 'items-profit-summary',
    titleAr: 'أرباح المواد تجميعي',
    group: 'sales',
    hintAr: '«صافي البيع» بعد خصم السطر والخصم الموزَّع من رأس الفاتورة، و«الربح» = صافي البيع − إجمالي التكلفة، و«نسبة الربح» = الربح ÷ التكلفة × 100.',
    // 🏪 المستودع · 🗂️ المجموعة · 📦 الصنف · 📅 الفترة الزمنية (من · حتى, no time box).
    params: [WAREHOUSE, CATEGORY, ITEM, { name: 'from', labelAr: 'من', kind: 'date' } satisfies ReportParam, { name: 'to', labelAr: 'حتى', kind: 'date' } satisfies ReportParam],
    columns: [
      text('item_code', 'رمز المادة'),
      text('item_name', 'المادة'),
      qty('quantity', 'الكمية'),
      money('total_cost', 'متوسط التكلفة'),
      money('net_sales', 'صافي البيع'),
      money('profit', 'الربح'),
      percent('profit_ratio', 'نسبة الربح'),
    ],
    totals: ['quantity', 'total_cost', 'net_sales', 'profit'],
    grandTotal: [
      { key: 'net_sales', labelAr: 'إجمالي صافي البيع' },
      { key: 'profit', labelAr: 'إجمالي الربح' },
    ],
    signature: true,
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS item_code, coalesce(item.name_ar, '—') AS item_name,
             sum(signed.line_qty)::text AS quantity,
             round(sum(signed.line_cost), 2)::text AS total_cost,
             -- «صافي البيع»: صافي السطر بعد خصم السطر وبعد نصيبه من خصم رأس الفاتورة.
             -- The desktop does that distribution in the report itself —
             -- SUM(ROUND((ItemPriceWithoutVAT * minus / NULLIF(InvSum,0)),2)) in
             -- frmRptItemsProfit.GetSaleData — while the cloud distributes it at save
             -- time: calculateInvoiceTotals spreads invoice_discount pro-rata by gross
             -- into every line.net, which is why the report reads line.net as it stands.
             round(sum(signed.line_net), 2)::text AS net_sales,
             round(sum(signed.line_net) - sum(signed.line_cost), 2)::text AS profit,
             round(
               CASE WHEN sum(signed.line_cost) = 0 THEN 0
                    ELSE (sum(signed.line_net) - sum(signed.line_cost)) / sum(signed.line_cost) * 100 END,
               2)::text AS profit_ratio
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      LEFT JOIN item_categories cat ON cat.id = item.category_id
      -- One row per line, already signed: proc_type 1 (بيع) موجب و2 (مرتجع) سالب، لنمطي
      -- البيع ونقطة البيع معاً — r1 − r2 + r3 − r4 in ShowResults.
      CROSS JOIN LATERAL (
        SELECT CASE WHEN si.kind = 'sale' THEN line.quantity ELSE -line.quantity END AS line_qty,
               CASE WHEN si.kind = 'sale' THEN line.net ELSE -line.net END AS line_net,
               CASE WHEN si.kind = 'sale' THEN line.cost_total ELSE -line.cost_total END AS line_cost
      ) signed
      WHERE ${movementLinesScope(tenantId, f, null)}
      GROUP BY item.id, item.sku, item.name_ar
      -- «تجاهل الصنف إذا لم تكن له حركة» — frmRptItemsProfit.xaml.cs L220: a item with any
      -- of the four quantities non-zero is a row, even when the net comes out at zero.
      HAVING sum(line.quantity) <> 0
      ORDER BY item_name LIMIT 2000`,
  },
  {
    key: 'items-purchases-summary',
    titleAr: 'مشتريات الأصناف تجميعي',
    group: 'purchases',
    hintAr: 'النافذة نفسها بـ`OperType = 2`: المشتريات ناقص مردوداتها (`PurchVal − RePurchVal`).',
    params: [WAREHOUSE, CATEGORY, ITEM, BRANCH, PERIOD[0]!, TIME_START_END[0]!, PERIOD[1]!, TIME_START_END[1]!],
    columns: [
      text('item_code', 'رمز الصنف'),
      text('item_name', 'الصنف'),
      text('category', 'المجموعة'),
      qty('quantity', 'الكمية'),
      money('net_purchases', 'صافي الشراء'),
    ],
    totals: ['quantity', 'net_purchases'],
    grandTotal: [
      { key: 'net_purchases', labelAr: 'إجمالي صافي الشراء' },
      { key: 'quantity', labelAr: 'إجمالي الكميات' },
    ],
    signature: true,
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS item_code, coalesce(item.name_ar, '—') AS item_name,
             coalesce(cat.name_ar, '—') AS category,
             sum(CASE WHEN pi.kind = 'purchase' THEN line.quantity ELSE -line.quantity END)::text AS quantity,
             round(sum(CASE WHEN pi.kind = 'purchase' THEN line.total ELSE -line.total END), 2)::text AS net_purchases
      FROM purchase_invoice_lines line
      JOIN purchase_invoices pi ON pi.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      LEFT JOIN item_categories cat ON cat.id = item.category_id
      WHERE ${purchaseLinesScope(tenantId, f)}
      GROUP BY item.id, item.sku, item.name_ar, cat.name_ar
      -- The desktop shares the loop with the sales window, so its hasMovement test still
      -- reads the sale columns even when OperType = 2; the cloud keeps the sane predicate.
      HAVING sum(line.quantity) <> 0
      ORDER BY item_name LIMIT 2000`,
  },
  {
    key: 'items-profit-details',
    titleAr: 'أرباح المواد تفصيلي',
    group: 'sales',
    hintAr: 'سطرٌ لكل حركة: الفاتورة وتاريخها ونوعها ومستودعها، ثم المادة وكميتها وتكلفتها وسعرها ومجموعها وخصمها وربحها ونسبته.',
    // 🏭 المستودع · 📦 الصنف · 📅 الفترة (من تاريخ · من وقت · إلى تاريخ · إلى وقت).
    params: [WAREHOUSE, ITEM, PERIOD[0]!, TIME_FROM_TO[0]!, PERIOD[1]!, TIME_FROM_TO[1]!],
    columns: [
      text('number', 'الرقم'),
      date('day', 'التاريخ'),
      text('operation', 'نوع العملية'),
      text('warehouse', 'المستودع'),
      text('item_code', 'رمز المادة'),
      text('item_name', 'المادة'),
      text('unit', 'الوحدة'),
      qty('quantity', 'الكمية'),
      money('unit_cost', 'متوسط التكلفة'),
      money('total_cost', 'إجمالي التكلفة'),
      money('unit_price', 'السعر'),
      money('gross', 'المجموع'),
      money('net', 'الإجمالي'),
      money('discount', 'الخصم'),
      money('profit', 'الربح'),
      percent('profit_ratio', 'نسبة الربح %'),
    ],
    totals: ['quantity', 'total_cost', 'gross', 'net', 'discount', 'profit'],
    // 📊 ملخص الأرباح — «إجمالي التكلفة · المجموع · الإجمالي · الخصم · 💹 إجمالي الربح»
    // (L655 … L716); «عدد السجلات» هو عدد صفوف الشبكة الذي يطبعه الرأس أصلاً.
    grandTotal: [
      { key: 'total_cost', labelAr: 'إجمالي التكلفة' },
      { key: 'gross', labelAr: 'المجموع' },
      { key: 'net', labelAr: 'الإجمالي' },
      { key: 'discount', labelAr: 'الخصم' },
      { key: 'profit', labelAr: 'إجمالي الربح' },
    ],
    emptyAr: 'لا توجد عمليات بالجدول',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT coalesce(si.number, '—') AS number, si.posted_at::date AS day,
             CASE si.kind WHEN 'sale' THEN 'بيع' WHEN 'sale_return' THEN 'مرتجع' ELSE si.kind END AS operation,
             coalesce(wh.name, '—') AS warehouse,
             coalesce(item.sku, '—') AS item_code, coalesce(item.name_ar, '—') AS item_name,
             coalesce(unit.name_ar, '—') AS unit,
             signed.qty::text AS quantity,
             -- DgvAvgCost / DgvTotAvg — the cost of the حركة divided by its كمية, and the
             -- cost of the whole line (val * AvrgCost at the desktop).
             round(signed.cost / nullif(signed.qty, 0), 2)::text AS unit_cost,
             round(signed.cost, 2)::text AS total_cost,
             line.unit_price::text AS unit_price,
             round(signed.gross, 2)::text AS gross, round(signed.net, 2)::text AS net,
             round(signed.gross - signed.net, 2)::text AS discount,
             round(signed.net - signed.cost, 2)::text AS profit,
             round(CASE WHEN signed.cost = 0 THEN 0 ELSE (signed.net - signed.cost) / signed.cost * 100 END, 2)::text AS profit_ratio
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      LEFT JOIN units_of_measure unit ON unit.id = item.base_unit_id
      LEFT JOIN warehouses wh ON wh.id = si.warehouse_id
      -- proc_type 1 (بيع) موجب و2 (مرتجع) سالب — val1 · val · AvrgCost · exchange_price
      -- and ((val1*exchange_price)/InvSum)*minus in frmRptItemsProfitDetails.xaml.cs.
      CROSS JOIN LATERAL (
        SELECT CASE WHEN si.kind = 'sale' THEN line.quantity ELSE -line.quantity END AS qty,
               CASE WHEN si.kind = 'sale' THEN line.cost_total ELSE -line.cost_total END AS cost,
               CASE WHEN si.kind = 'sale' THEN line.quantity * line.unit_price ELSE -line.quantity * line.unit_price END AS gross,
               CASE WHEN si.kind = 'sale' THEN line.net ELSE -line.net END AS net
      ) signed
      WHERE ${movementLinesScope(tenantId, f, null, { branch: false, category: false })}
        -- AND Inv_Sub.ItemId > 0 — a وصف line with no صنف is not a row of a أرباح المواد report.
        AND line.item_id IS NOT NULL
      ORDER BY si.posted_at DESC, si.number DESC LIMIT 2000`,
  },
  {
    // The cloud already had a `sales-by-category` («مبيعات بحسب الفئة», one row per فئة with
    // a bar chart); this one is the desktop's tree of أصناف under their مجموعات.
    key: 'items-sales-by-category',
    titleAr: 'تقرير مبيعات الأصناف حسب المجموعة',
    group: 'sales',
    hintAr: 'كل صنفٍ تحت مجموعته: إجمالي كميّته وإجماليه وضريبته وصافيه وخصمه؛ ومجاميع المجموعات في البطاقات.',
    // 📄 نوع الفاتورة · 📅 الفترة (من تاريخ / إلى تاريخ) · 📂 المجموعة · 🏬 الفرع — the
    // 👤 المستخدم and 🧑‍💼 المندوب boxes are deferred (§5.5).
    params: [INVOICE_KIND_SALES, PERIOD[0]!, PERIOD[1]!, CATEGORY, BRANCH],
    columns: [
      text('category', 'المجموعة'),
      text('item_name', 'اسم المجموعة / الصنف'),
      text('item_code', 'الرمز'),
      qty('quantity', 'إجمالي الكمية'),
      money('total', 'الإجمالي'),
      money('tax', 'الضريبة'),
      money('net', 'الصافي'),
      money('discount', 'الخصم'),
    ],
    totals: ['quantity', 'total', 'tax', 'net', 'discount'],
    // «إجمالي الكمية · الإجمالي · الضريبة · الصافي» — lblTotQty · lblTotTotal · lblTotVat · lblTotNet.
    grandTotal: [
      { key: 'quantity', labelAr: 'إجمالي الكمية' },
      { key: 'total', labelAr: 'الإجمالي' },
      { key: 'tax', labelAr: 'الضريبة' },
      { key: 'net', labelAr: 'الصافي' },
    ],
    signature: true,
    build: (tenantId, f) => sql`
      SELECT coalesce(cat.name_ar, '—') AS category,
             coalesce(item.name_ar, '—') AS item_name, coalesce(item.sku, '—') AS item_code,
             sum(signed.qty)::text AS quantity,
             round(sum(signed.net), 2)::text AS total,
             -- The desktop hard-codes 15% (total * 0.15 and total * 1.15); the cloud reads
             -- the tax the line was actually posted with.
             round(sum(signed.tax), 2)::text AS tax,
             round(sum(signed.total), 2)::text AS net,
             round(sum(signed.gross - signed.net), 2)::text AS discount
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      LEFT JOIN item_categories cat ON cat.id = item.category_id
      -- proc_type 1 (بيع) minus proc_type 2 (مرتجع) — the two UNION ALL halves of the
      -- item query in frmRptSalesByCategory.xaml.cs L203 … L240.
      CROSS JOIN LATERAL (
        SELECT CASE WHEN si.kind = 'sale' THEN line.quantity ELSE -line.quantity END AS qty,
               CASE WHEN si.kind = 'sale' THEN line.net ELSE -line.net END AS net,
               CASE WHEN si.kind = 'sale' THEN line.tax ELSE -line.tax END AS tax,
               CASE WHEN si.kind = 'sale' THEN line.total ELSE -line.total END AS total,
               CASE WHEN si.kind = 'sale' THEN line.quantity * line.unit_price ELSE -line.quantity * line.unit_price END AS gross
      ) signed
      WHERE ${movementLinesScope(tenantId, f, null, { invType: true })}
        AND line.item_id IS NOT NULL
      GROUP BY cat.id, cat.name_ar, item.id, item.sku, item.name_ar
      HAVING sum(line.quantity) <> 0
      ORDER BY cat.name_ar, item.name_ar LIMIT 2000`,
  },
  {
    key: 'category-sales-by-day',
    titleAr: 'تقرير المبيعات اليومية للمجموعة',
    group: 'sales',
    hintAr: 'كل مجموعةٍ في يوم: رمزها واسمها واسم اليوم وتاريخها وإجمالي مبيعاتها، ثم «إجمالي المبيعات» تحت الشبكة.',
    // 📄 نوع الفاتورة · 🏢 الفرع · 📦 المجموعة · 📅 من / إلى — the order of the panel (L21 … L92).
    params: [INVOICE_KIND_DOCS, BRANCH, CATEGORY, PERIOD[0]!, PERIOD[1]!],
    columns: [
      text('category_code', 'الرمز'),
      text('category', 'المجموعة'),
      text('day_name', 'اليوم'),
      date('day', 'التاريخ'),
      money('total', 'الإجمالي'),
    ],
    totals: ['total'],
    // «إجمالي المبيعات:» — lblTotal in frmRptCategorySaleByDay.xaml L385.
    grandTotal: { key: 'total', labelAr: 'إجمالي المبيعات' },
    emptyAr: 'لا توجد عمليات بالجدول',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT coalesce(cat.code, '—') AS category_code, coalesce(cat.name_ar, '—') AS category,
             -- SaleDay — parsedDate.ToString("ddd", culture ar) in the .xaml.cs L201.
             ${dayName} AS day_name,
             si.posted_at::date AS day,
             round(sum(CASE WHEN si.kind = 'sale' THEN line.total ELSE -line.total END), 2)::text AS total
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      LEFT JOIN item_categories cat ON cat.id = item.category_id
      WHERE ${movementLinesScope(tenantId, f, null, { invType: true })}
        AND line.item_id IS NOT NULL
      GROUP BY cat.id, cat.code, cat.name_ar, si.posted_at::date
      ORDER BY si.posted_at::date DESC, cat.name_ar LIMIT 2000`,
  },
  {
    key: 'sales-invoices-details',
    titleAr: 'تقرير فواتير المبيعات',
    group: 'sales',
    hintAr: 'كل فاتورةٍ بيعٍ أو مرتجع بسطر: نوعها ورقمها وتاريخها ووقتها وطريقة دفعها وعميلها ونقدها وشبكتها ومجاميعها السبعة ومستودعها وفرعها ومندوبها ومستخدمها.',
    // 🔍 خيارات البحث — 📄 نوع الفاتورة · 💳 نوع الدفع · 🏭 المستودع · 🧑‍💼 المندوب ·
    // 👥 العميل · 🏬 الفرع · 📅 الفترة الزمنية · 🧾 الضريبة · 💵 حالة الدفع · 🔄 نوع العملية.
    params: [INVOICE_KIND_SALES, PAY_METHOD, WAREHOUSE, SALESMAN, PARTY, BRANCH, PERIOD[0]!, TIME_FROM_TO[0]!, PERIOD[1]!, TIME_FROM_TO[1]!, VAT_FILTER, PAYMENT_STATE, OPERATION_KIND],
    columns: invoiceColumns('نوع الفاتورة', 'رقم الفاتورة', 'تاريخ الفاتورة'),
    // 📊 ملخص النتائج — «عدد الفواتير · المجموع · الخصم · الإجمالي · الضريبة · ضريبة
    // إضافية · إجمالي الضريبة · الصافي · نقدي · شبكة · المدفوع» (L1023 … L1110); عدد
    // الفواتير هو عدد سطور الشبكة الذي يطبعه رأس الصفحة أصلاً.
    grandTotal: summaryCards(true),
    emptyAr: 'لا توجد عمليات بالجدول',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT ${invoiceRow}
      FROM sales_invoices si
      LEFT JOIN parties party ON party.id = si.party_id
      LEFT JOIN warehouses warehouse ON warehouse.id = si.warehouse_id
      LEFT JOIN branches branch ON branch.id = si.branch_id
      LEFT JOIN salesmen salesman ON salesman.id = si.salesman_id
      LEFT JOIN users "user" ON "user".id = si.created_by
      ${paymentLegs}
      ${lineGross}
      WHERE ${invoiceScope(tenantId, f, null)}
      ORDER BY si.posted_at DESC, si.number DESC LIMIT 2000`,
  },
  {
    key: 'pos-sales-invoices-details',
    titleAr: 'تقرير مبيعات الفواتير',
    group: 'sales',
    hintAr: 'الشبكة نفسها مقيَّدة بـ`inv.inv_type=3`: فواتير نقطة البيع ومردوداتها وحدها.',
    // 🔍 خيارات البحث عند الديسكتوب: 🔄 نوع العملية · 💵 حالة الدفع · 🏭 المستودع ·
    // 👤 المستخدم · 📅 الفترة الزمنية (المستخدم مؤجَّل: لا مرشِّح عضوية بعد).
    params: [OPERATION_KIND, PAYMENT_STATE, WAREHOUSE, PERIOD[0]!, TIME_FROM_TO[0]!, PERIOD[1]!, TIME_FROM_TO[1]!],
    columns: invoiceColumns('نوع الفاتورة', 'رقم الفاتورة', 'تاريخ الفاتورة'),
    grandTotal: summaryCards(false),
    emptyAr: 'لا توجد عمليات بالجدول',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT ${invoiceRow}
      FROM sales_invoices si
      LEFT JOIN parties party ON party.id = si.party_id
      LEFT JOIN warehouses warehouse ON warehouse.id = si.warehouse_id
      LEFT JOIN branches branch ON branch.id = si.branch_id
      LEFT JOIN salesmen salesman ON salesman.id = si.salesman_id
      LEFT JOIN users "user" ON "user".id = si.created_by
      ${paymentLegs}
      ${lineGross}
      WHERE ${invoiceScope(tenantId, f, true)}
      ORDER BY si.posted_at DESC, si.number DESC LIMIT 2000`,
  },
  {
    key: 'sales-notifications',
    titleAr: 'تقرير الإشعارات',
    group: 'sales',
    hintAr: 'كل إشعارٍ دائن أو مدين بسطر: رقمه وتاريخه ووقته وعميله ونقده وشبكته ومجاميعه، ثم «عدد الإشعارات» ومجاميع الأسفل.',
    // 📄 نوع الإشعار · 🔄 نوع العملية · 👤 المستخدم · 👤 المندوب · 🏢 العميل · 📅 من / إلى.
    params: [NOTIFICATION_KIND, OPERATION_KIND, SALESMAN, PARTY, PERIOD[0]!, TIME_FROM_TO[0]!, PERIOD[1]!, TIME_FROM_TO[1]!],
    columns: invoiceColumns('نوع الإشعار', 'رقم الإشعار', 'تاريخ الإشعار'),
    grandTotal: summaryCards(false),
    emptyAr: 'لا توجد عمليات بالجدول',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT ${invoiceRow}
      FROM sales_invoices si
      LEFT JOIN parties party ON party.id = si.party_id
      LEFT JOIN warehouses warehouse ON warehouse.id = si.warehouse_id
      LEFT JOIN branches branch ON branch.id = si.branch_id
      LEFT JOIN salesmen salesman ON salesman.id = si.salesman_id
      LEFT JOIN users "user" ON "user".id = si.created_by
      ${paymentLegs}
      ${lineGross}
      WHERE ${invoiceScope(tenantId, f, null, { notifications: true })}
      ORDER BY si.posted_at DESC, si.number DESC LIMIT 2000`,
  },
  {
    key: 'purchase-invoices-details',
    titleAr: 'تفاصيل فواتير المشتريات',
    group: 'purchases',
    hintAr: 'كل فاتورة شراء أو مردود بسطر: نوعها ورقمها وتاريخها وموردها ومجاميعها الخمسة ومستودعها وفرعها، ثم «المدفوع» و«المتبقي».',
    // 💰 الضريبة · 🔄 نوع العملية · 🏬 الفرع · 🏢 المورد · 🏪 المستودع · 📅 الفترة.
    params: [VAT_FILTER, OPERATION_KIND, BRANCH, PARTY, WAREHOUSE, PERIOD[0]!, TIME_FROM_TO[0]!, PERIOD[1]!, TIME_FROM_TO[1]!],
    columns: [
      text('invoice_type', 'نوع الفاتورة'),
      text('number', 'رقم الفاتورة'),
      text('reference', 'رقم المرجع'),
      date('day', 'التاريخ'),
      text('time', 'الوقت'),
      text('payment_method', 'نوع الدفع'),
      text('supplier', 'المورد'),
      money('sum_price', 'المجموع'),
      money('discount', 'الخصم'),
      money('subtotal', 'الإجمالي'),
      money('tax', 'الضريبة'),
      money('net', 'الصافي'),
      money('paid', 'المدفوع'),
      money('due', 'المتبقي'),
      text('warehouse', 'المستودع'),
      text('branch', 'الفرع'),
      text('user_name', 'المستخدم'),
      // 💰 مجاميع الفواتير — netted the way CalculateSummary nets them (proc_type 1 − 2).
      { key: 's_sum_price', labelAr: 'المجموع', type: 'money', hidden: true },
      { key: 's_discount', labelAr: 'الخصم', type: 'money', hidden: true },
      { key: 's_subtotal', labelAr: 'الإجمالي', type: 'money', hidden: true },
      { key: 's_tax', labelAr: 'الضريبة', type: 'money', hidden: true },
      { key: 's_net', labelAr: 'الصافي', type: 'money', hidden: true },
    ],
    grandTotal: [
      { key: 's_sum_price', labelAr: 'المجموع' },
      { key: 's_discount', labelAr: 'الخصم' },
      { key: 's_subtotal', labelAr: 'الإجمالي' },
      { key: 's_tax', labelAr: 'الضريبة' },
      { key: 's_net', labelAr: 'الصافي' },
    ],
    signature: true,
    build: (tenantId, f) => sql`
      SELECT CASE pi.kind WHEN 'purchase' THEN 'فاتورة مشتريات' WHEN 'purchase_return' THEN 'مردود مشتريات' ELSE pi.kind END AS invoice_type,
             coalesce(pi.number, '—') AS number, pi.posted_at::date AS day, to_char(pi.posted_at, 'HH24:MI:SS') AS time,
             coalesce(pi.supplier_reference_no, (SELECT ref.number FROM purchase_invoices ref WHERE ref.id = pi.reference_invoice_id), '—') AS reference,
             CASE pi.payment_status
               WHEN 'unpaid' THEN 'آجل'
               WHEN 'paid' THEN CASE
                 WHEN coalesce(alloc.cash, 0) > 0 AND coalesce(alloc.card, 0) = 0 AND coalesce(alloc.bank, 0) = 0 THEN 'نقدي'
                 WHEN coalesce(alloc.card, 0) > 0 AND coalesce(alloc.cash, 0) = 0 AND coalesce(alloc.bank, 0) = 0 THEN 'شبكة'
                 ELSE 'متعدد' END
               ELSE 'متعدد' END AS payment_method,
             ${partyName} AS supplier,
             round(coalesce(lines.gross, 0), 2)::text AS sum_price,
             round(coalesce(lines.gross, 0) - pi.subtotal, 2)::text AS discount,
             pi.subtotal::text AS subtotal, pi.tax_total::text AS tax, pi.total::text AS net,
             pi.paid_total::text AS paid, (pi.total - pi.paid_total)::text AS due,
             coalesce(warehouse.name, '—') AS warehouse, coalesce(branch.name_ar, '—') AS branch,
             coalesce(\"user\".full_name, '—') AS user_name,
             (${purchaseSign} * round(coalesce(lines.gross, 0), 2))::text AS s_sum_price,
             (${purchaseSign} * round(coalesce(lines.gross, 0) - pi.subtotal, 2))::text AS s_discount,
             (${purchaseSign} * pi.subtotal)::text AS s_subtotal,
             (${purchaseSign} * pi.tax_total)::text AS s_tax,
             (${purchaseSign} * pi.total)::text AS s_net
      FROM purchase_invoices pi
      LEFT JOIN parties party ON party.id = pi.party_id
      LEFT JOIN warehouses warehouse ON warehouse.id = pi.warehouse_id
      LEFT JOIN branches branch ON branch.id = pi.branch_id
      LEFT JOIN users \"user\" ON \"user\".id = pi.created_by
      LEFT JOIN LATERAL (
        SELECT sum(l.quantity * l.unit_price) AS gross
        FROM purchase_invoice_lines l
        WHERE l.tenant_id = pi.tenant_id AND l.invoice_id = pi.id
      ) lines ON true
      -- 💳 نوع الدفع — inv.pay_type at the desktop is one flag on the فاتورة; the
      -- cloud settles a شراء بسند صرف through payment_allocations, so the legs of
      -- the سند are summed the same way the three of inv.cash/visa/bank are.
      LEFT JOIN LATERAL (
        SELECT sum(CASE WHEN v.method = 'cash' THEN a.amount ELSE 0 END) AS cash,
               sum(CASE WHEN v.method = 'card' THEN a.amount ELSE 0 END) AS card,
               sum(CASE WHEN v.method = 'bank' THEN a.amount ELSE 0 END) AS bank
        FROM payment_allocations a
        LEFT JOIN vouchers v ON v.id = a.voucher_id
        WHERE a.tenant_id = pi.tenant_id AND a.invoice_id = pi.id
      ) alloc ON true
      WHERE ${purchaseInvoiceScope(tenantId, f)}
      ORDER BY pi.posted_at DESC, pi.number DESC LIMIT 2000`,
  },
  {
    key: 'daily-sales',
    titleAr: 'تقرير مبيعات حسب اليوم',
    group: 'sales',
    hintAr: 'كل يومٍ بسطر: الإجمالي قبل الضريبة وضريبته وإجماليه، واسم اليوم بالعربية كما يسمّيه `ToString("ddd", ar)`.',
    // 📄 نوع الفاتورة · 🏢 الفرع · 📅 من / إلى.
    params: [INVOICE_KIND_DOCS, BRANCH, PERIOD[0]!, PERIOD[1]!],
    columns: [
      int('seq', 'الرقم'),
      date('day', 'التاريخ'),
      text('day_name', 'اليوم'),
      money('before_tax', 'الإجمالي قبل الضريبة'),
      money('tax', 'الضريبة'),
      money('total', 'الإجمالي'),
    ],
    totals: ['before_tax', 'tax', 'total'],
    // «إجمالي قبل الضريبة:» · «إجمالي الضريبة:» · «الإجمالي الكلي:»
    grandTotal: [
      { key: 'before_tax', labelAr: 'إجمالي قبل الضريبة' },
      { key: 'tax', labelAr: 'إجمالي الضريبة' },
      { key: 'total', labelAr: 'الإجمالي الكلي' },
    ],
    emptyAr: 'لا توجد بيانات، أدخل الفترة الزمنية الصحيحة',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT row_number() OVER (ORDER BY daily.day)::text AS seq, daily.*
      FROM (
        SELECT si.posted_at::date AS day, ${dayName} AS day_name,
               round(sum(CASE WHEN si.kind = 'sale' THEN si.subtotal ELSE -si.subtotal END), 2)::text AS before_tax,
               round(sum(CASE WHEN si.kind = 'sale' THEN si.tax_total ELSE -si.tax_total END), 2)::text AS tax,
               round(sum(CASE WHEN si.kind = 'sale' THEN si.total ELSE -si.total END), 2)::text AS total
        FROM sales_invoices si
        WHERE ${movementScope(tenantId, f)}
        GROUP BY si.posted_at::date
      ) daily
      ORDER BY day LIMIT 2000`,
  },
  {
    key: 'daily-process',
    titleAr: 'تقرير الحركة اليومية',
    group: 'sales',
    hintAr: 'ستة أنواع حركة بستة أسطر: عدد فواتير كل نوع وإجماليه، وما منه نقديّ وما منه آجل.',
    // 🏢 الفرع · 📅 من / إلى + وقت — 🏦 الصندوق و👤 المستخدم مؤجَّلان (§6.5).
    params: [BRANCH, PERIOD[0]!, TIME_FROM_TO[0]!, PERIOD[1]!, TIME_FROM_TO[1]!],
    columns: [
      text('operation', 'نوع العملية'),
      int('invoices', 'عدد الفواتير'),
      money('total', 'الإجمالي'),
      money('cash', 'نقدي'),
      money('credit', 'آجل'),
      { key: 'sort', labelAr: 'الترتيب', type: 'int', hidden: true },
    ],
    totals: ['invoices', 'total', 'cash', 'credit'],
    signature: true,
    build: (tenantId, f) => sql`
      SELECT operation, invoices, total, cash, credit, sort FROM (
        SELECT 1 AS sort, 'مبيعات' AS operation, count(*)::text AS invoices,
               round(coalesce(sum(si.total), 0), 2)::text AS total,
               round(coalesce(sum(CASE WHEN si.payment_status <> 'unpaid' THEN si.total ELSE 0 END), 0), 2)::text AS cash,
               round(coalesce(sum(CASE WHEN si.payment_status = 'unpaid' THEN si.total ELSE 0 END), 0), 2)::text AS credit
        FROM sales_invoices si WHERE ${dailyScope(tenantId, f, 'sale', true)}
        UNION ALL
        SELECT 2, 'مرتجع مبيعات', count(*)::text,
               round(coalesce(sum(si.total), 0), 2)::text,
               round(coalesce(sum(CASE WHEN si.payment_status <> 'unpaid' THEN si.total ELSE 0 END), 0), 2)::text,
               round(coalesce(sum(CASE WHEN si.payment_status = 'unpaid' THEN si.total ELSE 0 END), 0), 2)::text
        FROM sales_invoices si WHERE ${dailyScope(tenantId, f, 'sale_return', true)}
        UNION ALL
        SELECT 3, 'نقطة البيع', count(*)::text,
               round(coalesce(sum(si.total), 0), 2)::text,
               round(coalesce(sum(CASE WHEN si.payment_status <> 'unpaid' THEN si.total ELSE 0 END), 0), 2)::text,
               round(coalesce(sum(CASE WHEN si.payment_status = 'unpaid' THEN si.total ELSE 0 END), 0), 2)::text
        FROM sales_invoices si WHERE ${dailyScope(tenantId, f, 'sale', false)}
        UNION ALL
        SELECT 4, 'مرتجع نقطة البيع', count(*)::text,
               round(coalesce(sum(si.total), 0), 2)::text,
               round(coalesce(sum(CASE WHEN si.payment_status <> 'unpaid' THEN si.total ELSE 0 END), 0), 2)::text,
               round(coalesce(sum(CASE WHEN si.payment_status = 'unpaid' THEN si.total ELSE 0 END), 0), 2)::text
        FROM sales_invoices si WHERE ${dailyScope(tenantId, f, 'sale_return', false)}
        UNION ALL
        SELECT 5, 'مشتريات', count(*)::text,
               round(coalesce(sum(pi.total), 0), 2)::text,
               round(coalesce(sum(CASE WHEN pi.payment_status <> 'unpaid' THEN pi.total ELSE 0 END), 0), 2)::text,
               round(coalesce(sum(CASE WHEN pi.payment_status = 'unpaid' THEN pi.total ELSE 0 END), 0), 2)::text
        FROM purchase_invoices pi WHERE ${dailyPurchaseScope(tenantId, f, 'purchase')}
        UNION ALL
        SELECT 6, 'مرتجع مشتريات', count(*)::text,
               round(coalesce(sum(pi.total), 0), 2)::text,
               round(coalesce(sum(CASE WHEN pi.payment_status <> 'unpaid' THEN pi.total ELSE 0 END), 0), 2)::text,
               round(coalesce(sum(CASE WHEN pi.payment_status = 'unpaid' THEN pi.total ELSE 0 END), 0), 2)::text
        FROM purchase_invoices pi WHERE ${dailyPurchaseScope(tenantId, f, 'purchase_return')}
      ) movements
      ORDER BY sort LIMIT 2000`,
  },
  {
    // The cloud already had a sales-analysis («أفضل الأصناف مبيعاً», one row per صنف with
    // a share of the total); this one is the desktop's eight-way تحليل of frmRptInvAnalysis.
    key: 'sales-inv-analysis',
    titleAr: 'تقرير تحليل المبيعات',
    group: 'sales',
    hintAr: 'صافي الكمية والإجمالي والخصم والتكلفة والربح مجمَّعةً على البعد الذي تختاره (المخزن · العميل · الصنف · المندوب · المستخدم · اليوم · الشهر · مجموعة الصنف)، ونسبتان من الإجمالي العام.',
    // 📋 نوع التقرير · 👤 المستخدم · 🧑‍💼 العميل · 📦 مجموعة الصنف · 🤝 مندوب البيع ·
    // 🏭 المستودع · 📅 الفترة — 🏦 الصندوق مؤجَّل (§6.5).
    params: [ANALYSIS_DIMENSION, PARTY, CATEGORY, SALESMAN, WAREHOUSE, PERIOD[0]!, PERIOD[1]!],
    columns: [
      text('dimension', 'البعد'),
      int('invoices', 'فواتير'),
      qty('net_quantity', 'صافي الكمية'),
      money('net_total', 'صافي الإجمالي'),
      money('net_discount', 'صافي الخصم'),
      money('net_cost', 'صافي التكلفة'),
      money('net_profit', 'صافي الربح'),
      percent('profit_to_cost', 'نسبة الربح للتكلفة'),
      percent('share_of_sales', 'نسبة الاجمالي لإجمالي البيع'),
      percent('share_of_profit', 'نسبة الربح لإجمالي الربح'),
    ],
    totals: ['invoices', 'net_quantity', 'net_total', 'net_discount', 'net_cost', 'net_profit'],
    // 📦 صافي الكمية · 💰 صافي الإجمالي · 🏷️ صافي الخصم · 💳 صافي التكلفة · 📈 صافي الربح
    grandTotal: [
      { key: 'net_quantity', labelAr: 'صافي الكمية' },
      { key: 'net_total', labelAr: 'صافي الإجمالي' },
      { key: 'net_discount', labelAr: 'صافي الخصم' },
      { key: 'net_cost', labelAr: 'صافي التكلفة' },
      { key: 'net_profit', labelAr: 'صافي الربح' },
    ],
    signature: true,
    build: (tenantId, f) => sql`
      SELECT ${analysisDimension(f.dimension)} AS dimension,
             count(DISTINCT si.id)::text AS invoices,
             sum(signed.qty)::text AS net_quantity,
             round(sum(signed.net), 2)::text AS net_total,
             round(sum(signed.gross - signed.net), 2)::text AS net_discount,
             round(sum(signed.cost), 2)::text AS net_cost,
             round(sum(signed.net) - sum(signed.cost), 2)::text AS net_profit,
             round(CASE WHEN sum(signed.cost) = 0 THEN 0 ELSE (sum(signed.net) - sum(signed.cost)) / sum(signed.cost) * 100 END, 2)::text AS profit_to_cost,
             round(sum(signed.net) / nullif(sum(sum(signed.net)) OVER (), 0) * 100, 2)::text AS share_of_sales,
             round((sum(signed.net) - sum(signed.cost)) / nullif(sum(sum(signed.net) - sum(signed.cost)) OVER (), 0) * 100, 2)::text AS share_of_profit
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      LEFT JOIN item_categories cat ON cat.id = item.category_id
      LEFT JOIN parties party ON party.id = si.party_id
      LEFT JOIN salesmen salesman ON salesman.id = si.salesman_id
      LEFT JOIN warehouses warehouse ON warehouse.id = si.warehouse_id
      LEFT JOIN users "user" ON "user".id = si.created_by
      CROSS JOIN LATERAL (
        SELECT CASE WHEN si.kind = 'sale' THEN line.quantity ELSE -line.quantity END AS qty,
               CASE WHEN si.kind = 'sale' THEN line.net ELSE -line.net END AS net,
               CASE WHEN si.kind = 'sale' THEN line.quantity * line.unit_price ELSE -line.quantity * line.unit_price END AS gross,
               CASE WHEN si.kind = 'sale' THEN line.cost_total ELSE -line.cost_total END AS cost
      ) signed
      WHERE ${movementLinesScope(tenantId, f, null)}
        AND line.item_id IS NOT NULL
      GROUP BY ${analysisDimension(f.dimension)}
      ORDER BY net_total DESC LIMIT 2000`,
  },
  // ------------------------------------------------------------ purchases
  {
    key: 'purchase-invoices',
    titleAr: 'تقرير فواتير المشتريات',
    group: 'purchases',
    params: [...PERIOD, BRANCH, PARTY],
    columns: [text('number', 'الرقم'), date('day', 'التاريخ'), text('party', 'المورد'), text('branch', 'الفرع'), money('subtotal', 'الصافي'), money('tax_total', 'الضريبة'), money('additional_cost_total', 'مصاريف'), money('total', 'الإجمالي'), money('due', 'المتبقي')],
    totals: ['subtotal', 'tax_total', 'additional_cost_total', 'total', 'due'],
    build: (tenantId, f) => sql`
      SELECT pi.number, pi.posted_at::date AS day, ${partyName} AS party, ${branchName} AS branch,
             pi.subtotal::text, pi.tax_total::text, pi.additional_cost_total::text, pi.total::text,
             (pi.total - pi.paid_total)::text AS due
      FROM purchase_invoices pi
      LEFT JOIN parties party ON party.id = pi.party_id
      LEFT JOIN branches branch ON branch.id = pi.branch_id
      WHERE ${purchaseScope(tenantId, f, 'purchase')}
      ORDER BY pi.posted_at DESC LIMIT 1000`,
  },
  {
    key: 'purchase-returns',
    titleAr: 'تقرير مردود المشتريات',
    group: 'purchases',
    params: [...PERIOD, BRANCH, PARTY],
    columns: [text('number', 'الرقم'), date('day', 'التاريخ'), text('party', 'المورد'), money('subtotal', 'الصافي'), money('tax_total', 'الضريبة'), money('total', 'الإجمالي')],
    totals: ['subtotal', 'tax_total', 'total'],
    build: (tenantId, f) => sql`
      SELECT pi.number, pi.posted_at::date AS day, ${partyName} AS party,
             pi.subtotal::text, pi.tax_total::text, pi.total::text
      FROM purchase_invoices pi
      LEFT JOIN parties party ON party.id = pi.party_id
      WHERE ${purchaseScope(tenantId, f, 'purchase_return')}
      ORDER BY pi.posted_at DESC LIMIT 1000`,
  },
  {
    key: 'net-purchases',
    titleAr: 'صافي المشتريات',
    group: 'purchases',
    params: [...PERIOD, BRANCH],
    columns: [date('day', 'اليوم'), money('purchases', 'المشتريات'), money('returns', 'المردودات'), money('net', 'الصافي')],
    totals: ['purchases', 'returns', 'net'],
    chart: 'bar',
    build: (tenantId, f) => sql`
      SELECT pi.posted_at::date AS day,
             sum(CASE WHEN pi.kind = 'purchase' THEN pi.total ELSE 0 END)::text AS purchases,
             sum(CASE WHEN pi.kind = 'purchase_return' THEN pi.total ELSE 0 END)::text AS returns,
             sum(CASE WHEN pi.kind = 'purchase' THEN pi.total ELSE -pi.total END)::text AS net
      FROM purchase_invoices pi
      WHERE pi.tenant_id = ${tenantId} AND pi.status = 'posted' AND pi.kind IN ('purchase', 'purchase_return')
        AND ${onDate(sql`pi.posted_at::date`, f.from, f.to)} AND ${eqIf(sql`pi.branch_id`, f.branchId)}
      GROUP BY pi.posted_at::date ORDER BY day`,
  },
  {
    key: 'purchases-detail',
    titleAr: 'مشتريات تفصيلية',
    group: 'purchases',
    params: [...PERIOD, BRANCH, PARTY, ITEM],
    columns: [text('number', 'الفاتورة'), date('day', 'التاريخ'), text('party', 'المورد'), text('item', 'الصنف'), qty('quantity', 'الكمية'), money('unit_price', 'السعر'), money('net', 'الصافي'), money('allocated_cost', 'مصاريف موزعة'), money('landed_total', 'التكلفة النهائية')],
    totals: ['quantity', 'net', 'allocated_cost', 'landed_total'],
    build: (tenantId, f) => sql`
      SELECT pi.number, pi.posted_at::date AS day, ${partyName} AS party, ${itemName} AS item,
             line.quantity::text, line.unit_price::text, line.net::text,
             line.allocated_cost::text, line.landed_total::text
      FROM purchase_invoice_lines line
      JOIN purchase_invoices pi ON pi.id = line.invoice_id
      LEFT JOIN parties party ON party.id = pi.party_id
      LEFT JOIN items item ON item.id = line.item_id
      WHERE ${purchaseScope(tenantId, f, 'purchase')} AND ${eqIf(sql`line.item_id`, f.itemId)}
      ORDER BY pi.posted_at DESC, line.line_no LIMIT 2000`,
  },
  {
    key: 'purchases-by-item',
    titleAr: 'مشتريات الأصناف تجميعي',
    group: 'purchases',
    params: [...PERIOD, BRANCH, CATEGORY],
    columns: [text('sku', 'الرمز'), text('item', 'الصنف'), qty('quantity', 'الكمية'), money('net', 'الصافي'), money('landed_total', 'التكلفة النهائية'), money('avg_cost', 'متوسط التكلفة')],
    totals: ['quantity', 'net', 'landed_total'],
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS sku, ${itemName} AS item, sum(line.quantity)::text AS quantity,
             sum(line.net)::text AS net, sum(line.landed_total)::text AS landed_total,
             CASE WHEN sum(line.quantity) = 0 THEN '0' ELSE round(sum(line.landed_total) / sum(line.quantity), 4)::text END AS avg_cost
      FROM purchase_invoice_lines line
      JOIN purchase_invoices pi ON pi.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      WHERE ${purchaseScope(tenantId, f, 'purchase')} AND ${eqIf(sql`item.category_id`, f.categoryId)}
      GROUP BY item.sku, item.name_ar ORDER BY sum(line.landed_total) DESC LIMIT 500`,
  },
  {
    key: 'invoices-by-supplier',
    titleAr: 'الفواتير بحسب الموردين',
    group: 'purchases',
    params: [...PERIOD, BRANCH],
    columns: [text('party', 'المورد'), int('invoices', 'عدد الفواتير'), money('total', 'الإجمالي'), money('paid_total', 'المسدد'), money('due', 'المتبقي')],
    totals: ['invoices', 'total', 'paid_total', 'due'],
    build: (tenantId, f) => sql`
      SELECT ${partyName} AS party, count(*)::text AS invoices, sum(pi.total)::text AS total,
             sum(pi.paid_total)::text AS paid_total, sum(pi.total - pi.paid_total)::text AS due
      FROM purchase_invoices pi
      LEFT JOIN parties party ON party.id = pi.party_id
      WHERE ${purchaseScope(tenantId, f, 'purchase')}
      GROUP BY party.name ORDER BY sum(pi.total) DESC`,
  },
  {
    key: 'supplier-balances',
    titleAr: 'أرصدة الموردين',
    group: 'purchases',
    params: [],
    columns: [text('code', 'الرمز'), text('party', 'المورد'), money('debit', 'مدين'), money('credit', 'دائن'), money('balance', 'الرصيد')],
    totals: ['debit', 'credit', 'balance'],
    build: (tenantId) => sql`
      SELECT party.code, party.name AS party, sum(jel.debit)::text AS debit, sum(jel.credit)::text AS credit,
             (sum(jel.credit) - sum(jel.debit))::text AS balance
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.entry_id
      JOIN parties party ON party.id = jel.party_id
      WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted' AND party.kind IN ('supplier', 'both')
      GROUP BY party.code, party.name
      HAVING sum(jel.debit) <> sum(jel.credit) ORDER BY party.code`,
  },
  {
    key: 'supplier-settlements',
    titleAr: 'سداد الموردين',
    group: 'purchases',
    params: [...PERIOD, PARTY],
    columns: [date('day', 'التاريخ'), text('party', 'المورد'), text('number', 'السند'), text('method', 'الطريقة'), money('amount', 'المبلغ')],
    totals: ['amount'],
    build: (tenantId, f) => sql`
      SELECT v.date AS day, coalesce(party.name, '—') AS party, coalesce(v.number, '—') AS number, v.method, v.amount::text
      FROM vouchers v
      LEFT JOIN parties party ON party.id = v.party_id
      WHERE v.tenant_id = ${tenantId} AND v.kind = 'payment' AND v.status = 'posted'
        AND ${onDate(sql`v.date`, f.from, f.to)} AND ${eqIf(sql`v.party_id`, f.partyId)}
      ORDER BY v.date DESC LIMIT 1000`,
  },

  // ------------------------------------------------------------ inventory
  {
    key: 'inventory-valuation',
    titleAr: 'جرد المواد وتقييم المخزون',
    group: 'inventory',
    params: [WAREHOUSE, CATEGORY, ITEM],
    columns: [text('sku', 'الرمز'), text('item', 'الصنف'), text('warehouse', 'المستودع'), qty('quantity', 'الرصيد'), money('average_cost', 'متوسط التكلفة'), money('value', 'القيمة')],
    totals: ['quantity', 'value'],
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS sku, ${itemName} AS item, coalesce(wh.name, '—') AS warehouse,
             sb.quantity::text, sb.average_cost::text, sb.value::text
      FROM stock_balances sb
      LEFT JOIN items item ON item.id = sb.item_id
      LEFT JOIN warehouses wh ON wh.id = sb.warehouse_id
      WHERE sb.tenant_id = ${tenantId} AND ${eqIf(sql`sb.warehouse_id`, f.warehouseId)}
        AND ${eqIf(sql`sb.item_id`, f.itemId)} AND ${eqIf(sql`item.category_id`, f.categoryId)}
      ORDER BY item.name_ar LIMIT 1000`,
  },
  {
    key: 'item-movement',
    titleAr: 'حركة مادة تفصيلي',
    group: 'inventory',
    params: [...PERIOD, WAREHOUSE, ITEM],
    columns: [date('day', 'التاريخ'), text('item', 'الصنف'), text('warehouse', 'المستودع'), text('doc_type', 'المستند'), text('direction', 'الاتجاه'), qty('qty', 'الكمية'), money('unit_cost', 'تكلفة الوحدة'), money('total_cost', 'القيمة')],
    totals: ['qty', 'total_cost'],
    build: (tenantId, f) => sql`
      SELECT tx.occurred_at::date AS day, ${itemName} AS item, coalesce(wh.name, '—') AS warehouse,
             tx.doc_type, tx.direction, tx.qty::text, tx.unit_cost::text, tx.total_cost::text
      FROM inventory_transactions tx
      LEFT JOIN items item ON item.id = tx.item_id
      LEFT JOIN warehouses wh ON wh.id = tx.warehouse_id
      WHERE tx.tenant_id = ${tenantId} AND ${onDate(sql`tx.occurred_at::date`, f.from, f.to)}
        AND ${eqIf(sql`tx.warehouse_id`, f.warehouseId)} AND ${eqIf(sql`tx.item_id`, f.itemId)}
      ORDER BY tx.occurred_at DESC LIMIT 2000`,
  },
  {
    key: 'item-movement-summary',
    titleAr: 'حركة مواد تجميعي',
    group: 'inventory',
    params: [...PERIOD, WAREHOUSE, CATEGORY],
    columns: [text('sku', 'الرمز'), text('item', 'الصنف'), qty('in_qty', 'وارد'), qty('out_qty', 'صادر'), qty('net_qty', 'الصافي'), money('in_value', 'قيمة الوارد'), money('out_value', 'قيمة الصادر')],
    totals: ['in_qty', 'out_qty', 'net_qty', 'in_value', 'out_value'],
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS sku, ${itemName} AS item,
             sum(CASE WHEN tx.direction = 'in' THEN tx.qty ELSE 0 END)::text AS in_qty,
             sum(CASE WHEN tx.direction = 'out' THEN tx.qty ELSE 0 END)::text AS out_qty,
             sum(CASE WHEN tx.direction = 'in' THEN tx.qty ELSE -tx.qty END)::text AS net_qty,
             sum(CASE WHEN tx.direction = 'in' THEN tx.total_cost ELSE 0 END)::text AS in_value,
             sum(CASE WHEN tx.direction = 'out' THEN tx.total_cost ELSE 0 END)::text AS out_value
      FROM inventory_transactions tx
      LEFT JOIN items item ON item.id = tx.item_id
      WHERE tx.tenant_id = ${tenantId} AND ${onDate(sql`tx.occurred_at::date`, f.from, f.to)}
        AND ${eqIf(sql`tx.warehouse_id`, f.warehouseId)} AND ${eqIf(sql`item.category_id`, f.categoryId)}
      GROUP BY item.sku, item.name_ar ORDER BY item.name_ar LIMIT 1000`,
  },
  {
    key: 'inventory-turnover',
    titleAr: 'معدل الدوران والركود',
    group: 'inventory',
    hintAr: 'معدل الدوران = قيمة الصادر خلال الفترة ÷ قيمة المخزون الحالي. الأصناف بلا حركة هي الراكدة.',
    params: [...PERIOD, WAREHOUSE, CATEGORY],
    columns: [text('sku', 'الرمز'), text('item', 'الصنف'), qty('on_hand', 'الرصيد'), money('stock_value', 'قيمة المخزون'), money('out_value', 'قيمة المصروف'), text('turnover', 'معدل الدوران'), int('idle_days', 'أيام الركود')],
    totals: ['on_hand', 'stock_value', 'out_value'],
    build: (tenantId, f) => sql`
      WITH stock AS (
        SELECT sb.item_id, sum(sb.quantity) AS quantity, sum(sb.value) AS value
        FROM stock_balances sb
        WHERE sb.tenant_id = ${tenantId} AND ${eqIf(sql`sb.warehouse_id`, f.warehouseId)}
        GROUP BY sb.item_id
      ), moves AS (
        SELECT tx.item_id,
               sum(CASE WHEN tx.direction = 'out' THEN tx.total_cost ELSE 0 END) AS out_value,
               max(tx.occurred_at) AS last_move
        FROM inventory_transactions tx
        WHERE tx.tenant_id = ${tenantId} AND ${onDate(sql`tx.occurred_at::date`, f.from, f.to)}
          AND ${eqIf(sql`tx.warehouse_id`, f.warehouseId)}
        GROUP BY tx.item_id
      )
      SELECT coalesce(item.sku, '—') AS sku, ${itemName} AS item,
             coalesce(stock.quantity, 0)::text AS on_hand, coalesce(stock.value, 0)::text AS stock_value,
             coalesce(moves.out_value, 0)::text AS out_value,
             CASE WHEN coalesce(stock.value, 0) = 0 THEN '—'
                  ELSE round(coalesce(moves.out_value, 0) / stock.value, 2)::text END AS turnover,
             CASE WHEN moves.last_move IS NULL THEN '—'
                  ELSE extract(day FROM now() - moves.last_move)::int::text END AS idle_days
      FROM items item
      LEFT JOIN stock ON stock.item_id = item.id
      LEFT JOIN moves ON moves.item_id = item.id
      WHERE item.tenant_id = ${tenantId} AND item.deleted_at IS NULL AND ${eqIf(sql`item.category_id`, f.categoryId)}
      ORDER BY coalesce(moves.out_value, 0) ASC, item.name_ar LIMIT 1000`,
  },
  {
    key: 'sales-analysis',
    titleAr: 'تحليل المبيعات',
    group: 'inventory',
    hintAr: 'مساهمة كل صنف في إجمالي مبيعات الفترة.',
    params: [...PERIOD, BRANCH, CATEGORY],
    columns: [text('sku', 'الرمز'), text('item', 'الصنف'), qty('quantity', 'الكمية'), money('revenue', 'الإيراد'), percent('share', 'نسبة المساهمة')],
    totals: ['quantity', 'revenue'],
    build: (tenantId, f) => sql`
      WITH sold AS (
        SELECT line.item_id, sum(line.quantity) AS quantity, sum(line.net) AS revenue
        FROM sales_invoice_lines line
        JOIN sales_invoices si ON si.id = line.invoice_id
        WHERE ${salesScope(tenantId, f, 'sale')}
        GROUP BY line.item_id
      )
      SELECT coalesce(item.sku, '—') AS sku, ${itemName} AS item, sold.quantity::text, sold.revenue::text,
             CASE WHEN (SELECT sum(revenue) FROM sold) = 0 THEN '0'
                  ELSE round(sold.revenue / (SELECT sum(revenue) FROM sold) * 100, 2)::text END AS share
      FROM sold LEFT JOIN items item ON item.id = sold.item_id
      WHERE ${eqIf(sql`item.category_id`, f.categoryId)}
      ORDER BY sold.revenue DESC LIMIT 500`,
  },
  {
    key: 'sales-purchases-total',
    titleAr: 'إجمالي المبيعات والمشتريات',
    group: 'inventory',
    params: [...PERIOD, BRANCH],
    columns: [date('month', 'الشهر'), money('sales', 'المبيعات'), money('purchases', 'المشتريات'), money('gap', 'الفرق')],
    totals: ['sales', 'purchases', 'gap'],
    chart: 'bar',
    build: (tenantId, f) => sql`
      WITH s AS (
        SELECT date_trunc('month', si.posted_at)::date AS month, sum(si.total) AS total
        FROM sales_invoices si WHERE ${salesScope(tenantId, f, 'sale')} GROUP BY 1
      ), p AS (
        SELECT date_trunc('month', pi.posted_at)::date AS month, sum(pi.total) AS total
        FROM purchase_invoices pi WHERE ${purchaseScope(tenantId, f, 'purchase')} GROUP BY 1
      )
      SELECT coalesce(s.month, p.month) AS month, coalesce(s.total, 0)::text AS sales,
             coalesce(p.total, 0)::text AS purchases, (coalesce(s.total, 0) - coalesce(p.total, 0))::text AS gap
      FROM s FULL OUTER JOIN p ON p.month = s.month ORDER BY month`,
  },
  {
    key: 'invoices-by-type',
    titleAr: 'الفواتير بحسب النوع',
    group: 'inventory',
    params: [...PERIOD, BRANCH],
    columns: [text('doc', 'المستند'), int('count', 'العدد'), money('total', 'الإجمالي')],
    totals: ['count', 'total'],
    build: (tenantId, f) => sql`
      SELECT doc, count(*)::text AS count, sum(total)::text AS total FROM (
        SELECT CASE si.kind WHEN 'sale' THEN 'فاتورة مبيعات' ELSE 'مردود مبيعات' END AS doc, si.total
        FROM sales_invoices si
        WHERE si.tenant_id = ${tenantId} AND si.status = 'posted'
          AND ${onDate(sql`si.posted_at::date`, f.from, f.to)} AND ${eqIf(sql`si.branch_id`, f.branchId)}
        UNION ALL
        SELECT CASE pi.kind WHEN 'purchase' THEN 'فاتورة مشتريات' ELSE 'مردود مشتريات' END AS doc, pi.total
        FROM purchase_invoices pi
        WHERE pi.tenant_id = ${tenantId} AND pi.status = 'posted'
          AND ${onDate(sql`pi.posted_at::date`, f.from, f.to)} AND ${eqIf(sql`pi.branch_id`, f.branchId)}
      ) docs GROUP BY doc ORDER BY doc`,
  },
  {
    key: 'expiry-report',
    titleAr: 'صلاحية المواد',
    group: 'inventory',
    hintAr: 'الأيام المتبقية سالبة تعني أن الدفعة منتهية الصلاحية.',
    params: [ITEM],
    columns: [text('sku', 'الرمز'), text('item', 'الصنف'), text('lot_no', 'رقم الدفعة'), date('expiry_date', 'تاريخ الانتهاء'), int('days_left', 'الأيام المتبقية')],
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS sku, ${itemName} AS item, lot.lot_no, lot.expiry_date,
             CASE WHEN lot.expiry_date IS NULL THEN '—' ELSE (lot.expiry_date - current_date)::text END AS days_left
      FROM item_lots lot
      LEFT JOIN items item ON item.id = lot.item_id
      WHERE lot.tenant_id = ${tenantId} AND lot.deleted_at IS NULL AND ${eqIf(sql`lot.item_id`, f.itemId)}
      ORDER BY lot.expiry_date NULLS LAST LIMIT 1000`,
  },
  {
    key: 'expired-items',
    titleAr: 'انتهاء صلاحية الأصناف',
    group: 'inventory',
    hintAr: 'الدفعات المنتهية أو التي تنتهي خلال 30 يوماً.',
    params: [],
    columns: [text('sku', 'الرمز'), text('item', 'الصنف'), text('lot_no', 'رقم الدفعة'), date('expiry_date', 'تاريخ الانتهاء'), int('days_left', 'الأيام المتبقية')],
    build: (tenantId) => sql`
      SELECT coalesce(item.sku, '—') AS sku, ${itemName} AS item, lot.lot_no, lot.expiry_date,
             (lot.expiry_date - current_date)::text AS days_left
      FROM item_lots lot
      LEFT JOIN items item ON item.id = lot.item_id
      WHERE lot.tenant_id = ${tenantId} AND lot.deleted_at IS NULL
        AND lot.expiry_date IS NOT NULL AND lot.expiry_date <= current_date + 30
      ORDER BY lot.expiry_date LIMIT 1000`,
  },
  {
    key: 'serial-tracking',
    titleAr: 'تقرير الأرقام التسلسلية',
    group: 'inventory',
    params: [ITEM, WAREHOUSE],
    columns: [text('serial_no', 'الرقم التسلسلي'), text('item', 'الصنف'), text('warehouse', 'المستودع'), text('status', 'الحالة')],
    build: (tenantId, f) => sql`
      SELECT s.serial_no, ${itemName} AS item, coalesce(wh.name, '—') AS warehouse, s.status
      FROM item_serials s
      LEFT JOIN items item ON item.id = s.item_id
      LEFT JOIN warehouses wh ON wh.id = s.warehouse_id
      WHERE s.tenant_id = ${tenantId} AND s.deleted_at IS NULL
        AND ${eqIf(sql`s.item_id`, f.itemId)} AND ${eqIf(sql`s.warehouse_id`, f.warehouseId)}
      ORDER BY s.serial_no LIMIT 1000`,
  },
  {
    key: 'stock-limits',
    titleAr: 'الأصناف تحت الحد الأدنى',
    group: 'inventory',
    params: [WAREHOUSE],
    columns: [text('sku', 'الرمز'), text('item', 'الصنف'), qty('on_hand', 'الرصيد'), qty('min_qty', 'الحد الأدنى'), qty('shortfall', 'العجز')],
    totals: ['shortfall'],
    build: (tenantId, f) => sql`
      SELECT item.sku, item.name_ar AS item, coalesce(stock.quantity, 0)::text AS on_hand,
             item.min_qty::text, (item.min_qty - coalesce(stock.quantity, 0))::text AS shortfall
      FROM items item
      LEFT JOIN (
        SELECT sb.item_id, sum(sb.quantity) AS quantity FROM stock_balances sb
        WHERE sb.tenant_id = ${tenantId} AND ${eqIf(sql`sb.warehouse_id`, f.warehouseId)} GROUP BY sb.item_id
      ) stock ON stock.item_id = item.id
      WHERE item.tenant_id = ${tenantId} AND item.deleted_at IS NULL AND item.min_qty > 0
        AND coalesce(stock.quantity, 0) < item.min_qty
      ORDER BY (item.min_qty - coalesce(stock.quantity, 0)) DESC LIMIT 500`,
  },

  // ----------------------------------------------------------- accounting
  {
    key: 'trial-balance',
    titleAr: 'ميزان المراجعة',
    group: 'accounting',
    params: [...PERIOD, BRANCH],
    columns: [text('code', 'رقم الحساب'), text('account', 'الحساب'), money('debit', 'مدين'), money('credit', 'دائن'), money('balance', 'الرصيد')],
    totals: ['debit', 'credit', 'balance'],
    build: (tenantId, f) => sql`
      SELECT acc.code, acc.name_ar AS account, sum(jel.debit)::text AS debit, sum(jel.credit)::text AS credit,
             (sum(jel.debit) - sum(jel.credit))::text AS balance
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.entry_id
      JOIN accounts acc ON acc.id = jel.account_id
      WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted'
        AND ${onDate(sql`je.date`, f.from, f.to)} AND ${eqIf(sql`je.branch_id`, f.branchId)}
      GROUP BY acc.code, acc.name_ar ORDER BY acc.code`,
  },
  {
    key: 'general-ledger',
    titleAr: 'الحركة اليومية (دفتر الأستاذ)',
    group: 'accounting',
    params: [...PERIOD, BRANCH, COST_CENTER],
    columns: [date('day', 'التاريخ'), text('number', 'القيد'), text('code', 'الحساب'), text('account', 'اسم الحساب'), text('description', 'البيان'), money('debit', 'مدين'), money('credit', 'دائن')],
    totals: ['debit', 'credit'],
    build: (tenantId, f) => sql`
      SELECT je.date AS day, coalesce(je.number, '—') AS number, acc.code, acc.name_ar AS account,
             coalesce(jel.description, je.description, '—') AS description, jel.debit::text, jel.credit::text
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.entry_id
      JOIN accounts acc ON acc.id = jel.account_id
      WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted'
        AND ${onDate(sql`je.date`, f.from, f.to)} AND ${eqIf(sql`je.branch_id`, f.branchId)}
        AND ${eqIf(sql`jel.cost_center_id`, f.costCenterId)}
      ORDER BY je.date DESC, je.number DESC, jel.line_no LIMIT 2000`,
  },
  {
    key: 'cash-movement',
    titleAr: 'حركة الصندوق',
    group: 'accounting',
    hintAr: 'القبض والصرف المرحّل لكل صندوق أو بنك.',
    params: [...PERIOD, BRANCH],
    columns: [text('location', 'الصندوق / البنك'), money('receipts', 'قبض'), money('payments', 'صرف'), money('net', 'الصافي')],
    totals: ['receipts', 'payments', 'net'],
    build: (tenantId, f) => sql`
      SELECT coalesce(cl.name, '—') AS location,
             sum(CASE WHEN v.kind = 'receipt' THEN v.amount ELSE 0 END)::text AS receipts,
             sum(CASE WHEN v.kind = 'payment' THEN v.amount ELSE 0 END)::text AS payments,
             sum(CASE WHEN v.kind = 'receipt' THEN v.amount ELSE -v.amount END)::text AS net
      FROM vouchers v
      LEFT JOIN cash_locations cl ON cl.id = v.cash_location_id
      WHERE v.tenant_id = ${tenantId} AND v.status = 'posted'
        AND ${onDate(sql`v.date`, f.from, f.to)} AND ${eqIf(sql`v.branch_id`, f.branchId)}
      GROUP BY cl.name ORDER BY cl.name`,
  },
  {
    key: 'cost-center-balances',
    titleAr: 'أرصدة مراكز التكلفة',
    group: 'accounting',
    params: [...PERIOD],
    columns: [text('code', 'الرمز'), text('cost_center', 'مركز التكلفة'), money('debit', 'مدين'), money('credit', 'دائن'), money('balance', 'الرصيد')],
    totals: ['debit', 'credit', 'balance'],
    build: (tenantId, f) => sql`
      SELECT cc.code, cc.name_ar AS cost_center, sum(jel.debit)::text AS debit, sum(jel.credit)::text AS credit,
             (sum(jel.debit) - sum(jel.credit))::text AS balance
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.entry_id
      JOIN cost_centers cc ON cc.id = jel.cost_center_id
      WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted' AND ${onDate(sql`je.date`, f.from, f.to)}
      GROUP BY cc.code, cc.name_ar ORDER BY cc.code`,
  },
  {
    key: 'cost-center-report',
    titleAr: 'تقرير مركز الكلفة',
    group: 'accounting',
    params: [...PERIOD, COST_CENTER],
    columns: [date('day', 'التاريخ'), text('cost_center', 'مركز التكلفة'), text('account', 'الحساب'), text('description', 'البيان'), money('debit', 'مدين'), money('credit', 'دائن')],
    totals: ['debit', 'credit'],
    build: (tenantId, f) => sql`
      SELECT je.date AS day, cc.name_ar AS cost_center, acc.name_ar AS account,
             coalesce(jel.description, je.description, '—') AS description, jel.debit::text, jel.credit::text
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.entry_id
      JOIN cost_centers cc ON cc.id = jel.cost_center_id
      JOIN accounts acc ON acc.id = jel.account_id
      WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted'
        AND ${onDate(sql`je.date`, f.from, f.to)} AND ${eqIf(sql`jel.cost_center_id`, f.costCenterId)}
      ORDER BY je.date DESC LIMIT 2000`,
  },
  {
    key: 'income-statement',
    titleAr: 'قائمة الدخل التحليلية',
    group: 'accounting',
    hintAr: 'الإيرادات موجبة والمصروفات سالبة؛ المجموع هو صافي الربح.',
    params: [...PERIOD, BRANCH],
    columns: [text('section', 'البند'), text('code', 'رقم الحساب'), text('account', 'الحساب'), money('amount', 'المبلغ')],
    totals: ['amount'],
    build: (tenantId, f) => sql`
      SELECT CASE acc.type WHEN 'revenue' THEN 'الإيرادات' ELSE 'المصروفات' END AS section,
             acc.code, acc.name_ar AS account,
             CASE acc.type WHEN 'revenue' THEN sum(jel.credit) - sum(jel.debit)
                           ELSE -(sum(jel.debit) - sum(jel.credit)) END::text AS amount
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.entry_id
      JOIN accounts acc ON acc.id = jel.account_id
      WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted' AND acc.type IN ('revenue', 'expense')
        AND ${onDate(sql`je.date`, f.from, f.to)} AND ${eqIf(sql`je.branch_id`, f.branchId)}
      GROUP BY acc.type, acc.code, acc.name_ar ORDER BY acc.type DESC, acc.code`,
  },
  {
    key: 'balance-sheet',
    titleAr: 'ميزانية تحليلية',
    group: 'accounting',
    params: [{ name: 'to', labelAr: 'حتى تاريخ', kind: 'date' }, BRANCH],
    columns: [text('section', 'القسم'), text('code', 'رقم الحساب'), text('account', 'الحساب'), money('balance', 'الرصيد')],
    totals: ['balance'],
    build: (tenantId, f) => sql`
      SELECT CASE acc.type WHEN 'asset' THEN 'الأصول' WHEN 'liability' THEN 'الخصوم' ELSE 'حقوق الملكية' END AS section,
             acc.code, acc.name_ar AS account,
             CASE acc.type WHEN 'asset' THEN sum(jel.debit) - sum(jel.credit)
                           ELSE sum(jel.credit) - sum(jel.debit) END::text AS balance
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.entry_id
      JOIN accounts acc ON acc.id = jel.account_id
      WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted' AND acc.type IN ('asset', 'liability', 'equity')
        AND ${onDate(sql`je.date`, undefined, f.to)} AND ${eqIf(sql`je.branch_id`, f.branchId)}
      GROUP BY acc.type, acc.code, acc.name_ar ORDER BY acc.type, acc.code`,
  },
  {
    key: 'vat-return',
    titleAr: 'الإقرار الضريبي',
    group: 'accounting',
    hintAr: 'ضريبة المخرجات من المبيعات ناقص ضريبة المدخلات من المشتريات.',
    params: [...PERIOD, BRANCH],
    columns: [text('bucket', 'البند'), money('base', 'الوعاء'), money('vat', 'الضريبة')],
    totals: ['base', 'vat'],
    build: (tenantId, f) => sql`
      SELECT 'مبيعات خاضعة' AS bucket, coalesce(sum(si.subtotal), 0)::text AS base, coalesce(sum(si.tax_total), 0)::text AS vat
      FROM sales_invoices si WHERE ${salesScope(tenantId, f, 'sale')}
      UNION ALL
      SELECT 'مردود مبيعات', (-coalesce(sum(si.subtotal), 0))::text, (-coalesce(sum(si.tax_total), 0))::text
      FROM sales_invoices si WHERE ${salesScope(tenantId, f, 'sale_return')}
      UNION ALL
      SELECT 'مشتريات خاضعة', coalesce(sum(pi.subtotal), 0)::text, (-coalesce(sum(pi.tax_total), 0))::text
      FROM purchase_invoices pi WHERE ${purchaseScope(tenantId, f, 'purchase')}
      UNION ALL
      SELECT 'مردود مشتريات', (-coalesce(sum(pi.subtotal), 0))::text, coalesce(sum(pi.tax_total), 0)::text
      FROM purchase_invoices pi WHERE ${purchaseScope(tenantId, f, 'purchase_return')}`,
  },
  {
    key: 'ar-aging',
    titleAr: 'أعمار ديون العملاء',
    group: 'accounting',
    hintAr: 'المتبقي على كل فاتورة مبيعات مرحّلة موزّعاً على شرائح العمر.',
    params: [BRANCH],
    columns: [text('party', 'العميل'), money('bucket_0_30', '0-30 يوم'), money('bucket_31_60', '31-60'), money('bucket_61_90', '61-90'), money('bucket_90_plus', 'أكثر من 90'), money('due', 'الإجمالي')],
    totals: ['bucket_0_30', 'bucket_31_60', 'bucket_61_90', 'bucket_90_plus', 'due'],
    build: (tenantId, f) => sql`
      SELECT ${partyName} AS party,
             sum(CASE WHEN now() - si.posted_at <= interval '30 days' THEN si.total - si.paid_total ELSE 0 END)::text AS bucket_0_30,
             sum(CASE WHEN now() - si.posted_at > interval '30 days' AND now() - si.posted_at <= interval '60 days' THEN si.total - si.paid_total ELSE 0 END)::text AS bucket_31_60,
             sum(CASE WHEN now() - si.posted_at > interval '60 days' AND now() - si.posted_at <= interval '90 days' THEN si.total - si.paid_total ELSE 0 END)::text AS bucket_61_90,
             sum(CASE WHEN now() - si.posted_at > interval '90 days' THEN si.total - si.paid_total ELSE 0 END)::text AS bucket_90_plus,
             sum(si.total - si.paid_total)::text AS due
      FROM sales_invoices si
      LEFT JOIN parties party ON party.id = si.party_id
      WHERE si.tenant_id = ${tenantId} AND si.kind = 'sale' AND si.status = 'posted'
        AND si.total > si.paid_total AND ${eqIf(sql`si.branch_id`, f.branchId)}
      GROUP BY party.name ORDER BY sum(si.total - si.paid_total) DESC`,
  },
  {
    key: 'ap-aging',
    titleAr: 'أعمار ديون الموردين',
    group: 'accounting',
    params: [BRANCH],
    columns: [text('party', 'المورد'), money('bucket_0_30', '0-30 يوم'), money('bucket_31_60', '31-60'), money('bucket_61_90', '61-90'), money('bucket_90_plus', 'أكثر من 90'), money('due', 'الإجمالي')],
    totals: ['bucket_0_30', 'bucket_31_60', 'bucket_61_90', 'bucket_90_plus', 'due'],
    build: (tenantId, f) => sql`
      SELECT ${partyName} AS party,
             sum(CASE WHEN now() - pi.posted_at <= interval '30 days' THEN pi.total - pi.paid_total ELSE 0 END)::text AS bucket_0_30,
             sum(CASE WHEN now() - pi.posted_at > interval '30 days' AND now() - pi.posted_at <= interval '60 days' THEN pi.total - pi.paid_total ELSE 0 END)::text AS bucket_31_60,
             sum(CASE WHEN now() - pi.posted_at > interval '60 days' AND now() - pi.posted_at <= interval '90 days' THEN pi.total - pi.paid_total ELSE 0 END)::text AS bucket_61_90,
             sum(CASE WHEN now() - pi.posted_at > interval '90 days' THEN pi.total - pi.paid_total ELSE 0 END)::text AS bucket_90_plus,
             sum(pi.total - pi.paid_total)::text AS due
      FROM purchase_invoices pi
      LEFT JOIN parties party ON party.id = pi.party_id
      WHERE pi.tenant_id = ${tenantId} AND pi.kind = 'purchase' AND pi.status = 'posted'
        AND pi.total > pi.paid_total AND ${eqIf(sql`pi.branch_id`, f.branchId)}
      GROUP BY party.name ORDER BY sum(pi.total - pi.paid_total) DESC`,
  },
  {
    key: 'party-statement',
    titleAr: 'كشف حساب عميل',
    group: 'accounting',
    hintAr:
      '`frmCustAccountGet`: حركة حساب العميل قيداً قيداً — مجموع مدينه ومجموع دائنه، ورصيده إلى أيّ الجانبين مال. و«🏷️ نوع الحساب» يجعله كشف المورد كذلك، وهي النافذة نفسها في الديسكتوب.',
    params: [PARTY, PARTY_KIND, BRANCH, PERIOD[0]!, PERIOD[1]!],
    columns: [
      int('seq', 'م'),
      money('debit', 'مدين'),
      money('credit', 'دائن'),
      text('party', 'العميل / المورد'),
      text('number', 'رقم القيد'),
      date('day', 'تاريخ القيد'),
      text('note', 'البيان'),
      ...statementCards(),
      countCard,
    ],
    totals: ['debit', 'credit'],
    grandTotal: [...statementGrandTotal, { key: 's_count', labelAr: 'عدد القيود' }],
    emptyAr: 'لا حركة لهذا الحساب في هذه الفترة — و`frmCustAccountGet` يطلب العميل أولاً («اختر عميل»)',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT row_number() OVER (ORDER BY je.date, je.number) AS seq,
             round(sum(jel.debit), 2)::text AS debit,
             round(sum(jel.credit), 2)::text AS credit,
             max(party.name) AS party,
             coalesce(je.number, '—') AS number,
             je.date AS day,
             coalesce(min(je.description), '') AS note,
             CASE WHEN row_number() OVER (ORDER BY je.date, je.number) = 1
                  THEN round(sum(sum(jel.debit)) OVER (), 2)::text ELSE '0' END AS s_debit,
             CASE WHEN row_number() OVER (ORDER BY je.date, je.number) = 1
                  THEN round(sum(sum(jel.credit)) OVER (), 2)::text ELSE '0' END AS s_credit,
             CASE WHEN row_number() OVER (ORDER BY je.date, je.number) = 1
                  THEN greatest(sum(sum(jel.debit) - sum(jel.credit)) OVER (), 0)::text ELSE '0' END AS s_bal_debit,
             CASE WHEN row_number() OVER (ORDER BY je.date, je.number) = 1
                  THEN greatest(-sum(sum(jel.debit) - sum(jel.credit)) OVER (), 0)::text ELSE '0' END AS s_bal_credit,
             '1' AS s_count
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.entry_id
        JOIN parties party ON party.tenant_id = ${tenantId} AND party.deleted_at IS NULL
          AND ${partyMovement(sql`party`)}
       WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted'
         AND ${eqIf(sql`party.id`, f.partyId)}
         AND ${partyKindScope('party', f.partyKind)}
         AND ${onDate(sql`je.date`, f.from, f.to)}
         AND ${eqIf(sql`je.branch_id`, f.branchId)}
       GROUP BY je.id, je.date, je.number
       ORDER BY je.date, je.number LIMIT 2000`,
  },

  // ------------------------------------------------------------------ pos
  {
    key: 'pos-sales',
    titleAr: 'تقرير مبيعات نقطة البيع',
    group: 'pos',
    hintAr: 'الفواتير النقدية التي لا يقابلها عميل مسجّل هي مبيعات نقطة البيع.',
    params: [...PERIOD, BRANCH],
    columns: [text('number', 'الرقم'), date('day', 'التاريخ'), text('customer', 'العميل النقدي'), money('total', 'الإجمالي'), text('payment_status', 'السداد')],
    totals: ['total'],
    build: (tenantId, f) => sql`
      SELECT si.number, si.posted_at::date AS day, coalesce(si.cash_customer_name, 'نقدي') AS customer,
             si.total::text, si.payment_status
      FROM sales_invoices si
      WHERE ${salesScope(tenantId, f, 'sale')} AND si.party_id IS NULL
      ORDER BY si.posted_at DESC LIMIT 1000`,
  },
  {
    key: 'pos-daily',
    titleAr: 'المبيعات اليومية لنقطة البيع',
    group: 'pos',
    params: [...PERIOD, BRANCH],
    columns: [date('day', 'اليوم'), int('invoices', 'عدد الفواتير'), money('total', 'الإجمالي')],
    totals: ['invoices', 'total'],
    chart: 'bar',
    build: (tenantId, f) => sql`
      SELECT si.posted_at::date AS day, count(*)::text AS invoices, sum(si.total)::text AS total
      FROM sales_invoices si WHERE ${salesScope(tenantId, f, 'sale')} AND si.party_id IS NULL
      GROUP BY si.posted_at::date ORDER BY day DESC`,
  },
  {
    key: 'pos-item-summary',
    titleAr: 'أصناف نقطة البيع تجميعي',
    group: 'pos',
    params: [...PERIOD, BRANCH],
    columns: [text('item', 'الصنف'), qty('quantity', 'الكمية'), money('total', 'الإجمالي')],
    totals: ['quantity', 'total'],
    build: (tenantId, f) => sql`
      SELECT ${itemName} AS item, sum(line.quantity)::text AS quantity, sum(line.total)::text AS total
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      WHERE ${salesScope(tenantId, f, 'sale')} AND si.party_id IS NULL
      GROUP BY item.name_ar ORDER BY sum(line.total) DESC LIMIT 500`,
  },
  {
    key: 'cashier-shift',
    titleAr: 'إغلاقات اليومية',
    group: 'pos',
    params: [...PERIOD, BRANCH],
    columns: [date('opened', 'الفتح'), date('closed', 'الإغلاق'), text('branch', 'الفرع'), text('status', 'الحالة'), money('expected_cash', 'النقد المتوقع'), money('counted_cash', 'النقد المعدود'), money('diff', 'الفرق')],
    totals: ['expected_cash', 'counted_cash', 'diff'],
    build: (tenantId, f) => sql`
      SELECT sc.opened_at::date AS opened, sc.closed_at::date AS closed, ${branchName} AS branch, sc.status,
             sc.expected_cash::text, sc.counted_cash::text, sc.diff::text
      FROM shift_closes sc
      LEFT JOIN branches branch ON branch.id = sc.branch_id
      WHERE sc.tenant_id = ${tenantId} AND ${onDate(sql`sc.opened_at::date`, f.from, f.to)}
        AND ${eqIf(sql`sc.branch_id`, f.branchId)}
      ORDER BY sc.opened_at DESC LIMIT 500`,
  },

  // ------------------------------------------------------------------ hrm
  {
    key: 'payroll-payments',
    titleAr: 'دفع الرواتب',
    group: 'hrm',
    params: [],
    columns: [text('year_month', 'الشهر'), text('status', 'الحالة'), int('employees', 'عدد الموظفين'), money('net', 'صافي الرواتب'), date('posted', 'تاريخ الترحيل'), date('paid', 'تاريخ الصرف')],
    totals: ['employees', 'net'],
    build: (tenantId) => sql`
      SELECT run.year_month, run.status, count(line.employee_id)::text AS employees,
             coalesce(sum(line.net), 0)::text AS net, run.posted_at::date AS posted, run.paid_at::date AS paid
      FROM payroll_runs run
      LEFT JOIN payroll_run_lines line ON line.run_id = run.id
      WHERE run.tenant_id = ${tenantId}
      GROUP BY run.id, run.year_month, run.status, run.posted_at, run.paid_at
      ORDER BY run.year_month DESC LIMIT 200`,
  },
  {
    key: 'employee-account',
    titleAr: 'حساب موظف',
    group: 'hrm',
    hintAr: 'كل ما استحقه الموظف شهراً بشهر.',
    params: [],
    columns: [text('employee_no', 'الرقم'), text('employee', 'الموظف'), text('year_month', 'الشهر'), money('gross', 'الإجمالي'), money('additions', 'حوافز'), money('deductions', 'جزاءات'), money('net', 'الصافي'), text('status', 'الحالة')],
    totals: ['gross', 'additions', 'deductions', 'net'],
    build: (tenantId) => sql`
      SELECT emp.employee_no, emp.name AS employee, run.year_month, line.gross::text, line.additions::text,
             line.deductions::text, line.net::text, run.status
      FROM payroll_run_lines line
      JOIN payroll_runs run ON run.id = line.run_id
      JOIN employees emp ON emp.id = line.employee_id
      WHERE line.tenant_id = ${tenantId}
      ORDER BY run.year_month DESC, emp.employee_no LIMIT 1000`,
  },

  // -------------------------------------------------------- marina/projects
  {
    key: 'marina-rentals',
    titleAr: 'تقرير فواتير التأجير',
    group: 'marina',
    params: [...PERIOD, BRANCH],
    columns: [date('day', 'التاريخ'), text('vessel', 'المركب'), text('party', 'العميل'), int('companions', 'المرافقون'), money('period_amount', 'قيمة الفترة'), money('additions_amount', 'الإضافات'), money('insurance_amount', 'التأمين'), money('total', 'الإجمالي'), text('number', 'الفاتورة')],
    totals: ['period_amount', 'additions_amount', 'insurance_amount', 'total'],
    build: (tenantId, f) => sql`
      SELECT b.starts_at::date AS day, coalesce(v.name, '—') AS vessel, ${partyName} AS party,
             b.companions::text, rental.period_amount::text, rental.additions_amount::text,
             rental.insurance_amount::text, rental.total::text, coalesce(si.number, '—') AS number
      FROM rental_invoices rental
      JOIN marina_bookings b ON b.id = rental.booking_id
      LEFT JOIN vessels v ON v.id = b.vessel_id
      LEFT JOIN parties party ON party.id = b.party_id
      LEFT JOIN sales_invoices si ON si.id = rental.sales_invoice_id
      WHERE rental.tenant_id = ${tenantId}
        AND ${onDate(sql`b.starts_at::date`, f.from, f.to)} AND ${eqIf(sql`b.branch_id`, f.branchId)}
      ORDER BY b.starts_at DESC LIMIT 1000`,
  },
  {
    key: 'project-bills',
    titleAr: 'تقرير فواتير المقاولات',
    group: 'projects',
    params: [...PERIOD],
    columns: [text('project', 'المشروع'), text('number', 'المستخلص'), date('bill_date', 'التاريخ'), money('work_value', 'قيمة الأعمال'), money('previous_value', 'سابق'), money('retention_value', 'المحتجز'), money('net_due', 'المستحق'), text('status', 'الحالة')],
    totals: ['work_value', 'retention_value', 'net_due'],
    build: (tenantId, f) => sql`
      SELECT p.name AS project, coalesce(bill.number, '—') AS number, bill.bill_date,
             bill.work_value::text, bill.previous_value::text, bill.retention_value::text,
             bill.net_due::text, bill.status
      FROM progress_bills bill
      JOIN projects p ON p.id = bill.project_id
      WHERE bill.tenant_id = ${tenantId} AND ${onDate(sql`bill.bill_date`, f.from, f.to)}
      ORDER BY bill.bill_date DESC LIMIT 1000`,
  },
  {
    key: 'production-orders',
    titleAr: 'تقرير أمر الإنتاج',
    group: 'inventory',
    hintAr: 'أوامر الإنتاج المنفَّذة: تكلفة المكونات المستهلكة وتكلفة وحدة المنتج الناتج. الأمر محايد محاسبياً — القيمة الخارجة من المستودع هي نفسها الداخلة إليه.',
    params: [...PERIOD, WAREHOUSE, ITEM],
    columns: [date('order_date', 'التاريخ'), text('number', 'رقم الأمر'), text('item', 'المنتج'), text('warehouse', 'المستودع'), qty('output_qty', 'الكمية المنتجة'), money('component_cost', 'تكلفة المكونات'), money('unit_cost', 'تكلفة الوحدة'), int('components', 'عدد المكونات'), text('status', 'الحالة')],
    totals: ['output_qty', 'component_cost'],
    build: (tenantId, f) => sql`
      SELECT po.order_date, po.number, ${itemName} AS item, coalesce(wh.name, '—') AS warehouse,
             po.output_qty::text, po.component_cost::text, po.unit_cost::text,
             (SELECT count(*) FROM production_order_components c WHERE c.order_id = po.id)::text AS components,
             po.status
      FROM production_orders po
      LEFT JOIN items item ON item.id = po.output_item_id
      LEFT JOIN warehouses wh ON wh.id = po.warehouse_id
      WHERE po.tenant_id = ${tenantId} AND po.status <> 'cancelled'
        AND ${onDate(sql`po.order_date`, f.from, f.to)}
        AND ${eqIf(sql`po.warehouse_id`, f.warehouseId)}
        AND ${eqIf(sql`po.output_item_id`, f.itemId)}
      ORDER BY po.order_date DESC, po.number DESC LIMIT 1000`,
  },
  {
    key: 'contracting-returns',
    titleAr: 'مرتجعات المقاولات',
    group: 'projects',
    hintAr: 'الأعمال التي أُعيدت من مستخلصات مرحَّلة، وقيمة الإشعار الدائن المقابل بعد ردّ المحتجز.',
    params: [...PERIOD],
    columns: [date('return_date', 'التاريخ'), text('number', 'رقم المرتجع'), text('project', 'المشروع'), text('bill', 'المستخلص'), money('return_value', 'قيمة المرتجع'), money('retention_value', 'المحتجز المردود'), money('net_value', 'صافي الإشعار'), text('status', 'الحالة')],
    totals: ['return_value', 'retention_value', 'net_value'],
    build: (tenantId, f) => sql`
      SELECT r.return_date, r.number, p.name AS project, coalesce(bill.number, '—') AS bill,
             r.return_value::text, r.retention_value::text, r.net_value::text, r.status
      FROM contracting_returns r
      JOIN projects p ON p.id = r.project_id
      LEFT JOIN progress_bills bill ON bill.id = r.bill_id
      WHERE r.tenant_id = ${tenantId} AND r.status <> 'cancelled'
        AND ${onDate(sql`r.return_date`, f.from, f.to)}
      ORDER BY r.return_date DESC LIMIT 1000`,
  },
  {
    key: 'pos-item-detail',
    titleAr: 'تفاصيل أصناف نقطة البيع',
    group: 'pos',
    hintAr: 'سطر لكل صنف في كل فاتورة نقدية.',
    params: [...PERIOD, BRANCH, ITEM],
    columns: [date('day', 'التاريخ'), text('number', 'الفاتورة'), text('item', 'الصنف'), qty('quantity', 'الكمية'), money('unit_price', 'السعر'), money('discount_amount', 'الخصم'), money('total', 'الإجمالي')],
    totals: ['quantity', 'discount_amount', 'total'],
    build: (tenantId, f) => sql`
      SELECT si.posted_at::date AS day, si.number, ${itemName} AS item, line.quantity::text,
             line.unit_price::text, line.discount_amount::text, line.total::text
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      WHERE ${salesScope(tenantId, f, 'sale')} AND si.party_id IS NULL AND ${eqIf(sql`line.item_id`, f.itemId)}
      ORDER BY si.posted_at DESC, line.line_no LIMIT 2000`,
  },
  {
    key: 'pos-by-category',
    titleAr: 'مبيعات نقطة البيع بحسب المجموعة',
    group: 'pos',
    params: [...PERIOD, BRANCH],
    columns: [text('category', 'المجموعة'), int('invoices', 'عدد الفواتير'), qty('quantity', 'الكمية'), money('total', 'الإجمالي')],
    totals: ['quantity', 'total'],
    chart: 'bar',
    build: (tenantId, f) => sql`
      SELECT coalesce(cat.name_ar, '—') AS category, count(DISTINCT si.id)::text AS invoices,
             sum(line.quantity)::text AS quantity, sum(line.total)::text AS total
      FROM sales_invoice_lines line
      JOIN sales_invoices si ON si.id = line.invoice_id
      LEFT JOIN items item ON item.id = line.item_id
      LEFT JOIN item_categories cat ON cat.id = item.category_id
      WHERE ${salesScope(tenantId, f, 'sale')} AND si.party_id IS NULL
      GROUP BY cat.name_ar ORDER BY sum(line.total) DESC`,
  },
  {
    key: 'sales-by-employee',
    titleAr: 'مبيعات موظف',
    group: 'sales',
    hintAr: 'حسب المستخدم الذي أنشأ الفاتورة. الفواتير التي أُنشئت قبل تفعيل التتبّع تظهر كـ«غير محدد».',
    params: [...PERIOD, BRANCH],
    columns: [text('employee', 'الموظف'), int('invoices', 'عدد الفواتير'), money('total', 'الإجمالي'), money('profit', 'الربح')],
    totals: ['invoices', 'total', 'profit'],
    build: (tenantId, f) => sql`
      SELECT coalesce(u.full_name, u.email, 'غير محدد') AS employee, count(*)::text AS invoices,
             sum(si.total)::text AS total, sum(si.subtotal - si.cost_total)::text AS profit
      FROM sales_invoices si
      LEFT JOIN users u ON u.id = si.created_by
      WHERE ${salesScope(tenantId, f, 'sale')}
      GROUP BY u.full_name, u.email ORDER BY sum(si.total) DESC`,
  },
  {
    key: 'purchases-by-employee',
    titleAr: 'مشتريات موظف',
    group: 'purchases',
    hintAr: 'حسب المستخدم الذي أنشأ فاتورة الشراء.',
    params: [...PERIOD, BRANCH],
    columns: [text('employee', 'الموظف'), int('invoices', 'عدد الفواتير'), money('total', 'الإجمالي')],
    totals: ['invoices', 'total'],
    build: (tenantId, f) => sql`
      SELECT coalesce(u.full_name, u.email, 'غير محدد') AS employee, count(*)::text AS invoices,
             sum(pi.total)::text AS total
      FROM purchase_invoices pi
      LEFT JOIN users u ON u.id = pi.created_by
      WHERE ${purchaseScope(tenantId, f, 'purchase')}
      GROUP BY u.full_name, u.email ORDER BY sum(pi.total) DESC`,
  },
  {
    key: 'sales-notes',
    titleAr: 'تقرير إشعارات المبيعات',
    group: 'sales',
    hintAr: 'الإشعارات الدائنة والمدينة الصادرة على فواتير مرحّلة.',
    params: [...PERIOD, BRANCH],
    columns: [date('day', 'التاريخ'), text('number', 'رقم الإشعار'), text('kind', 'النوع'), text('invoice', 'الفاتورة'), text('party', 'العميل'), text('reason', 'السبب'), money('amount', 'المبلغ'), text('status', 'الحالة')],
    totals: ['amount'],
    build: (tenantId, f) => sql`
      SELECT note.created_at::date AS day, coalesce(note.number, '—') AS number,
             CASE note.kind WHEN 'credit' THEN 'إشعار دائن' WHEN 'debit' THEN 'إشعار مدين' ELSE note.kind END AS kind,
             coalesce(si.number, '—') AS invoice, ${partyName} AS party, note.reason, note.amount::text, note.status
      FROM sales_adjustment_notes note
      LEFT JOIN sales_invoices si ON si.id = note.invoice_id
      LEFT JOIN parties party ON party.id = si.party_id
      WHERE note.tenant_id = ${tenantId} AND ${onDate(sql`note.created_at::date`, f.from, f.to)}
        AND ${eqIf(sql`note.branch_id`, f.branchId)}
      ORDER BY note.created_at DESC LIMIT 1000`,
  },
  {
    key: 'purchase-notes',
    titleAr: 'تقرير إشعارات المشتريات',
    group: 'purchases',
    hintAr: 'الإشعارات الدائنة والمدينة الصادرة على فواتير موردين مرحّلة.',
    params: [...PERIOD, BRANCH],
    columns: [date('day', 'التاريخ'), text('number', 'رقم الإشعار'), text('kind', 'النوع'), text('invoice', 'الفاتورة'), text('party', 'المورد'), text('reason', 'السبب'), money('amount', 'المبلغ'), text('status', 'الحالة')],
    totals: ['amount'],
    build: (tenantId, f) => sql`
      SELECT note.created_at::date AS day, coalesce(note.number, '—') AS number,
             CASE note.kind WHEN 'credit' THEN 'إشعار دائن' WHEN 'debit' THEN 'إشعار مدين' ELSE note.kind END AS kind,
             coalesce(pi.number, '—') AS invoice, ${partyName} AS party, note.reason, note.amount::text, note.status
      FROM purchase_adjustment_notes note
      LEFT JOIN purchase_invoices pi ON pi.id = note.invoice_id
      LEFT JOIN parties party ON party.id = pi.party_id
      WHERE note.tenant_id = ${tenantId} AND ${onDate(sql`note.created_at::date`, f.from, f.to)}
        AND ${eqIf(sql`note.branch_id`, f.branchId)}
      ORDER BY note.created_at DESC LIMIT 1000`,
  },
  // ----------------------------------------------------- long-lived keys
  // Registered since the first release; kept so saved links and the legacy
  // desktop client keep resolving.
  {
    key: 'sales-by-ordertype',
    titleAr: 'المبيعات بحسب نوع الطلب',
    group: 'sales',
    params: [...PERIOD, BRANCH],
    columns: [text('order_type', 'نوع الطلب'), int('count', 'العدد'), money('total', 'الإجمالي')],
    totals: ['count', 'total'],
    build: (tenantId, f) => sql`
      SELECT coalesce(si.order_type, 'عادي') AS order_type, count(*)::text AS count, sum(si.total)::text AS total
      FROM sales_invoices si WHERE ${salesScope(tenantId, f, 'sale')}
      GROUP BY coalesce(si.order_type, 'عادي') ORDER BY order_type`,
  },
  {
    key: 'batch-tracking',
    titleAr: 'تتبع الدفعات',
    group: 'inventory',
    params: [ITEM],
    columns: [text('sku', 'الرمز'), text('item', 'الصنف'), text('lot_no', 'رقم الدفعة'), date('received_at', 'تاريخ الاستلام'), date('expiry_date', 'تاريخ الانتهاء')],
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS sku, ${itemName} AS item, lot.lot_no,
             lot.received_at::date AS received_at, lot.expiry_date
      FROM item_lots lot
      LEFT JOIN items item ON item.id = lot.item_id
      WHERE lot.tenant_id = ${tenantId} AND lot.deleted_at IS NULL AND ${eqIf(sql`lot.item_id`, f.itemId)}
      ORDER BY lot.received_at DESC NULLS LAST LIMIT 1000`,
  },
  {
    key: 'profit-loss',
    titleAr: 'الأرباح والخسائر',
    group: 'accounting',
    hintAr: 'ملخص الإيرادات والمصروفات وصافي النتيجة.',
    params: [...PERIOD, BRANCH],
    columns: [text('section', 'البند'), money('amount', 'المبلغ')],
    build: (tenantId, f) => sql`
      WITH movement AS (
        SELECT acc.type, sum(jel.credit) - sum(jel.debit) AS net
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.entry_id
        JOIN accounts acc ON acc.id = jel.account_id
        WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted' AND acc.type IN ('revenue', 'expense')
          AND ${onDate(sql`je.date`, f.from, f.to)} AND ${eqIf(sql`je.branch_id`, f.branchId)}
        GROUP BY acc.type
      )
      SELECT 'إجمالي الإيرادات' AS section, coalesce((SELECT net FROM movement WHERE type = 'revenue'), 0)::text AS amount
      UNION ALL
      SELECT 'إجمالي المصروفات', coalesce(-(SELECT net FROM movement WHERE type = 'expense'), 0)::text
      UNION ALL
      SELECT 'صافي الربح', (coalesce((SELECT net FROM movement WHERE type = 'revenue'), 0)
                            + coalesce((SELECT net FROM movement WHERE type = 'expense'), 0))::text`,
  },  // ------------------------------------------- 📚 inventory — تقارير المخزون والأرقام التسلسلية
  {
    key: 'inventory-documents',
    titleAr: 'تقرير مستندات المخزون',
    group: 'inventory',
    hintAr: 'كل مستند مخزون بسطر: نوعه ورقمه وتاريخه ومستودعه وفرعه، وعدد أصنافه وكميته وتكلفته — «📋 الفواتير» في `frmRptInventory`.',
    // 📄 نوع العملية · 🏭 المستودع · 🏢 الفرع · 📅 من / إلى + ⏰ الوقت.
    params: [INVENTORY_OPERATION, WAREHOUSE, BRANCH, PERIOD[0]!, TIME_FROM_TO[0]!, PERIOD[1]!, TIME_FROM_TO[1]!],
    columns: [
      int('seq', 'م'),
      text('operation', 'نوع العملية'),
      text('doc_number', 'رقم المستند'),
      date('doc_date', 'التاريخ'),
      text('party_name', 'العميل/المورد'),
      text('warehouse_name', 'المستودع'),
      text('branch_name', 'الفرع'),
      int('lines_count', 'عدد الأصناف'),
      qty('qty', 'الكمية'),
      money('cost', 'التكلفة'),
      { key: 'doc_id', labelAr: 'معرّف المستند', type: 'text', hidden: true },
      countCard,
    ],
    totals: ['lines_count', 'qty', 'cost'],
    // «المجموع:» · «الصافي:» · «عدد الفواتير:» — an inventory document carries a cost and a
    // quantity, not a price and a tax, so the five money cards of the desktop collapse into
    // إجمالي الكمية · إجمالي التكلفة · عدد المستندات.
    grandTotal: [
      { key: 'qty', labelAr: 'إجمالي الكمية' },
      { key: 'cost', labelAr: 'إجمالي التكلفة' },
      { key: 's_count', labelAr: 'عدد المستندات' },
    ],
    emptyAr: 'لا توجد مستندات في هذه الفترة',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT row_number() OVER (ORDER BY agg.occurred_at, agg.doc_id)::text AS seq,
             ${docTypeLabel(sql`agg.doc_type`)} AS operation,
             ${docNumber} AS doc_number,
             to_char(agg.occurred_at, 'YYYY-MM-DD') AS doc_date,
             ${movementParty} AS party_name,
             ${warehouseName} AS warehouse_name,
             ${movementBranch} AS branch_name,
             agg.lines_count, agg.qty, agg.cost,
             agg.doc_id::text AS doc_id, '1' AS s_count
      FROM (
        SELECT it.doc_type, it.doc_id, it.warehouse_id,
               min(it.occurred_at) AS occurred_at,
               count(DISTINCT it.item_id)::text AS lines_count,
               round(sum(CASE WHEN it.direction = 'in' THEN it.base_qty ELSE -it.base_qty END), 2)::text AS qty,
               round(sum(CASE WHEN it.direction = 'in' THEN it.total_cost ELSE -it.total_cost END), 2)::text AS cost
        FROM inventory_transactions it
        JOIN items item ON item.id = it.item_id
        JOIN warehouses wh ON wh.id = it.warehouse_id
        WHERE ${ledgerScope(tenantId, f)} AND ${docTypeScope(f.docType)}
        GROUP BY it.doc_type, it.doc_id, it.warehouse_id
      ) agg
      LEFT JOIN warehouses wh ON wh.id = agg.warehouse_id
      LEFT JOIN branches br ON br.id = wh.branch_id
      LEFT JOIN stock_transfers tr ON tr.id = agg.doc_id AND agg.doc_type IN ('stock_transfer', 'stock_transfer_receipt', 'stock_transfer_return', 'stock_transfer_cancel')
      LEFT JOIN stock_deliveries dl ON dl.id = agg.doc_id AND agg.doc_type = 'stock_delivery'
      LEFT JOIN goods_requests rq ON rq.id = agg.doc_id AND agg.doc_type = 'goods_request'
      LEFT JOIN stock_adjustments aj ON aj.id = agg.doc_id AND agg.doc_type = 'stock_adjustment'
      LEFT JOIN stock_vouchers sv ON sv.id = agg.doc_id AND agg.doc_type IN ('stock_voucher', 'stock_voucher_void', 'opening')
      LEFT JOIN production_orders mo ON mo.id = agg.doc_id AND agg.doc_type = 'production_order'
      LEFT JOIN sales_invoices si ON si.id = agg.doc_id AND agg.doc_type IN ('sales_invoice', 'sales_return', 'sales_void')
      LEFT JOIN purchase_invoices pi ON pi.id = agg.doc_id AND agg.doc_type IN ('purchase_invoice', 'purchase_return', 'purchase_void')
      LEFT JOIN parties pt ON pt.id = coalesce(si.party_id, pi.party_id, dl.party_id)
      ORDER BY agg.occurred_at, agg.doc_id LIMIT 2000`,
  },
  {
    key: 'item-movement-totals',
    titleAr: 'مادة باجمالي الحركات',
    group: 'inventory',
    hintAr: 'كل صنف بسطر: رصيده ومتوسط تكلفته وإجمالي تكلفته، ثم حركته في الفترة مقسّمة على ثلاثة عشر نوعاً كما في `frmRptItemsActivity`.',
    // 🏢 الفرع · 📦 الصنف · 📅 من / إلى · 🏪 المستودع · 👥 العملاء / الموردون · 🗂️ المجموعة.
    params: [BRANCH, ITEM, PERIOD[0]!, PERIOD[1]!, WAREHOUSE, PARTY, CATEGORY],
    columns: [
      text('code', 'الرمز'),
      text('item_name', 'الصنف'),
      qty('balance', 'الرصيد'),
      money('avg_cost', 'متوسط التكلفة'),
      money('total_cost', 'إجمالي التكلفة'),
      qty('opening_qty', 'أول مدة'),
      qty('purchase_qty', 'مشتريات'),
      qty('purchase_return_qty', 'مرتجع مشتريات'),
      qty('sale_qty', 'المبيعات'),
      qty('sale_return_qty', 'مرتجع المبيعات'),
      qty('pos_qty', 'نقطة البيع'),
      qty('pos_return_qty', 'مرتجع POS'),
      qty('transfer_sent_qty', 'مناقلة مرسلة'),
      qty('transfer_received_qty', 'مناقلة مستلمة'),
      qty('entry_qty', 'فاتورة إدخال'),
      qty('issue_qty', 'فاتورة إخراج'),
      qty('adjust_in_qty', 'تسوية إدخال'),
      qty('adjust_out_qty', 'تسوية إخراج'),
      countCard,
    ],
    totals: [
      'balance',
      'total_cost',
      'opening_qty',
      'purchase_qty',
      'purchase_return_qty',
      'sale_qty',
      'sale_return_qty',
      'pos_qty',
      'pos_return_qty',
      'transfer_sent_qty',
      'transfer_received_qty',
      'entry_qty',
      'issue_qty',
      'adjust_in_qty',
      'adjust_out_qty',
    ],
    // «📦 إجمالي الرصيد» · «💰 إجمالي التكلفة» · «🔢 عدد الأصناف».
    grandTotal: [
      { key: 'balance', labelAr: 'إجمالي الرصيد' },
      { key: 'total_cost', labelAr: 'إجمالي التكلفة' },
      { key: 's_count', labelAr: 'عدد الأصناف' },
    ],
    emptyAr: 'لا توجد حركة لهذه الأصناف في الفترة المحددة',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT coalesce(item.sku, '—') AS code, ${itemName} AS item_name,
             round(bal.balance, 2)::text AS balance,
             round(coalesce(sb.value / nullif(sb.quantity, 0), 0), 4)::text AS avg_cost,
             round(bal.balance * coalesce(sb.value / nullif(sb.quantity, 0), 0), 2)::text AS total_cost,
             round(bal.opening_qty, 2)::text AS opening_qty,
             round(bal.purchase_qty, 2)::text AS purchase_qty,
             round(bal.purchase_return_qty, 2)::text AS purchase_return_qty,
             round(bal.sale_qty, 2)::text AS sale_qty,
             round(bal.sale_return_qty, 2)::text AS sale_return_qty,
             round(bal.pos_qty, 2)::text AS pos_qty,
             round(bal.pos_return_qty, 2)::text AS pos_return_qty,
             round(bal.transfer_sent_qty, 2)::text AS transfer_sent_qty,
             round(bal.transfer_received_qty, 2)::text AS transfer_received_qty,
             round(bal.entry_qty, 2)::text AS entry_qty,
             round(bal.issue_qty, 2)::text AS issue_qty,
             round(bal.adjust_in_qty, 2)::text AS adjust_in_qty,
             round(bal.adjust_out_qty, 2)::text AS adjust_out_qty,
             '1' AS s_count
      FROM (
        SELECT it.item_id AS item_id,
               sum(CASE WHEN it.direction = 'in' THEN it.base_qty ELSE -it.base_qty END) AS balance,
               sum(CASE WHEN it.doc_type = 'opening' THEN it.base_qty ELSE 0 END) AS opening_qty,
               sum(CASE WHEN it.doc_type = 'purchase_invoice' THEN it.base_qty ELSE 0 END) AS purchase_qty,
               sum(CASE WHEN it.doc_type = 'purchase_return' THEN it.base_qty ELSE 0 END) AS purchase_return_qty,
               sum(CASE WHEN it.doc_type = 'sales_invoice' AND si.party_id IS NOT NULL THEN it.base_qty ELSE 0 END) AS sale_qty,
               sum(CASE WHEN it.doc_type = 'sales_return' AND si.party_id IS NOT NULL THEN it.base_qty ELSE 0 END) AS sale_return_qty,
               sum(CASE WHEN it.doc_type = 'sales_invoice' AND si.party_id IS NULL THEN it.base_qty ELSE 0 END) AS pos_qty,
               sum(CASE WHEN it.doc_type = 'sales_return' AND si.party_id IS NULL THEN it.base_qty ELSE 0 END) AS pos_return_qty,
               sum(CASE WHEN it.doc_type = 'stock_transfer_receipt' THEN it.base_qty ELSE 0 END) AS transfer_sent_qty,
               sum(CASE WHEN it.doc_type = 'stock_transfer' THEN it.base_qty ELSE 0 END) AS transfer_received_qty,
               sum(CASE WHEN it.doc_type = 'stock_voucher' AND it.direction = 'in' THEN it.base_qty ELSE 0 END) AS entry_qty,
               sum(CASE WHEN it.doc_type = 'stock_voucher' AND it.direction = 'out' THEN it.base_qty ELSE 0 END) AS issue_qty,
               sum(CASE WHEN it.doc_type = 'stock_adjustment' AND it.direction = 'in' THEN it.base_qty ELSE 0 END) AS adjust_in_qty,
               sum(CASE WHEN it.doc_type = 'stock_adjustment' AND it.direction = 'out' THEN it.base_qty ELSE 0 END) AS adjust_out_qty
        FROM inventory_transactions it
        JOIN items item ON item.id = it.item_id
        JOIN warehouses wh ON wh.id = it.warehouse_id
        LEFT JOIN sales_invoices si ON si.id = it.doc_id AND it.doc_type IN ('sales_invoice', 'sales_return')
        LEFT JOIN purchase_invoices pi ON pi.id = it.doc_id AND it.doc_type IN ('purchase_invoice', 'purchase_return')
        WHERE ${ledgerScope(tenantId, f)}
        GROUP BY it.item_id
        HAVING sum(abs(it.base_qty)) <> 0
      ) bal
      JOIN items item ON item.id = bal.item_id
      LEFT JOIN (
        SELECT sb.tenant_id, sb.item_id,
               sum(sb.quantity) AS quantity, sum(sb.value) AS value
        FROM stock_balances sb
        WHERE sb.tenant_id = ${tenantId} AND ${eqIf(sql`sb.warehouse_id`, f.warehouseId)}
        GROUP BY sb.tenant_id, sb.item_id
      ) sb ON sb.item_id = bal.item_id
      ORDER BY item.name_ar LIMIT 2000`,
  },
  {
    key: 'item-movement-details',
    titleAr: 'حركة صنف تفصيلي',
    group: 'inventory',
    hintAr: 'كل سطر حركة: نوع المستند ورقمه ومرجعه وتاريخه وحسابه، كميته الداخلة أو الخارجة ورصيده المتحرك بعدها — `frmRptItemsActivityDetailed`.',
    // 🏬 الفرع · 🏭 المستودع · 📦 الصنف · 📅 من / إلى · 👥 عميل / مورد · 🔄 نوع العملية · 📋 أنماط الفواتير.
    params: [BRANCH, WAREHOUSE, ITEM, PERIOD[0]!, PERIOD[1]!, PARTY, MOVEMENT_PROC_TYPE, INVOICE_PATTERN],
    columns: [
      int('seq', 'م'),
      text('operation', 'نوع الفاتورة'),
      text('warehouse_name', 'المستودع'),
      text('code', 'رمز الصنف'),
      text('item_name', 'الصنف'),
      text('doc_number', 'رقم الفاتورة'),
      text('ref_no', 'رقم المرجع'),
      date('doc_date', 'التاريخ'),
      text('party_name', 'الحساب'),
      text('unit_name', 'الوحدة'),
      qty('qty_doc', 'الكمية في الفاتورة'),
      money('price_doc', 'السعر في الفاتورة'),
      money('total_doc', 'الإجمالي في الفاتورة'),
      qty('qty_in', 'الكمية الداخلة'),
      qty('qty_out', 'الكمية الخارجة'),
      qty('balance', 'الرصيد'),
      money('price', 'السعر'),
      money('total', 'الإجمالي'),
      { key: 'doc_id', labelAr: 'معرّف المستند', type: 'text', hidden: true },
      { key: 's_qty', labelAr: 'الرصيد الموقّع', type: 'qty', hidden: true },
    ],
    totals: ['qty_doc', 'total_doc', 'qty_in', 'qty_out', 'total'],
    // «⚖️ إجمالي الرصيد:» — the last row's running balance, which is the signed sum of every
    // movement on screen, exactly as the desktop accumulates `balance` row by row (L355-365).
    grandTotal: [{ key: 's_qty', labelAr: 'إجمالي الرصيد' }],
    emptyAr: 'لا توجد حركة لهذا الصنف في الفترة المحددة',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT row_number() OVER (ORDER BY it.occurred_at, it.id)::text AS seq,
             ${docTypeLabel(sql`it.doc_type`, true, sql`it.direction`)} AS operation,
             ${warehouseName} AS warehouse_name,
             coalesce(item.sku, '—') AS code, ${itemName} AS item_name,
             ${docNumber} AS doc_number, ${docReference} AS ref_no, ${docDate} AS doc_date,
             ${movementParty} AS party_name, coalesce(uom.name_ar, '—') AS unit_name,
             round(it.qty, 2)::text AS qty_doc,
             round(it.unit_cost * it.factor, 4)::text AS price_doc,
             round(it.qty * it.unit_cost * it.factor, 2)::text AS total_doc,
             round(CASE WHEN it.direction = 'in' THEN it.base_qty ELSE 0 END, 2)::text AS qty_in,
             round(CASE WHEN it.direction = 'out' THEN it.base_qty ELSE 0 END, 2)::text AS qty_out,
             round(sum(CASE WHEN it.direction = 'in' THEN it.base_qty ELSE -it.base_qty END)
                   OVER (ORDER BY it.occurred_at, it.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 2)::text AS balance,
             round(it.unit_cost, 4)::text AS price,
             round(it.total_cost, 2)::text AS total,
             it.doc_id::text AS doc_id,
             (CASE WHEN it.direction = 'in' THEN it.base_qty ELSE -it.base_qty END)::text AS s_qty
      FROM inventory_transactions it
      JOIN items item ON item.id = it.item_id
      JOIN warehouses wh ON wh.id = it.warehouse_id
      LEFT JOIN branches br ON br.id = wh.branch_id
      LEFT JOIN units_of_measure uom ON uom.id = it.unit_id
      ${documentJoins}
      LEFT JOIN parties pt ON pt.id = coalesce(si.party_id, pi.party_id, dl.party_id)
      WHERE ${ledgerScope(tenantId, f)}
        AND ${movementProcTypeScope(f.kind)}
        AND ${invoicePatternScope(f.status)}
      ORDER BY it.occurred_at, it.id LIMIT 2000`,
  },
  {
    key: 'item-expiry',
    titleAr: 'صلاحية المواد',
    group: 'inventory',
    hintAr: 'كل دفعة لها تاريخ انتهاء بسطر: رصيدها الحالي وما بقي من سنوات وأشهر وأيام — `dbo.ItemsExpirationStock()` خلف `frmRptItemsExpiration`.',
    // 🏪 المستودع · 🗂️ المجموعة · 📦 الصنف · 🏢 الفرع.
    params: [WAREHOUSE, CATEGORY, ITEM, BRANCH],
    columns: [
      int('seq', 'م'),
      text('code', 'رمز الصنف'),
      text('item_name', 'الصنف'),
      text('warehouse_name', 'المستودع'),
      qty('qty', 'الكمية الحالية'),
      date('expiry_date', 'تاريخ الإنتهاء'),
      int('years_left', 'باقي سنوات'),
      int('months_left', 'باقي أشهر'),
      int('days_left', 'باقي أيام'),
      { key: 's_expired', labelAr: 'منتهي', type: 'int', hidden: true },
      countCard,
    ],
    totals: ['qty'],
    // «📦 عدد الأصناف» · «⚠️ منتهي الصلاحية» — the second is a count of rows whose date has
    // already passed, which `UpdateSummary()` L206-210 does over the grid it just filled.
    grandTotal: [
      { key: 's_count', labelAr: 'عدد الأصناف' },
      { key: 's_expired', labelAr: 'منتهي الصلاحية' },
    ],
    emptyAr: 'لا توجد أصناف مراقبة بتواريخ صلاحية',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT row_number() OVER (ORDER BY lot.expiry_date, item.name_ar)::text AS seq,
             coalesce(item.sku, '—') AS code, ${itemName} AS item_name,
             ${warehouseName} AS warehouse_name,
             round(stock.qty, 2)::text AS qty,
             to_char(lot.expiry_date, 'YYYY-MM-DD') AS expiry_date,
             (extract(year from lot.expiry_date)::int - extract(year from current_date)::int)::text AS years_left,
             ((extract(year from lot.expiry_date)::int - extract(year from current_date)::int) * 12
               + (extract(month from lot.expiry_date)::int - extract(month from current_date)::int))::text AS months_left,
             (lot.expiry_date - current_date)::text AS days_left,
             CASE WHEN lot.expiry_date < current_date THEN 1 ELSE 0 END::text AS s_expired,
             '1' AS s_count
      FROM item_lots lot
      JOIN items item ON item.id = lot.item_id
      JOIN (
        SELECT it.tenant_id, it.lot_id, it.warehouse_id,
               sum(CASE WHEN it.direction = 'in' THEN it.base_qty ELSE -it.base_qty END) AS qty
        FROM inventory_transactions it
        JOIN warehouses wh ON wh.id = it.warehouse_id
        WHERE it.tenant_id = ${tenantId}
          AND it.lot_id IS NOT NULL
          AND ${eqIf(sql`it.warehouse_id`, f.warehouseId)}
          AND ${eqIf(sql`it.item_id`, f.itemId)}
          AND ${eqIf(sql`wh.branch_id`, f.branchId)}
        GROUP BY it.tenant_id, it.lot_id, it.warehouse_id
        HAVING sum(CASE WHEN it.direction = 'in' THEN it.base_qty ELSE -it.base_qty END) <> 0
      ) stock ON stock.lot_id = lot.id AND stock.tenant_id = lot.tenant_id
      JOIN warehouses wh ON wh.id = stock.warehouse_id
      WHERE lot.tenant_id = ${tenantId}
        AND lot.expiry_date IS NOT NULL
        AND ${eqIf(sql`lot.item_id`, f.itemId)}
        AND ${eqIf(sql`item.category_id`, f.categoryId)}
        AND ${eqIf(sql`wh.branch_id`, f.branchId)}
      ORDER BY lot.expiry_date, item.name_ar LIMIT 2000`,
  },
  {
    key: 'serial-movements',
    titleAr: 'حركة الأرقام التسلسلية',
    group: 'inventory',
    hintAr: 'أين مرّ كل رقم تسلسلي: مستنداً بمستند مع نوعه ورقمه وتاريخه وفرعه — `frmRptSerialNo`.',
    // 🏬 الفرع · 📦 الصنف · 🔢 الرقم التسلسلي · 📅 من / إلى.
    params: [BRANCH, ITEM, SERIAL_NO, PERIOD[0]!, PERIOD[1]!],
    columns: [
      int('seq', 'م'),
      text('item_name', 'الصنف'),
      text('code', 'رمز الصنف'),
      text('serial_no', 'التسلسل'),
      text('operation', 'نوع الفاتورة'),
      text('doc_number', 'رقم الفاتورة'),
      date('doc_date', 'التاريخ'),
      text('branch_name', 'الفرع'),
      text('direction', 'الإتجاه'),
      { key: 'doc_id', labelAr: 'معرّف المستند', type: 'text', hidden: true },
    ],
    totals: [],
    emptyAr: 'لا توجد حركة أرقام تسلسلية في هذه الفترة',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT row_number() OVER (ORDER BY it.occurred_at, it.id)::text AS seq,
             ${itemName} AS item_name, coalesce(item.sku, '—') AS code,
             ser.serial_no AS serial_no,
             ${docTypeLabel(sql`it.doc_type`, true, sql`it.direction`)} AS operation,
             ${docNumber} AS doc_number, ${docDate} AS doc_date,
             ${movementBranch} AS branch_name,
             CASE it.direction WHEN 'in' THEN 'داخل' ELSE 'خارج' END AS direction,
             it.doc_id::text AS doc_id
      FROM inventory_transactions it
      JOIN item_serials ser ON ser.id = it.serial_id
      JOIN items item ON item.id = it.item_id
      JOIN warehouses wh ON wh.id = it.warehouse_id
      LEFT JOIN branches br ON br.id = wh.branch_id
      ${documentJoins}
      WHERE it.tenant_id = ${tenantId}
        AND it.serial_id IS NOT NULL
        AND ${onDateTime(sql`it.occurred_at`, f.from, f.to, f.fromTime, f.toTime)}
        AND ${eqIf(sql`it.item_id`, f.itemId)}
        AND ${eqIf(sql`wh.branch_id`, f.branchId)}
        AND ${f.serial ? sql`ser.serial_no = ${f.serial}` : all}
      ORDER BY it.occurred_at, it.id LIMIT 2000`,
  },
  {
    key: 'serial-balances',
    titleAr: 'أرصدة الأرقام التسلسلية',
    group: 'inventory',
    hintAr: 'كم وحدة ما زالت في المخزون لكل رقم تسلسلي — `dbo.funCalculateSerialNoSummary()` خلف `frmRptSerialNoSummary`.',
    // 🏬 الفرع · 📦 الصنف · 🔢 الرقم التسلسلي.
    params: [BRANCH, ITEM, SERIAL_NO],
    columns: [
      int('seq', 'م'),
      text('item_name', 'الصنف'),
      text('code', 'رمز الصنف'),
      text('serial_no', 'التسلسل'),
      qty('count', 'العدد'),
      countCard,
    ],
    totals: ['count'],
    grandTotal: [
      { key: 'count', labelAr: 'إجمالي العدد' },
      { key: 's_count', labelAr: 'عدد الأرقام التسلسلية' },
    ],
    emptyAr: 'لا توجد أرقام تسلسلية في المخزون',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT row_number() OVER (ORDER BY item.name_ar, ser.serial_no)::text AS seq,
             ${itemName} AS item_name, coalesce(item.sku, '—') AS code,
             ser.serial_no AS serial_no, count(*)::text AS count, '1' AS s_count
      FROM item_serials ser
      JOIN items item ON item.id = ser.item_id
      LEFT JOIN warehouses wh ON wh.id = ser.warehouse_id
      WHERE ser.tenant_id = ${tenantId}
        AND ser.deleted_at IS NULL
        AND ser.status IN ('available', 'reserved')
        AND ${eqIf(sql`ser.item_id`, f.itemId)}
        AND ${eqIf(sql`wh.branch_id`, f.branchId)}
        AND ${f.serial ? sql`ser.serial_no = ${f.serial}` : all}
      GROUP BY item.name_ar, item.sku, ser.serial_no
      ORDER BY item.name_ar, ser.serial_no LIMIT 2000`,
  },
  {
    key: 'produced-items',
    titleAr: 'تقرير مواد المنتجة',
    group: 'inventory',
    hintAr: 'كل أمر إنتاج بسطر: المنتج ووحدته وكميته وتكلفته، مع إجمالي التكلفة وإجمالي البيع — «🏭 المواد المنتجة» في `frmRptProducedItems`.',
    // 📅 من تاريخ / إلى تاريخ.
    params: [...PERIOD],
    columns: [
      int('seq', '#'),
      text('order_no', 'رقم الأمر'),
      date('order_date', 'التاريخ'),
      text('item_name', 'الصنف'),
      text('unit_name', 'الوحدة'),
      qty('qty', 'الكمية'),
      money('price', 'السعر'),
      money('total', 'المجموع'),
      text('ref_no', 'رقم المرجع'),
      text('status_ar', 'الحالة'),
      { key: 'cost', labelAr: 'تكلفة المكونات', type: 'money', hidden: true },
      { key: 'sale', labelAr: 'قيمة البيع', type: 'money', hidden: true },
      countCard,
    ],
    totals: ['qty', 'total'],
    // «🏭 إجمالي المواد» · «📦 إجمالي الرصيد» · «💰 إجمالي التكلفة» · «💵 إجمالي البيع».
    grandTotal: [
      { key: 's_count', labelAr: 'إجمالي المواد' },
      { key: 'qty', labelAr: 'إجمالي الرصيد' },
      { key: 'cost', labelAr: 'إجمالي التكلفة' },
      { key: 'sale', labelAr: 'إجمالي البيع' },
    ],
    emptyAr: 'لا توجد أوامر إنتاج في هذه الفترة',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT row_number() OVER (ORDER BY po.order_date, po.number)::text AS seq,
             po.number AS order_no, to_char(po.order_date, 'YYYY-MM-DD') AS order_date,
             ${itemName} AS item_name, coalesce(uom.name_ar, bu.name_ar, '—') AS unit_name,
             round(po.output_qty, 2)::text AS qty,
             round(po.unit_cost, 4)::text AS price,
             round(po.output_qty * po.unit_cost, 2)::text AS total,
             coalesce(po.reference_no, '—') AS ref_no,
             CASE po.status
               WHEN 'draft' THEN 'مسودة'
               WHEN 'completed' THEN 'مكتمل'
               WHEN 'cancelled' THEN 'ملغي'
               ELSE po.status
             END AS status_ar,
             '1' AS s_count,
             round(po.component_cost, 2)::text AS cost,
             round(po.output_qty * coalesce(item.sale_price, 0), 2)::text AS sale
      FROM production_orders po
      JOIN items item ON item.id = po.output_item_id
      LEFT JOIN units_of_measure uom ON uom.id = po.unit_id
      LEFT JOIN units_of_measure bu ON bu.id = item.base_unit_id
      WHERE po.tenant_id = ${tenantId}
        AND po.status <> 'cancelled'
        AND ${onDate(sql`po.order_date`, f.from, f.to)}
      ORDER BY po.order_date, po.number LIMIT 2000`,
  },
  {
    key: 'produced-components',
    titleAr: 'مكونات المواد المنتجة',
    group: 'inventory',
    hintAr: 'ما استهلكه كل أمر إنتاج: مكوّناً بمكوّن مع كميته وسعره وتكلفته — «🔧 المكونات» في `frmRptProducedItems`.',
    // 📅 من تاريخ / إلى تاريخ.
    params: [...PERIOD],
    columns: [
      int('seq', '#'),
      text('order_no', 'رقم الأمر'),
      date('order_date', 'التاريخ'),
      text('item_name', 'الصنف'),
      text('unit_name', 'الوحدة'),
      qty('qty', 'الكمية'),
      money('price', 'السعر'),
      money('total', 'المجموع'),
    ],
    totals: ['qty', 'total'],
    grandTotal: [{ key: 'total', labelAr: 'إجمالي التكلفة' }],
    emptyAr: 'لا توجد مكونات مستهلكة في هذه الفترة',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT row_number() OVER (ORDER BY po.order_date, po.number, comp.line_no)::text AS seq,
             po.number AS order_no, to_char(po.order_date, 'YYYY-MM-DD') AS order_date,
             ${itemName} AS item_name, coalesce(uom.name_ar, bu.name_ar, '—') AS unit_name,
             round(comp.qty, 2)::text AS qty,
             round(comp.unit_cost, 4)::text AS price,
             round(coalesce(nullif(comp.line_cost, 0), comp.qty * comp.unit_cost), 2)::text AS total
      FROM production_order_components comp
      JOIN production_orders po ON po.id = comp.order_id
      JOIN items item ON item.id = comp.item_id
      LEFT JOIN units_of_measure uom ON uom.id = comp.unit_id
      LEFT JOIN units_of_measure bu ON bu.id = item.base_unit_id
      WHERE comp.tenant_id = ${tenantId}
        AND po.status <> 'cancelled'
        AND ${onDate(sql`po.order_date`, f.from, f.to)}
      ORDER BY po.order_date, po.number, comp.line_no LIMIT 2000`,
  },
  // ------------------------------------------------ 📒 accounting — تقارير المحاسبة
  {
    key: 'account-balances',
    titleAr: 'أرصدة الحسابات',
    group: 'accounting',
    hintAr: 'كل حساب تحت «الحساب الرئيسي» بسطر: رصيده الافتتاحي وحركته في الفترة ورصيده الختامي، على الوجهين المدين والدائن كما في `frmRptBalances`.',
    // 📊 الحساب الرئيسي · 🏢 الفرع · 🧑‍💼 المندوب · 📅 من / إلى + ⏰ الوقت.
    params: [MAIN_ACCOUNT, BRANCH, SALESMAN, PERIOD[0]!, TIME_FROM_TO[0]!, PERIOD[1]!, TIME_FROM_TO[1]!],
    columns: [
      text('code', 'الحساب'),
      text('account', 'اسم الحساب'),
      money('opening_debit', 'رصيد افتتاحي مدين'),
      money('opening_credit', 'رصيد افتتاحي دائن'),
      money('move_debit', 'حركة مدين'),
      money('move_credit', 'حركة دائن'),
      money('bal_debit', 'رصيد مدين'),
      money('bal_credit', 'رصيد دائن'),
      money('final_debit', 'رصيد ختامي مدين'),
      money('final_credit', 'رصيد ختامي دائن'),
      { key: 's_net_debit', labelAr: 'الرصيد (مدين)', type: 'money', hidden: true },
      { key: 's_net_credit', labelAr: 'الرصيد (دائن)', type: 'money', hidden: true },
      countCard,
    ],
    totals: [
      'opening_debit',
      'opening_credit',
      'move_debit',
      'move_credit',
      'bal_debit',
      'bal_credit',
      'final_debit',
      'final_credit',
    ],
    // «الرصيد:» + مدين/دائن — `txtBalance` و`lblStatus` in `frmRptBalances.xaml` L466-L480.
    grandTotal: [
      { key: 's_net_debit', labelAr: 'الرصيد (مدين)' },
      { key: 's_net_credit', labelAr: 'الرصيد (دائن)' },
      { key: 's_count', labelAr: 'عدد الحسابات' },
    ],
    emptyAr: 'لا توجد حسابات تحت هذا الحساب الرئيسي',
    signature: true,
    build: (tenantId, f) => sql`
      WITH movement AS (
        SELECT jel.account_id,
               coalesce(sum(jel.debit) FILTER (WHERE je.source_type = 'opening'), 0) AS od,
               coalesce(sum(jel.credit) FILTER (WHERE je.source_type = 'opening'), 0) AS oc,
               coalesce(sum(jel.debit) FILTER (WHERE je.source_type IS DISTINCT FROM 'opening'), 0) AS md,
               coalesce(sum(jel.credit) FILTER (WHERE je.source_type IS DISTINCT FROM 'opening'), 0) AS mc
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.entry_id
        WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted'
          AND ${onDate(sql`je.date`, f.from, f.to)}
          AND ${eqIf(sql`je.branch_id`, f.branchId)}
          AND ${eqIf(sql`jel.salesman_id`, f.salesmanId)}
        GROUP BY jel.account_id
      ), base AS (
        SELECT acc.code, acc.name_ar AS account,
               round(m.od, 2) AS opening_debit, round(m.oc, 2) AS opening_credit,
               round(m.md, 2) AS move_debit, round(m.mc, 2) AS move_credit,
               round(greatest(m.md - m.mc, 0), 2) AS bal_debit,
               round(greatest(m.mc - m.md, 0), 2) AS bal_credit
        FROM movement m
        JOIN accounts acc ON acc.id = m.account_id
        WHERE acc.tenant_id = ${tenantId} AND acc.deleted_at IS NULL AND ${accountSubtree(tenantId, f.accountId)}
      ), closing AS (
        SELECT b.*,
               greatest((b.opening_debit + b.bal_debit) - (b.opening_credit + b.bal_credit), 0) AS final_debit,
               greatest((b.opening_credit + b.bal_credit) - (b.opening_debit + b.bal_debit), 0) AS final_credit
        FROM base b
      )
      SELECT code, account, opening_debit::text, opening_credit::text, move_debit::text, move_credit::text,
             bal_debit::text, bal_credit::text,
             round(final_debit, 2)::text AS final_debit, round(final_credit, 2)::text AS final_credit,
             CASE WHEN row_number() OVER (ORDER BY code) = 1
                  THEN greatest(sum(final_debit) OVER () - sum(final_credit) OVER (), 0)::text ELSE '0' END AS s_net_debit,
             CASE WHEN row_number() OVER (ORDER BY code) = 1
                  THEN greatest(sum(final_credit) OVER () - sum(final_debit) OVER (), 0)::text ELSE '0' END AS s_net_credit,
             '1' AS s_count
      FROM closing ORDER BY code LIMIT 2000`,
  },
  {
    key: 'journal-entries',
    titleAr: 'القيود اليومية',
    group: 'accounting',
    hintAr: 'سجلّ القيود كما في «🔍 البحث» في `frmRptEntries`: رقم القيد ورقم المستند وتاريخه ونوعه وحالته وبيانه.',
    // 📅 من / إلى · 🏢 الفرع · 🧾 نوع القيد · 📋 حالة القيد · 🔢 رقم القيد · 📄 رقم المستند.
    params: [...PERIOD, BRANCH, ENTRY_TYPE, ENTRY_STATE, ENTRY_NO, DOC_NO],
    columns: [
      text('global_id', 'الرقم العام'),
      text('doc_no', 'رقم المستند'),
      date('entry_date', 'تاريخ القيد'),
      text('entry_type', 'نوع القيد'),
      text('state_ar', 'حالة القيد'),
      text('description', 'البيان'),
      text('entry_no', 'رقم القيد'),
      countCard,
    ],
    grandTotal: [{ key: 's_count', labelAr: 'عدد القيود' }],
    emptyAr: 'لا توجد قيود في هذه الفترة',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT je.id::text AS global_id,
             ${journalDocNumber} AS doc_no,
             to_char(je.date, 'YYYY-MM-DD') AS entry_date,
             ${entryTypeLabel()} AS entry_type,
             CASE WHEN je.status <> 'posted' THEN 'مسودة'
                  WHEN EXISTS (SELECT 1 FROM journal_entries rev
                               WHERE rev.tenant_id = ${tenantId} AND rev.reversal_of = je.id) THEN 'لاغي'
                  ELSE 'معتمد' END AS state_ar,
             coalesce(je.description, '—') AS description,
             coalesce(je.number, '—') AS entry_no,
             '1' AS s_count
      FROM journal_entries je
      ${journalDocumentJoins}
      WHERE ${journalScope(tenantId, f)}
      ORDER BY je.id LIMIT 2000`,
  },
  {
    key: 'journal-entry-lines',
    titleAr: 'تفاصيل القيد',
    group: 'accounting',
    hintAr: 'سطور القيود كما في «🧾 تفاصيل القيد»: م · مدين · دائن · كود الحساب · اسم الحساب · مركز التكلفة · البيان.',
    // 📅 من / إلى · 🏢 الفرع · 🧾 نوع القيد · 📊 مركز التكلفة · 📒 الحساب.
    params: [...PERIOD, BRANCH, ENTRY_TYPE, COST_CENTER, ACCOUNT],
    columns: [
      text('entry_no', 'رقم القيد'),
      int('seq', 'م'),
      money('debit', 'مدين'),
      money('credit', 'دائن'),
      text('code', 'كود الحساب'),
      text('account', 'اسم الحساب'),
      text('cost_center', 'مركز التكلفة'),
      text('description', 'البيان'),
      { key: 's_diff', labelAr: 'الفرق', type: 'money', hidden: true },
      countCard,
    ],
    totals: ['debit', 'credit'],
    // «إجمالي المدين:» · «إجمالي الدائن:» — `frmRptEntries.xaml` L402 و L414. «الفرق» carries
    // the number «✅ قيد متوازن» / «❌ قيد غير متوازن» (L291 و L298) compares against zero.
    grandTotal: [
      { key: 'debit', labelAr: 'إجمالي المدين' },
      { key: 'credit', labelAr: 'إجمالي الدائن' },
      { key: 's_diff', labelAr: 'الفرق' },
      { key: 's_count', labelAr: 'عدد السطور' },
    ],
    emptyAr: 'لا توجد سطور قيود في هذه الفترة',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT coalesce(je.number, '—') AS entry_no,
             jel.line_no AS seq,
             round(jel.debit, 2)::text AS debit,
             round(jel.credit, 2)::text AS credit,
             acc.code, acc.name_ar AS account,
             coalesce(cc.name_ar, '—') AS cost_center,
             coalesce(jel.description, je.description, '—') AS description,
             round(jel.debit - jel.credit, 2)::text AS s_diff,
             '1' AS s_count
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.entry_id
      JOIN accounts acc ON acc.id = jel.account_id
      LEFT JOIN cost_centers cc ON cc.id = jel.cost_center_id
      WHERE ${journalLineScope(tenantId, f)} AND je.status = 'posted'
      ORDER BY je.date, je.number, jel.line_no LIMIT 2000`,
  },
  {
    key: 'income-statement-accounts',
    titleAr: 'أرباح وخسائر حسابات رئيسية',
    group: 'accounting',
    hintAr: 'حسابات `FinalAcc = 2` (الإيرادات والمصروفات) مُجمَّعة على حساباتها الرئيسية، مع قيمة مخزون آخر المدة وصافي نتيجة العام — `frmRptIncomeStatement`.',
    // 📅 من / إلى + ⏰ الوقت · 🏢 الفرع.
    params: [...PERIOD, BRANCH],
    columns: [
      text('code', 'الحساب'),
      text('account', 'اسم الحساب'),
      money('debit_balance', 'رصيد مدين'),
      money('credit_balance', 'رصيد دائن'),
      { key: 's_profit', labelAr: 'صافي أرباح العام', type: 'money', hidden: true },
      countCard,
    ],
    totals: ['debit_balance', 'credit_balance'],
    // «قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ» · «صافي أرباح العام» · المجاميع —
    // `frmRptIncomeStatement.xaml` L402, L425 و L447-L453.
    grandTotal: [
      { key: 'debit_balance', labelAr: 'إجمالي مدين' },
      { key: 'credit_balance', labelAr: 'إجمالي دائن' },
      { key: 's_profit', labelAr: 'صافي أرباح العام' },
      { key: 's_count', labelAr: 'عدد الحسابات' },
    ],
    emptyAr: 'لا توجد حسابات إيرادات أو مصروفات في هذه الفترة',
    signature: true,
    build: (tenantId, f) => sql`
      WITH movement AS (
        SELECT coalesce(parent.id, acc.id) AS account_id,
               sum(jel.debit) AS debit, sum(jel.credit) AS credit
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.entry_id
        JOIN accounts acc ON acc.id = jel.account_id
        LEFT JOIN accounts parent ON parent.id = acc.parent_id
        WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted' AND acc.type IN ('revenue', 'expense')
          AND ${onDate(sql`je.date`, f.from, f.to)} AND ${eqIf(sql`je.branch_id`, f.branchId)}
        GROUP BY 1
      )
      SELECT u.code, u.account, round(u.debit_balance, 2)::text AS debit_balance,
             round(u.credit_balance, 2)::text AS credit_balance,
             round(u.s_profit, 2)::text AS s_profit, u.s_count
      FROM (
        SELECT a.code, a.name_ar AS account,
               greatest(m.debit - m.credit, 0) AS debit_balance,
               greatest(m.credit - m.debit, 0) AS credit_balance,
               m.credit - m.debit AS s_profit, '1' AS s_count, 1 AS ord
        FROM movement m JOIN accounts a ON a.id = m.account_id
        UNION ALL
        SELECT '—', 'قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ',
               0, ${stockValueAt(tenantId, f)}, ${stockValueAt(tenantId, f)}, '0', 2
      ) u
      ORDER BY u.ord, u.code LIMIT 2000`,
  },
  {
    key: 'cost-center-statement',
    titleAr: 'تقرير مراكز التكلفة',
    group: 'accounting',
    hintAr: 'مركز التكلفة وما تحته: الرصيد الافتتاحي والحركة والرصيد الختامي على الوجهين، «تجميعي» بسطر لكل حساب و«تفصيلي» بسطر لكل حركة — `frmRptCostCenter`.',
    // 📂 مركز التكلفة · 📒 الحساب · 📋 نوع التقرير · 🏢 الفرع · 📅 من / إلى + ⏰ الوقت.
    params: [
      COST_CENTER,
      ACCOUNT,
      COST_CENTER_MODE,
      BRANCH,
      PERIOD[0]!,
      TIME_CC[0]!,
      PERIOD[1]!,
      TIME_CC[1]!,
    ],
    columns: [
      text('code', 'الرمز'),
      text('cost_center', 'اسم مركز التكلفة'),
      money('opening_debit', 'رصيد افتتاحي مدين'),
      money('opening_credit', 'رصيد افتتاحي دائن'),
      money('move_debit', 'حركة مدين'),
      money('move_credit', 'حركة دائن'),
      money('bal_debit', 'رصيد مدين'),
      money('bal_credit', 'رصيد دائن'),
      money('final_debit', 'رصيد ختامي مدين'),
      money('final_credit', 'رصيد ختامي دائن'),
      text('account_name', 'اسم الحساب'),
      text('operation', 'العملية'),
      text('operation_no', 'رقم العملية'),
      date('entry_date', 'التاريخ'),
      countCard,
    ],
    totals: [
      'opening_debit',
      'opening_credit',
      'move_debit',
      'move_credit',
      'bal_debit',
      'bal_credit',
      'final_debit',
      'final_credit',
    ],
    // «عدد السجلات:» — `lblCount` in `frmRptCostCenter.xaml` L498-L503.
    grandTotal: [{ key: 's_count', labelAr: 'عدد السجلات' }],
    emptyAr: 'لا توجد حركة على مراكز التكلفة في هذه الفترة',
    signature: true,
    build: (tenantId, f) => {
      const detailed = f.kind === 'detailed';
      const shared = sql`
        jel.tenant_id = ${tenantId} AND je.status = 'posted' AND jel.cost_center_id IS NOT NULL
        AND ${onDate(sql`je.date`, f.from, f.to)}
        AND ${eqIf(sql`je.branch_id`, f.branchId)}
        AND ${eqIf(sql`jel.account_id`, f.accountId)}
      `;
      if (!detailed) {
        return sql`
          WITH RECURSIVE ${COST_CENTER_TREE(tenantId, f.costCenterId)}, agg AS (
            SELECT jel.cost_center_id AS cc_id, jel.account_id,
                   coalesce(sum(jel.debit) FILTER (WHERE je.source_type = 'opening'), 0) AS od,
                   coalesce(sum(jel.credit) FILTER (WHERE je.source_type = 'opening'), 0) AS oc,
                   coalesce(sum(jel.debit) FILTER (WHERE je.source_type IS DISTINCT FROM 'opening'), 0) AS md,
                   coalesce(sum(jel.credit) FILTER (WHERE je.source_type IS DISTINCT FROM 'opening'), 0) AS mc
            FROM journal_entry_lines jel
            JOIN journal_entries je ON je.id = jel.entry_id
            WHERE ${shared}
            GROUP BY 1, 2
          )
          SELECT cc.code, cc.name_ar AS cost_center,
                 round(a.od, 2)::text AS opening_debit, round(a.oc, 2)::text AS opening_credit,
                 round(a.md, 2)::text AS move_debit, round(a.mc, 2)::text AS move_credit,
                 round(greatest(a.md - a.mc, 0), 2)::text AS bal_debit,
                 round(greatest(a.mc - a.md, 0), 2)::text AS bal_credit,
                 round(greatest((a.od + greatest(a.md - a.mc, 0)) - (a.oc + greatest(a.mc - a.md, 0)), 0), 2)::text AS final_debit,
                 round(greatest((a.oc + greatest(a.mc - a.md, 0)) - (a.od + greatest(a.md - a.mc, 0)), 0), 2)::text AS final_credit,
                 acc.name_ar AS account_name,
                 '' AS operation, '' AS operation_no, NULL::date AS entry_date,
                 '1' AS s_count
          FROM agg a
          JOIN cost_centers cc ON cc.id = a.cc_id
          JOIN accounts acc ON acc.id = a.account_id
          WHERE ${costCenterSubtree(f.costCenterId)}
          ORDER BY cc.code, acc.code LIMIT 2000`;
      }
      return sql`
        WITH movements AS (
          SELECT jel.cost_center_id AS cc_id, jel.account_id, jel.line_no, jel.debit, jel.credit,
                 je.id AS entry_id,
                 coalesce(sum(jel.debit) FILTER (WHERE je.source_type = 'opening')
                          OVER (PARTITION BY jel.cost_center_id), 0) AS od,
                 coalesce(sum(jel.credit) FILTER (WHERE je.source_type = 'opening')
                          OVER (PARTITION BY jel.cost_center_id), 0) AS oc
          FROM journal_entry_lines jel
          JOIN journal_entries je ON je.id = jel.entry_id
          WHERE ${shared}
        )
        SELECT cc.code, cc.name_ar AS cost_center,
               round(m.od, 2)::text AS opening_debit, round(m.oc, 2)::text AS opening_credit,
               round(m.debit, 2)::text AS move_debit, round(m.credit, 2)::text AS move_credit,
               round(greatest(m.debit - m.credit, 0), 2)::text AS bal_debit,
               round(greatest(m.credit - m.debit, 0), 2)::text AS bal_credit,
               round(greatest((m.od + greatest(m.debit - m.credit, 0)) - (m.oc + greatest(m.credit - m.debit, 0)), 0), 2)::text AS final_debit,
               round(greatest((m.oc + greatest(m.credit - m.debit, 0)) - (m.od + greatest(m.debit - m.credit, 0)), 0), 2)::text AS final_credit,
               acc.name_ar AS account_name,
               ${entryTypeLabel()} AS operation,
               ${journalDocNumber} AS operation_no,
               je.date AS entry_date,
               '1' AS s_count
        FROM movements m
        JOIN journal_entries je ON je.id = m.entry_id
        JOIN cost_centers cc ON cc.id = m.cc_id
        JOIN accounts acc ON acc.id = m.account_id
        ${journalDocumentJoins}
        WHERE ${costCenterChildren(tenantId, f.costCenterId)}
        ORDER BY je.date, je.number, m.line_no LIMIT 2000`;
    },
  },
  {
    key: 'vat-return-period',
    titleAr: 'إقرار ضريبي',
    group: 'accounting',
    hintAr: 'الإقرار الضريبي للفترة كما يطبعه `TaxRptPeriod.repx`: المبيعات والمشتريات ببنودهما الستة، وصافي الضريبة المستحقة.',
    // 📅 من تاريخ / إلى تاريخ · 🏢 الفرع · 📆 ربع سنة · 📆 شهري.
    params: [...PERIOD, BRANCH, TAX_QUARTER, TAX_MONTH],
    columns: [
      text('section', 'القسم'),
      text('line', 'الوصف'),
      money('net', 'الصافي'),
      money('vat', 'الضريبة'),
      { key: 's_net_vat', labelAr: 'صافي ضريبة القيمة المضافة', type: 'money', hidden: true },
    ],
    // «صافي ضريبة القيمة المضافة» — `TaxRptPeriod.repx` L700-L744, the one number the
    // window prints in red («مستحق الدفع للهيئة») or green («غير مستحق»).
    grandTotal: [{ key: 's_net_vat', labelAr: 'صافي ضريبة القيمة المضافة' }],
    emptyAr: 'لا توجد بيانات ضريبية في هذه الفترة',
    signature: true,
    build: (tenantId, f) => {
      const range = taxPeriodRange(f);
      const period = onDate(sql`je.date`, range.from, range.to);
      const date = (column: SQL) => onDate(column, range.from, range.to);
      return sql`
        WITH sale_lines AS (
          SELECT si.kind AS kind, sil.net AS net, sil.tax AS tax
          FROM sales_invoice_lines sil
          JOIN sales_invoices si ON si.id = sil.invoice_id
          WHERE si.tenant_id = ${tenantId} AND si.status = 'posted' AND si.kind IN ('sale', 'sale_return')
            AND ${date(sql`si.posted_at::date`)} AND ${eqIf(sql`si.branch_id`, f.branchId)}
        ), purchase_lines AS (
          SELECT pi.kind AS kind, pil.net AS net, pil.tax AS tax
          FROM purchase_invoice_lines pil
          JOIN purchase_invoices pi ON pi.id = pil.invoice_id
          WHERE pi.tenant_id = ${tenantId} AND pi.status = 'posted' AND pi.kind IN ('purchase', 'purchase_return')
            AND ${date(sql`pi.posted_at::date`)} AND ${eqIf(sql`pi.branch_id`, f.branchId)}
        ), s AS (
          SELECT coalesce(sum(net) FILTER (WHERE tax <> 0 AND kind = 'sale'), 0)
               - coalesce(sum(net) FILTER (WHERE tax <> 0 AND kind = 'sale_return'), 0) AS taxed_net,
                 coalesce(sum(tax) FILTER (WHERE tax <> 0 AND kind = 'sale'), 0)
               - coalesce(sum(tax) FILTER (WHERE tax <> 0 AND kind = 'sale_return'), 0) AS taxed_vat,
                 coalesce(sum(net) FILTER (WHERE tax = 0 AND kind = 'sale'), 0)
               - coalesce(sum(net) FILTER (WHERE tax = 0 AND kind = 'sale_return'), 0) AS exempt_net
          FROM sale_lines
        ), p AS (
          SELECT coalesce(sum(net) FILTER (WHERE tax <> 0 AND kind = 'purchase'), 0)
               - coalesce(sum(net) FILTER (WHERE tax <> 0 AND kind = 'purchase_return'), 0) AS taxed_net,
                 coalesce(sum(tax) FILTER (WHERE tax <> 0 AND kind = 'purchase'), 0)
               - coalesce(sum(tax) FILTER (WHERE tax <> 0 AND kind = 'purchase_return'), 0) AS taxed_vat,
                 coalesce(sum(net) FILTER (WHERE tax = 0 AND kind = 'purchase'), 0)
               - coalesce(sum(net) FILTER (WHERE tax = 0 AND kind = 'purchase_return'), 0) AS exempt_net
          FROM purchase_lines
        ), r AS (
          SELECT coalesce(sum(ri.net_amount), 0) AS net_total, coalesce(sum(ri.tax_amount), 0) AS vat_total
          FROM rental_invoices ri
          WHERE ri.tenant_id = ${tenantId} AND ri.status = 'posted' AND ${date(sql`ri.document_date`)}
        ), v AS (
          SELECT coalesce(sum(vr.amount) FILTER (WHERE vr.kind = 'receipt'), 0) AS receipts_net,
                 coalesce(${voucherVat('vr')} FILTER (WHERE vr.kind = 'receipt'), 0) AS receipts_vat,
                 coalesce(sum(vr.amount) FILTER (WHERE vr.kind = 'payment'), 0) AS payments_net,
                 coalesce(${voucherVat('vr')} FILTER (WHERE vr.kind = 'payment'), 0) AS payments_vat
          FROM vouchers vr
          WHERE vr.tenant_id = ${tenantId} AND vr.status = 'posted' AND ${date(sql`vr.date`)}
            AND ${eqIf(sql`vr.branch_id`, f.branchId)}
        ), vat_accounts AS (
          SELECT tg.vat_account_id FROM tax_groups tg
          WHERE tg.tenant_id = ${tenantId} AND tg.vat_account_id IS NOT NULL
        ), j AS (
          SELECT coalesce(sum(jel.debit) FILTER (WHERE jel.account_id NOT IN (SELECT vat_account_id FROM vat_accounts)), 0) AS net_total,
                 coalesce(sum(jel.debit) FILTER (WHERE jel.account_id IN (SELECT vat_account_id FROM vat_accounts)), 0) AS vat_total
          FROM journal_entry_lines jel
          JOIN journal_entries je ON je.id = jel.entry_id
          WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted' AND je.is_vat
            AND ${period} AND ${eqIf(sql`je.branch_id`, f.branchId)}
        )
        SELECT u.section, u.line, round(u.net, 2)::text AS net, round(u.vat, 2)::text AS vat,
               round(u.s_net_vat, 2)::text AS s_net_vat
        FROM s CROSS JOIN p CROSS JOIN r CROSS JOIN v CROSS JOIN j
        CROSS JOIN LATERAL (VALUES
          (1, 'ضريبة القيمة المضافة على المبيعات', 'المبيعات الخاضعة للنسبة الأساسية', s.taxed_net::numeric, s.taxed_vat::numeric, s.taxed_vat::numeric),
          (2, 'ضريبة القيمة المضافة على المبيعات', 'الإيرادات الأخرى', r.net_total::numeric, r.vat_total::numeric, r.vat_total::numeric),
          (3, 'ضريبة القيمة المضافة على المبيعات', 'سندات القبض', v.receipts_net::numeric, v.receipts_vat::numeric, v.receipts_vat::numeric),
          (4, 'ضريبة القيمة المضافة على المبيعات', 'المبيعات المحلية الخاضعة للنسبة الصفرية', 0::numeric, 0::numeric, 0::numeric),
          (5, 'ضريبة القيمة المضافة على المبيعات', 'المبيعات المعفاة', s.exempt_net::numeric, 0::numeric, 0::numeric),
          (6, 'ضريبة القيمة المضافة على المبيعات', 'صافي المبيعات',
             (s.taxed_net + r.net_total + v.receipts_net)::numeric,
             (s.taxed_vat + r.vat_total + v.receipts_vat)::numeric, 0::numeric),
          (7, 'ضريبة القيمة المضافة على المشتريات', 'المشتريات الخاضعة للنسبة الأساسية', p.taxed_net::numeric, p.taxed_vat::numeric, -p.taxed_vat::numeric),
          (8, 'ضريبة القيمة المضافة على المشتريات', 'الإستيرادات الخاضعة للقيمة المضافة بالنسبة الأساسية', 0::numeric, 0::numeric, 0::numeric),
          (9, 'ضريبة القيمة المضافة على المشتريات', 'سندات الصرف',
             (v.payments_net + j.net_total)::numeric,
             (v.payments_vat + j.vat_total)::numeric,
             -(v.payments_vat + j.vat_total)::numeric),
          (10, 'ضريبة القيمة المضافة على المشتريات', 'الإستيرادات الخاضعة للقيمة المضافة التي تطبق عليها آلية الاحتساب العكسي', 0::numeric, 0::numeric, 0::numeric),
          (11, 'ضريبة القيمة المضافة على المشتريات', 'المشتريات المعفاة', p.exempt_net::numeric, 0::numeric, 0::numeric),
          (12, 'ضريبة القيمة المضافة على المشتريات', 'صافي المشتريات',
             (p.taxed_net + v.payments_net + j.net_total)::numeric,
             (p.taxed_vat + v.payments_vat + j.vat_total)::numeric, 0::numeric),
          (13, 'صافي ضريبة القيمة المضافة',
             CASE WHEN (s.taxed_vat + r.vat_total + v.receipts_vat) - (p.taxed_vat + v.payments_vat + j.vat_total) > 0
                  THEN 'مستحق الدفع للهيئة' ELSE 'غير مستحق' END,
             0::numeric,
             ((s.taxed_vat + r.vat_total + v.receipts_vat) - (p.taxed_vat + v.payments_vat + j.vat_total))::numeric,
             0::numeric)
        ) AS u(ord, section, line, net, vat, s_net_vat)
        ORDER BY u.ord`;
    },
  },
  // ---------------------------------------------- 💰 treasury · hrm · users · marina
  {
    key: 'cash-statement',
    titleAr: 'حركة الصندوق',
    group: 'accounting',
    hintAr: 'كشفُ الصندوق كما في `frmRptKhzna`: سطر «رصيد سابق» يفتح الفترة، ثم حركةٌ بسطر مع رصيدٍ متحرك، ثم بطاقتا «الرصيد الإجمالي» و«رصيد الفترة المحددة».',
    // 🏦 الصندوق · 📅 الفترة (من تاريخ · من وقت · إلى تاريخ · إلى وقت) — ☑ كل الفترة is the absence of both dates.
    params: [CASH_LOCATION, PERIOD[0]!, TIME_FROM_TO[0]!, PERIOD[1]!, TIME_FROM_TO[1]!],
    columns: [
      int('seq', 'م'),
      text('operation', 'العملية'),
      text('doc_no', 'الرقم'),
      date('day', '📅 التاريخ'),
      money('income', '📥 وارد'),
      money('outcome', '📤 صادر'),
      money('balance', '⚖️ الرصيد'),
      text('note', '📝 البيان'),
      { key: 's_all', labelAr: 'الرصيد الإجمالي', type: 'money', hidden: true },
      { key: 's_period', labelAr: 'رصيد الفترة المحددة', type: 'money', hidden: true },
      countCard,
    ],
    totals: ['income', 'outcome'],
    // ⚖️ الرصيد الإجمالي · 📅 رصيد الفترة المحددة — `frmRptKhzna.xaml` L482 و L502.
    grandTotal: [
      { key: 's_all', labelAr: 'الرصيد الإجمالي' },
      { key: 's_period', labelAr: 'رصيد الفترة المحددة' },
      { key: 's_count', labelAr: 'عدد الحركات' },
    ],
    emptyAr: 'لا توجد حركة على هذا الصندوق في هذه الفترة',
    signature: true,
    build: (tenantId, f) => {
      const fromTime = f.fromTime || '00:00';
      const toTime = f.toTime || '23:59';
      const box = sql`(SELECT cl.account_id FROM cash_locations cl
                       WHERE cl.id = ${f.cashLocationId ?? null}::uuid AND cl.tenant_id = ${tenantId})`;
      const opening = Boolean(f.from);
      return sql`
        WITH prior AS (
          SELECT coalesce(sum(jel.debit), 0) AS income, coalesce(sum(jel.credit), 0) AS outcome
          FROM journal_entry_lines jel
          JOIN journal_entries je ON je.id = jel.entry_id
          LEFT JOIN vouchers v ON v.id = je.source_id AND je.source_type = 'voucher'
          WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted' AND jel.account_id = ${box}
            AND ${f.from ? sql`je.date < ${f.from}::date
                 OR (je.date = ${f.from}::date AND coalesce(v.voucher_time, '00:00') < ${fromTime}::time)` : sql`false`}
        ), movements AS (
          SELECT je.id AS entry_id, je.date AS day, coalesce(je.number, '—') AS doc_no,
                 coalesce(je.description, '') AS note,
                 sum(jel.debit) AS income, sum(jel.credit) AS outcome
          FROM journal_entry_lines jel
          JOIN journal_entries je ON je.id = jel.entry_id
          LEFT JOIN vouchers v ON v.id = je.source_id AND je.source_type = 'voucher'
          WHERE jel.tenant_id = ${tenantId} AND je.status = 'posted' AND jel.account_id = ${box}
            AND ${onDate(sql`je.date`, f.from, f.to)}
            AND coalesce(v.voucher_time, '00:00') BETWEEN ${fromTime}::time AND ${toTime}::time
          GROUP BY je.id, je.date, je.number, je.description
        ), ledger AS (
          SELECT 1 AS ord, 'رصيد سابق' AS operation, '—' AS doc_no,
                 ${f.from ? sql`(${f.from}::date - 1)` : sql`NULL::date`} AS day,
                 p.income, p.outcome, '' AS note, NULL::uuid AS entry_id
          FROM prior p WHERE ${opening ? all : sql`false`}
          UNION ALL
          SELECT 2, ${entryTypeLabel()}, m.doc_no, m.day, m.income, m.outcome, m.note, m.entry_id
          FROM movements m
          JOIN journal_entries je ON je.id = m.entry_id
          ${journalDocumentJoins}
        )
        SELECT row_number() OVER (ORDER BY l.ord, l.day NULLS LAST, l.doc_no) AS seq,
               l.operation, l.doc_no, l.day,
               round(l.income, 2)::text AS income, round(l.outcome, 2)::text AS outcome,
               round(sum(l.income - l.outcome) OVER (ORDER BY l.ord, l.day NULLS LAST, l.doc_no
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 2)::text AS balance,
               l.note,
               CASE WHEN row_number() OVER (ORDER BY l.ord, l.day NULLS LAST, l.doc_no) = 1
                    THEN round(sum(l.income - l.outcome) OVER (), 2)::text ELSE '0' END AS s_all,
               CASE WHEN row_number() OVER (ORDER BY l.ord, l.day NULLS LAST, l.doc_no) = 1
                    THEN round(sum(CASE WHEN l.ord = 2 THEN l.income - l.outcome ELSE 0 END) OVER (), 2)::text ELSE '0' END AS s_period,
               '1' AS s_count
        FROM ledger l ORDER BY l.ord, l.day NULLS LAST, l.doc_no LIMIT 2000`;
    },
  },
  {
    key: 'salary-statement',
    titleAr: 'تقرير الرواتب',
    group: 'hrm',
    hintAr: 'كل إذن صرف راتب بسطر: الراتب الأساسي وبدلاه والحوافز والإجمالي والخصومات والصافي — `frmRptSalary`.',
    // 📅 الشهر · السنة (☑ كل الفترة when either is left empty) · 🏢 الفرع.
    params: [SALARY_MONTH, SALARY_YEAR, BRANCH],
    columns: [
      int('seq', 'م'),
      text('doc_no', 'رقم السند'),
      text('employee', '👤 الموظف'),
      money('basic', 'الراتب الأساسي'),
      money('housing', 'بدل سكن'),
      money('transport', 'بدل مواصلات'),
      money('additions', 'الحوافز'),
      money('gross', '💰 الإجمالي'),
      money('deductions', 'الخصومات'),
      money('net', '💵 صافي الراتب'),
      countCard,
    ],
    totals: ['basic', 'housing', 'transport', 'additions', 'gross', 'deductions', 'net'],
    // «💰 إجمالي الرواتب:» — `frmRptSalary.xaml` L440; the window sums الصافي, not الإجمالي.
    grandTotal: [
      { key: 'net', labelAr: 'إجمالي الرواتب' },
      { key: 's_count', labelAr: 'عدد الإيذونات' },
    ],
    emptyAr: 'لا توجد إيذونات صرف راتب في هذه الفترة',
    signature: true,
    build: (tenantId, f) => {
      const pad = (value: number) => String(value).padStart(2, '0');
      // The window filters only when it could parse **both** boxes (`frmRptSalary.xaml.cs` L74-L82).
      const yearMonth =
        f.year && f.month && Number(f.year) > 0 && Number(f.month) > 0
          ? `${f.year}-${pad(Number(f.month))}`
          : undefined;
      return sql`
        SELECT row_number() OVER (ORDER BY sp.payment_date, sp.number) AS seq,
               coalesce(sp.number, '—') AS doc_no,
               coalesce(emp.name, '—') AS employee,
               round(sp.basic, 2)::text AS basic,
               round(sp.housing, 2)::text AS housing,
               round(sp.transport, 2)::text AS transport,
               round(sp.additions, 2)::text AS additions,
               round(sp.net + sp.deductions, 2)::text AS gross,
               round(sp.deductions, 2)::text AS deductions,
               round(sp.net, 2)::text AS net,
               '1' AS s_count
        FROM salary_payments sp
        LEFT JOIN employees emp ON emp.id = sp.employee_id
        WHERE sp.tenant_id = ${tenantId} AND sp.deleted_at IS NULL
          AND ${yearMonth ? sql`sp.year_month = ${yearMonth}` : all}
          AND ${eqIf(sql`sp.branch_id`, f.branchId)}
        ORDER BY sp.payment_date, sp.number LIMIT 2000`;
    },
  },
  {
    key: 'salary-reserved',
    titleAr: 'تقرير الرواتب المستحقة',
    group: 'hrm',
    hintAr: 'كل مسيّر رواتب مستحق بسطر: رقم سنده وتاريخه وفرعه وشهره وسنته وملاحظاته، مع عداد موظفيه ومستحقه — `frmRptReseved`.',
    // 📅 من · إلى — the window's only two filters.
    params: [...PERIOD],
    columns: [
      int('seq', 'م'),
      text('doc_no', 'رقم السند'),
      date('day', '📅 التاريخ'),
      text('branch', '🏬 الفرع'),
      text('month', 'الشهر'),
      text('year', 'السنة'),
      int('employees', 'عدد الموظفين'),
      money('gross', 'الإجمالي'),
      money('deductions', 'الخصومات'),
      money('net', 'صافي المستحق'),
      text('notes', '📝 ملاحظات'),
      countCard,
    ],
    totals: ['employees', 'gross', 'deductions', 'net'],
    // 💰 The desktop's footer is the detail grid it opens with 👁️ عرض
    // (`Salary_Res_Details`: Basic · Houses · travel · sal_add · Total · Sal_Sub · Net_Sal),
    // so the report carries its sum here instead of behind a button.
    grandTotal: [
      { key: 'net', labelAr: 'إجمالي المستحق' },
      { key: 's_count', labelAr: 'عدد المسيرات' },
    ],
    emptyAr: 'لا توجد رواتب مستحقة في هذه الفترة',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT row_number() OVER (ORDER BY run.year_month DESC) AS seq,
             coalesce(je.number, run.year_month) AS doc_no,
             coalesce(run.posted_at, run.created_at)::date AS day,
             coalesce(br.name_ar, '—') AS branch,
             split_part(run.year_month, '-', 2) AS month,
             split_part(run.year_month, '-', 1) AS year,
             count(line.employee_id)::text AS employees,
             round(coalesce(sum(line.gross), 0), 2)::text AS gross,
             round(coalesce(sum(line.deductions), 0), 2)::text AS deductions,
             round(coalesce(sum(line.net), 0), 2)::text AS net,
             coalesce(run.reversal_reason, '') AS notes,
             '1' AS s_count
      FROM payroll_runs run
      LEFT JOIN payroll_run_lines line ON line.run_id = run.id
      LEFT JOIN journal_entries je ON je.id = run.journal_entry_id
      LEFT JOIN branches br ON br.id = je.branch_id
      WHERE run.tenant_id = ${tenantId}
        AND ${onDate(sql`coalesce(run.posted_at, run.created_at)::date`, f.from, f.to)}
      GROUP BY run.id, run.year_month, run.reversal_reason, run.posted_at, run.created_at, je.number, br.name_ar
      ORDER BY run.year_month DESC LIMIT 1000`,
  },
  {
    key: 'user-records',
    titleAr: 'سجلات المستخدمين',
    group: 'hrm',
    hintAr: 'سجلّ عمليات المستخدمين كما في `frmrptUsersRecords`: التاريخ والجهاز والعملية والمستخدم، من `Log4NetLog` الذي يقابله سجلّ التدقيق.',
    // 👤 المستخدم (☑ الكل when it is left empty) · 📅 من/إلى.
    params: [ACTOR, ...PERIOD],
    columns: [
      int('seq', 'م'),
      text('at', '📅 التاريخ'),
      text('device', '🖥️ الجهاز'),
      text('operation', '📝 العملية'),
      text('actor', '👤 المستخدم'),
      countCard,
    ],
    grandTotal: [{ key: 's_count', labelAr: 'عدد السجلات' }],
    emptyAr: 'لا توجد سجلات لهذا المستخدم',
    signature: true,
    build: (tenantId, f) => sql`
      SELECT row_number() OVER (ORDER BY log.created_at DESC) AS seq,
             to_char(log.created_at, 'YYYY-MM-DD HH24:MI') AS at,
             ${auditDevice} AS device,
             log.action AS operation,
             coalesce(log.actor_label, '—') AS actor,
             '1' AS s_count
      FROM audit_log log
      WHERE log.tenant_id = ${tenantId}
        AND ${onDate(sql`log.created_at::date`, f.from, f.to)}
        AND ${actorUserScope(f.salesmanId)}
      ORDER BY log.created_at DESC LIMIT 1000`,
  },
  {
    key: 'rent-invoices',
    titleAr: 'تقرير فواتير التأجير',
    group: 'marina',
    hintAr: 'فواتير التأجير ببنودها كما في `frmRptRentInvoices`، و«حجوزات» ما لم يُصدر له فاتورة بعد، مع إيرادات الفترة ومرتجعها وصافيها.',
    // 👤 المستخدم · 📁 الفئة · 👥 العميل · 📅 من/إلى · 🔢 رقم الفاتورة · ⚙️ نوع العملية · 📋 الخطة.
    params: [...PERIOD, BRANCH, RENT_CUSTOMER, ACTOR, VESSEL_GROUP, RENT_INVOICE_NO, RENT_PROCESS, RENT_PLAN],
    columns: [
      text('number', 'الرقم'),
      text('vessel', 'المركب'),
      text('category', 'الفئة'),
      money('net', 'الصافي'),
      date('day', 'التاريخ'),
      text('customer', 'العميل'),
      text('actor', 'المستخدم'),
      text('mobile', 'الجوال'),
      text('in_plan', 'ضمن الخطة'),
      money('period_amount', 'قيمة الفترة'),
      money('additions_amount', 'الإضافات'),
      money('insurance_amount', 'التأمين'),
      money('total', 'الإجمالي'),
      int('companions', 'المرافقون'),
      { key: 's_income', labelAr: 'إيرادات', type: 'money', hidden: true },
      { key: 's_return', labelAr: 'مرتجع', type: 'money', hidden: true },
      { key: 's_net', labelAr: 'الصافي', type: 'money', hidden: true },
    ],
    totals: ['net', 'period_amount', 'additions_amount', 'insurance_amount', 'total', 'companions'],
    // «إيرادات:» · «مرتجع:» · «الصافي:» — `frmRptRentInvoices.xaml` L510 · L521 · L532, summed
    // the way `CalcIncome` (L258-L274) sums them: 1 و3 إيرادات، و2 مرتجع، و4 خارج الحساب.
    grandTotal: [
      { key: 's_income', labelAr: 'إيرادات' },
      { key: 's_return', labelAr: 'مرتجع' },
      { key: 's_net', labelAr: 'الصافي' },
    ],
    emptyAr: 'لا توجد فواتير تأجير في هذه الفترة',
    signature: true,
    build: (tenantId, f) => {
      const inPlan = (vessel: SQL, day: SQL) => sql`EXISTS (
        SELECT 1 FROM marina_operation_plan_lines pl
        JOIN marina_operation_plans op ON op.id = pl.plan_id
        WHERE pl.tenant_id = ${tenantId} AND pl.vessel_id = ${vessel} AND op.plan_date = ${day})`;
      const planScope = (vessel: SQL, day: SQL) =>
        f.status === 'in_plan'
          ? inPlan(vessel, day)
          : f.status === 'out_plan'
            ? sql`NOT ${inPlan(vessel, day)}`
            : all;
      return sql`
        WITH invoices AS (
          SELECT ri.id AS row_id, 1 AS ord,
                 CASE WHEN si.kind = 'sale_return' THEN 2
                      WHEN si.status = 'draft' THEN 3
                      ELSE 1 END AS proc_type,
                 coalesce(bk.number, ri.id::text) AS number,
                 coalesce(ves.name, '—') AS vessel,
                 coalesce(grp.code, grp.name, '—') AS category,
                 ri.net_amount AS net, ri.document_date AS day,
                 ${partyName} AS customer,
                 coalesce(usr.full_name, '—') AS actor,
                 coalesce(party.phone, '—') AS mobile,
                 ri.additions_amount, ri.insurance_amount, ri.period_amount, ri.total,
                 bk.companions, bk.vessel_id
          FROM rental_invoices ri
          JOIN marina_bookings bk ON bk.id = ri.booking_id
          LEFT JOIN sales_invoices si ON si.id = ri.sales_invoice_id
          LEFT JOIN vessels ves ON ves.id = bk.vessel_id
          LEFT JOIN vessel_groups grp ON grp.id = ves.group_id
          LEFT JOIN parties party ON party.id = bk.party_id
          LEFT JOIN users usr ON usr.id = ri.created_by
          WHERE ri.tenant_id = ${tenantId}
            AND ${onDate(sql`ri.document_date`, f.from, f.to)}
            AND ${eqIf(sql`bk.branch_id`, f.branchId)}
            AND ${eqIf(sql`bk.party_id`, f.partyId)}
            AND ${eqIf(sql`ves.group_id`, f.groupId)}
            AND ${f.docNo ? sql`coalesce(bk.number, '') = ${f.docNo}` : all}
            AND ${f.salesmanId ? sql`ri.created_by IN (SELECT m.user_id FROM memberships m
                 WHERE m.id = (SELECT emp.membership_id FROM employees emp WHERE emp.id = ${f.salesmanId}::uuid))` : all}
        ), reservations AS (
          SELECT bk.id AS row_id, 2 AS ord, 4 AS proc_type,
                 coalesce(bk.number, '—') AS number,
                 coalesce(ves.name, '—') AS vessel,
                 coalesce(grp.code, grp.name, '—') AS category,
                 bk.rental_amount + bk.insurance_amount
                   + (SELECT coalesce(sum(ba.amount), 0) FROM marina_booking_additions ba
                      WHERE ba.tenant_id = ${tenantId} AND ba.booking_id = bk.id) AS net,
                 bk.document_date AS day,
                 ${partyName} AS customer,
                 coalesce(usr.full_name, '—') AS actor,
                 coalesce(party.phone, '—') AS mobile,
                 0::numeric AS additions_amount, bk.insurance_amount, bk.rental_amount,
                 bk.rental_amount + bk.insurance_amount AS total,
                 bk.companions, bk.vessel_id
          FROM marina_bookings bk
          LEFT JOIN rental_invoices ri ON ri.booking_id = bk.id AND ri.tenant_id = ${tenantId}
          LEFT JOIN vessels ves ON ves.id = bk.vessel_id
          LEFT JOIN vessel_groups grp ON grp.id = ves.group_id
          LEFT JOIN parties party ON party.id = bk.party_id
          LEFT JOIN users usr ON usr.id = bk.created_by
          WHERE bk.tenant_id = ${tenantId} AND bk.deleted_at IS NULL AND ri.id IS NULL
            AND ${onDate(sql`bk.document_date`, f.from, f.to)}
            AND ${eqIf(sql`bk.branch_id`, f.branchId)}
            AND ${eqIf(sql`bk.party_id`, f.partyId)}
            AND ${eqIf(sql`ves.group_id`, f.groupId)}
            AND ${f.docNo ? sql`coalesce(bk.number, '') = ${f.docNo}` : all}
        ), rows AS (
          SELECT * FROM invoices
          UNION ALL
          SELECT * FROM reservations
        )
        SELECT u.number, u.vessel, u.category, round(u.net, 2)::text AS net, u.day, u.customer,
               u.actor, u.mobile,
               CASE WHEN ${inPlan(sql`u.vessel_id`, sql`u.day`)} THEN 'نعم' ELSE 'لا' END AS in_plan,
               round(u.period_amount, 2)::text AS period_amount,
               round(u.additions_amount, 2)::text AS additions_amount,
               round(u.insurance_amount, 2)::text AS insurance_amount,
               round(u.total, 2)::text AS total,
               u.companions::text AS companions,
               round(CASE WHEN u.proc_type IN (1, 3) THEN u.net ELSE 0 END, 2)::text AS s_income,
               round(CASE WHEN u.proc_type = 2 THEN u.net ELSE 0 END, 2)::text AS s_return,
               round(CASE WHEN u.proc_type IN (1, 3) THEN u.net WHEN u.proc_type = 2 THEN -u.net ELSE 0 END, 2)::text AS s_net
        FROM rows u
        WHERE ${rentProcessScope(f.kind)} AND ${planScope(sql`u.vessel_id`, sql`u.day`)}
        ORDER BY u.day DESC, u.number LIMIT 1000`;
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // 🔄 مزامنة الفواتير - ZATCA — `Form_WPF/frmInvsSyncStatusZatca.xaml` (559) +
  //    `.xaml.cs` (1165), phase 11 part three.
  //
  // The window is the desktop's answer to «which of my invoices did ZATCA accept?»: it
  // reads `Inv` and `InvContratct` (`ShowInvs` L176-L186), joins the authority's answer
  // from `zatcaresponse` (`GetZatcaMessage` L310-L327) and paints ✅ مرسل / ❌ لم يُرسل
  // from `Inv.ZatcaSent` (the `DataTrigger` of `DgvSyncStatus`).
  //
  // What the cloud does differently, and why:
  //
  //   • `Inv` ∪ `InvContratct` → one table. A contracting progress bill *is* a sales
  //     invoice here (`projects.service.postBill` creates one and stores it on
  //     `progress_bills.invoice_id`), so «مقاولات» is a real condition on `progress_bills`
  //     rather than a second `SELECT` glued on with `UNION ALL`.
  //   • `ZatcaSent` is not a column we keep: acceptance is `sales_invoices.zatca_status`
  //     ∈ {`cleared`, `reported`}, written by the filing step itself.
  //   • `RecalculateNetSummary` (L329-L345) keeps two running sums — `sum` for
  //     `proc_type = 1` and `sum1` for `proc_type = 2` — and the printed `NetTotal` is
  //     `sum - sum1` (`BuildReportDataSet` L1058). Three hidden columns carry them, so
  //     the cards under the grid are the grid's own numbers.
  //   • The desktop takes the *first* `zatcaresponse` row it happens to read; this takes
  //     the latest, ordered by `created_at`.
  // ════════════════════════════════════════════════════════════════════════════
  {
    key: 'einvoice-sync-status',
    titleAr: 'مزامنة الفواتير - ZATCA',
    group: 'zatca',
    hintAr:
      'كل فاتورةٍ مرحَّلة وحالة مزامنتها مع هيئة الزكاة: «✅ مرسل» لمن قُبل ترحيله أو تخليصه، و«❌ غير مرسل» لمن لم يُقبل بعد أو فشل. والرسالةُ نصُّ الهيئة نفسها. 🔄 مزامنة ZATCA تُرسل ما اخترته.',
    params: [SYNC_STATE, ZATCA_INVOICE_KIND, ZATCA_PERIOD[0]!, ZATCA_PERIOD[1]!, BRANCH],
    columns: [
      int('seq', 'م'),
      text('id', 'ID'),
      text('branch_name', 'الفرع'),
      text('kind_name', 'نوع الفاتورة'),
      text('number', 'رقم الفاتورة'),
      text('issued_at', 'التاريخ'),
      text('party_name', 'العميل'),
      text('user_name', 'المستخدم'),
      money('net', 'الصافي'),
      text('message', 'الرسالة'),
      text('sync_status', 'حالة المزامنة'),
      // «المستودع» — `DgvStore`, a column the window keeps hidden and the report prints
      // as `SafeName` (`BuildReportDataSet` L1046).
      { key: 'store_name', labelAr: 'المستودع', type: 'text', hidden: true },
      // 🔄 مزامنة ZATCA works on the rows the clerk ticked; the grid's checkbox needs the
      // invoice id even though the visible «ID» column already prints it.
      { key: 'invoice_id', labelAr: 'معرّف الفاتورة', type: 'text', hidden: true },
      { key: 'net_sale', labelAr: 'إجمالي الفواتير', type: 'money', hidden: true },
      { key: 'net_return', labelAr: 'إجمالي المرتجعات', type: 'money', hidden: true },
      { key: 'net_signed', labelAr: 'الصافي', type: 'money', hidden: true },
    ],
    grandTotal: [
      { key: 'net_sale', labelAr: 'إجمالي الفواتير' },
      { key: 'net_return', labelAr: 'إجمالي المرتجعات والإشعارات' },
      // `NetTotal` of `rptInvSumByClient.repx` — المبيعات ناقص المردودات.
      { key: 'net_signed', labelAr: 'الصافي' },
    ],
    emptyAr: 'لا توجد عمليات بالجدول',
    signature: true,
    build: (tenantId, f) => sql`
      WITH latest AS (
        SELECT DISTINCT ON (s.invoice_id)
               s.invoice_id, s.status, s.error, coalesce(s.response, '{}'::jsonb) AS response
        FROM einvoice_submissions s
        WHERE s.tenant_id = ${tenantId}
        ORDER BY s.invoice_id, s.created_at DESC, s.id DESC
      ), answers AS (
        SELECT l.invoice_id, l.status, l.error, l.response,
               CASE WHEN jsonb_typeof(l.response -> 'errorMessages') = 'array'
                    THEN l.response -> 'errorMessages' ELSE '[]'::jsonb END
               || CASE WHEN jsonb_typeof(l.response -> 'warningMessages') = 'array'
                    THEN l.response -> 'warningMessages' ELSE '[]'::jsonb END AS lines
        FROM latest l
      )
      SELECT (row_number() OVER w)::text AS seq,
             si.id::text AS id,
             si.id::text AS invoice_id,
             coalesce(branch.name_ar, '—') AS branch_name,
             -- «نوع الفاتورة» — 'InvoiceOper.GetInvoiceTypeAr' (L346-L378) for the four
             -- 'inv_type's this window reads, with 'GetCustomerTaxType' (L302) deciding
             -- between الضريبية and المبسطة: a customer with a tax number is 0100000.
             CASE WHEN coalesce(btrim(coalesce(party.tax_no, '')), '') <> '' THEN
                    CASE WHEN si.kind IN ('sale_return', 'credit_note')
                         THEN 'إشعار دائن للفاتورة الضريبية'
                         ELSE 'فاتورة ضريبية' END
                  ELSE CASE WHEN si.kind IN ('sale_return', 'credit_note')
                         THEN 'إشعار دائن للفاتورة الضريبية المبسطة'
                         ELSE 'فاتورة ضريبية مبسطة' END
             END AS kind_name,
             coalesce(si.number, '—') AS number,
             to_char(si.posted_at, 'YYYY-MM-DD HH24:MI:SS') AS issued_at,
             coalesce(party.name, si.cash_customer_name, '—') AS party_name,
             coalesce(usr.full_name, '—') AS user_name,
             round(si.total, 2)::text AS net,
             -- «الرسالة» — what the authority answered ('ZatcaResponse.Message'), in the
             -- desktop's own order: the filing's error, then its validation messages,
             -- then why it never left.
             coalesce(
               nullif(btrim(coalesce(a.error, '')), ''),
               nullif((SELECT string_agg(t.value, ' · ' ORDER BY t.ord)
                         FROM jsonb_array_elements_text(a.lines) WITH ORDINALITY AS t(value, ord)), ''),
               nullif(btrim(coalesce(a.response ->> 'message', '')), ''),
               ''
             ) AS message,
             CASE WHEN si.zatca_status IN ('cleared', 'reported') THEN '✅ مرسل' ELSE '❌ لم يُرسل' END AS sync_status,
             coalesce(wh.name, '—') AS store_name,
             round(CASE WHEN si.kind IN ('sale', 'debit_note') THEN si.total ELSE 0 END, 2)::text AS net_sale,
             round(CASE WHEN si.kind IN ('sale_return', 'credit_note') THEN si.total ELSE 0 END, 2)::text AS net_return,
             round(CASE WHEN si.kind IN ('sale', 'debit_note') THEN si.total ELSE -si.total END, 2)::text AS net_signed
      FROM sales_invoices si
      LEFT JOIN branches branch ON branch.id = si.branch_id
      LEFT JOIN parties party ON party.id = si.party_id
      LEFT JOIN users usr ON usr.id = si.created_by
      LEFT JOIN warehouses wh ON wh.id = si.warehouse_id
      LEFT JOIN answers a ON a.invoice_id = si.id
      WHERE si.tenant_id = ${tenantId}
        AND si.status = 'posted'
        AND si.voided_at IS NULL
        -- 'proc_type IN (1,2)' — a فاتورة and its مرتجع, never a مسوَّدة or a عرض سعر.
        AND si.kind IN ('sale', 'sale_return', 'credit_note', 'debit_note')
        AND ${onDate(sql`si.posted_at::date`, f.from, f.to)}
        AND ${eqIf(sql`si.branch_id`, f.branchId)}
        AND ${zatcaKindScope(f.kind)}
        AND ${zatcaSyncScope(f.status)}
      WINDOW w AS (ORDER BY si.posted_at DESC NULLS LAST, si.number DESC NULLS LAST)
      ORDER BY si.posted_at DESC NULLS LAST, si.number DESC NULLS LAST
      LIMIT 2000`,
  },
];

export const REPORT_DEFINITIONS: ReportDefinition[] = definitions;
export const REPORT_KEYS = definitions.map((definition) => definition.key);
export const reportByKey = new Map(definitions.map((definition) => [definition.key, definition]));
