# Reporting module

Phase 14 adds a registry-driven report read side. Report keys are centrally registered
in `REPORT_KEYS`; adding a report requires a key, parameter contract, query builder,
row shape, export support, and golden tests.

Reports read immutable journals, inventory ledgers, invoices, vouchers, and shift-close
facts. They do not mutate business state or cache totals on master records.

Async exports return a `reports-export` queue token; later worker/rendering phases can
attach generated CSV/XLSX/PDF artifacts to the files table.

## 📊 حركة المبيعات — `frmRptSalesInPeriod` (phase 10, part one)

`Form_WPF/frmRptSalesInPeriod.xaml` (Title «حركة المبيعات») is one window with two tabs and
one number under each grid. Both are registered here as ordinary catalogue definitions:

| Key | Tab | Columns |
|---|---|---|
| `sales-movement-items` | 📊 إجمالي المبيعات | رقم الصنف · الصنف · الكمية · الإجمالي |
| `sales-movement-invoices` | 🧾 عرض الفواتير | رقم الحركة · رقم الفاتورة · نوع الفاتورة · التاريخ · الوقت · آجل · نقدي · شبكة · الإجمالي · الضريبة · الخصم · الصافي |

Three catalogue features carry what the desktop's `Reports/*.repx` files carried and this
catalogue did not have:

- **`grandTotal: { key, labelAr }`** — 💰 «إجمالي المبيعات», the `txtSumSale`/`txtSumSale2`
  box under the grid. It is summed from the rows on screen, so it can never disagree with
  them. `key` may point at a **hidden** column (`net_signed`), which is how «المبيعات −
  المردودات» is totalled while every row stays positive like the desktop's grid.
- **`emptyAr`** — what an empty report says; `frmRptSalesInPeriod` says
  «لا توجد عمليات بالجدول».
- **`signature: true`** — «أعده · راجعه · المدير», the strip of `RptSalesInPeriod1/2.repx`.

And two filter kinds: **`time`** (⏰ الوقت (HH:mm:ss), glued to the date box by
`BuildDateTime`) and **`invType`** (🧾 نوع الفاتورة: `pos` = cash sale with no عميل,
`sale` = with one — the desktop's `inv_type` 3/2).

`GET /reports/print/:key` answers `{ html }` — the same print-ready page, with «المستخدم»
resolved from the caller. It is declared before `@Get(':key')` for the same reason
`layouts` is.

## 🔄 مزامنة الفواتير - ZATCA — `frmInvsSyncStatusZatca` (phase 11, part three)

`einvoice-sync-status` is registered here rather than in the ZATCA module, because the
window is a grid with filters that prints and exports — which is what this catalogue is
for — glued to one action (`POST /einvoice/sync`, permission `einvoice.submit`). The
window's own filters are 🔄 حالة المزامنة (`status`), 📋 نوع الفاتورة (`kind`:
مبيعات · نقطة بيع · إشعار · مقاولات · أندرويد) and 📅 الفترة الزمنية (`from`/`to`), and its
💰 cards are `RecalculateNetSummary`'s two sums and their difference, so the number under
the grid is the grid's own arithmetic.

One quirk is kept on purpose: «أندرويد» is index 4 of the desktop's combo, and its
`switch` has no case for it (`frmInvsSyncStatusZatca.xaml.cs` L913-L920), so picking it
adds **no condition at all** and the window shows every invoice.

## 📦 تقارير الأصناف — `frmRptItems*` (phase 10, part two)

Six desktop windows that all read `inv_sub` grouped over `Items`, registered here as seven
ordinary catalogue definitions:

| Key | Window (`Form_WPF`) | Columns |
|---|---|---|
| `items-sales-summary` | `frmRptItemsSalesDetails` — «مبيعات الأصناف تجميعي» | رمز الصنف · الصنف · المجموعة · الكمية · صافي البيع |
| `items-purchases-summary` | the same window at `OperType = 2` — «مشتريات الأصناف تجميعي» | … · صافي الشراء |
| `items-pos-sales-summary` | `frmRptItemsSalesDetailsPOS` — «…- نقطة البيع» | the same five, restricted to فواتير نقطة البيع |
| `items-profit-summary` | `frmRptItemsProfit` — «أرباح المواد تجميعي» | رمز المادة · المادة · الكمية · متوسط التكلفة · صافي البيع · الربح · نسبة الربح |
| `items-profit-details` | `frmRptItemsProfitDetails` — «أرباح المواد تفصيلي» | الرقم · التاريخ · نوع العملية · المستودع · رمز المادة · المادة · الوحدة · الكمية · متوسط التكلفة · إجمالي التكلفة · السعر · المجموع · الإجمالي · الخصم · الربح · نسبة الربح % |
| `items-sales-by-category` | `frmRptSalesByCategory` — «تقرير مبيعات الأصناف حسب المجموعة» | المجموعة · اسم المجموعة / الصنف · الرمز · إجمالي الكمية · الإجمالي · الضريبة · الصافي · الخصم |
| `category-sales-by-day` | `frmRptCategorySaleByDay` — «تقرير المبيعات اليومية للمجموعة» | الرمز · المجموعة · اليوم · التاريخ · الإجمالي |

**`grandTotal` is now one card or many.** Every one of these windows prints several numbers
under its grid, so the catalogue field takes `ReportGrandTotal | ReportGrandTotal[]` and
`run()` answers `grandTotal: Array<{ key, labelAr, amount }>` — each card summed from the
rows on screen, each `key` a column of the report (hidden ones included). The catalogue
listing carries both `grandTotal: string[]` (labels, as before) and
`grandTotalCards: Array<{ key, labelAr }>`, and `reportSheet()` draws the `.totals-strip` as
a wrapping row of `<span>`s, one per card.

Two rules the desktop files state and the SQL keeps:

- **`if (!hasMovement) continue;`** (`frmRptItemsSalesDetails.xaml.cs` L282,
  `…POS` L223, `frmRptItemsProfit` L220) — *any* movement, not a non-zero net, so
  `HAVING sum(line.quantity) <> 0`. An item sold out and fully returned is still a row,
  which is deliberately the opposite of `sales-movement-items` (`if (qty == 0.0) continue;`).
- **The header discount is already on the line.** `frmRptItemsProfit.GetSaleData` divides it
  in the report (`ItemPriceWithoutVAT * minus / NULLIF(InvSum,0)`); the cloud divides it at
  save time (`calculateInvoiceTotals` spreads `invoiceDiscount` pro-rata by gross into every
  `line.net`), so these reports read `line.net` as it stands and «الخصم» is `gross − net`.

Shared scopes: `movementLinesScope(tenantId, f, pos, opts)` and `purchaseLinesScope`
carry «وثيقةٌ مرحَّلة فقط» plus the 🔧 خيارات البحث boxes each window actually owns — the
`opts` switches leave out the فرع and مجموعة boxes a window does not have.

## 🧾 تقارير الفواتير والإشعارات والحركة اليومية — `frmRptInv*` (phase 10, part three)

Seven definitions out of eight desktop windows; all of them read the **invoice header**,
not its lines:

| Key | Window (`Form_WPF`) | Notes |
|---|---|---|
| `sales-invoices-details` | `frmRptInvSalesDetails` — «تقرير فواتير المبيعات» | 21 columns, 10 cards (the «المدفوع» one included) |
| `pos-sales-invoices-details` | `frmRptInvSalesDetailsPos` — «تقرير مبيعات الفواتير» | the same row, `inv.inv_type = 3` hard-coded; 9 cards |
| `sales-notifications` | `frmRptInvNotfic` — «تقرير الإشعارات» | the same row, `inv_type` 21/22; «نوع الإشعار · رقم الإشعار · تاريخ الإشعار» |
| `purchase-invoices-details` | `frmRptInvPurchaseDetails` — «تفاصيل فواتير المشتريات» | 17 columns, «المدفوع · المتبقي», 5 cards |
| `daily-sales` | `frmRptDailySales` — «تقرير مبيعات حسب اليوم» | `dbo.SalesByDay`, day named `ToString("ddd", ar)` |
| `daily-process` | `frmRptDailyProcess` — «تقرير الحركة اليومية» | six `DoProcess` rows in a fixed order |
| `sales-inv-analysis` | `frmRptInvAnalysis` — «تقرير تحليل المبيعات» | eight `ANALYSIS_DIMENSION` radios |

`frmRptInvSalesDetailsPosAndroid` («تقرير مبيعات أندرويد») is **not** a separate definition:
it is the `inv_type = 20` arm of the same «📄 نوع الفاتورة» combo and prints the very same
`rptInvSumtPos.repx`.

**One row shared by three windows.** `invoiceRow` is the SELECT list of all three; the SQL
that differs is `invoiceScope(tenantId, f, pos, { notifications })`, which swaps
`kind IN ('sale','sale_return')` for `kind IN ('credit_note','debit_note')` and applies
`procScope` or `notificationScope` instead.

**Signed cards.** `UpdateSummaryCards()` at the desktop sums with
`Calc(x) = purchases.Sum(x) − returns.Sum(x)`, so the ten cards read the `s_*` mirrored
columns (`s_sum_price` … `s_paid`), each multiplied by
`invoiceSign = CASE WHEN si.kind IN ('sale','debit_note') THEN 1 ELSE -1 END`. A مرتجع
subtracts, and so does an إشعار دائن. The `s_*` columns are `hidden: true` — they are
printed in the 💰 strip, never drawn in the grid.

**`GetPaymentText`** is one CASE over `payment_status` and the three payment legs
(`paymentLegs` is a `LEFT JOIN LATERAL` over `invoice_payments`): «آجل» when nothing was
paid, «نقدي»/«شبكة» when one leg settled the invoice, «متعدد» when several did.

**Purchases settle by سند صرف**, not by a `pay_type` flag: `payment_allocations` →
`vouchers` gives the same three legs for «💳 نوع الدفع».

## 📚 تقارير المخزون والأرقام التسلسلية — `frmRptInventory` · `frmRptItems*` · `frmRptSerial*` · `frmRptProducedItems` (phase 10, part four)

| Key | النافذة | ما يقرأه |
|---|---|---|
| `inventory-documents` | `frmRptInventory` | `inventory_transactions` مجمَّعةً على `(doc_type, doc_id)` — ثمانية أنواع مستندات بـ«📄 نوع العملية» |
| `item-movement-totals` | `frmRptItemsActivity` | ثلاثة عشر عمود `SUM` مشروطاً بـ`doc_type` (+`party_id IS NULL` لنقطة البيع) وصيغة الرصيد L248 |
| `item-movement-details` | `frmRptItemsActivityDetailed` | صفٌّ لكل حركة مع رصيدٍ متحرك بنافذة تراكمية، واسم النوع من `docTypeLabel` |
| `item-expiry` | `frmRptItemsExpiration` | `item_lots` × رصيد الدفعة من الدفتر — `dbo.ItemsExpirationStock` |
| `serial-movements` | `frmRptSerialNo` | الحركات التي تحمل `serial_id` |
| `serial-balances` | `frmRptSerialNoSummary` | `item_serials` بحالة `available`/`reserved` — `funCalculateSerialNoSummary` |
| `produced-items` / `produced-components` | `frmRptProducedItems` | `production_orders` ومكوّناته |

قرارات المحرّك في هذا الجزء:

- **`base_qty` موجبٌ دائماً** والإشارة في `direction` — تماماً كعمود `val` في الديسكتوب
  الذي تجمعه `GetSumVal` وتطرحه صيغةُ الرصيد؛ لذلك كل عمود حركة هو `SUM(base_qty)`
  مشروطاً، و«الرصيد» هو المجموع الموقّع.
- **`docTypeLabel`** بديلُ جدول `InvTypes` (L334-345): اسمٌ عربيٌّ مشتقٌّ من `doc_type`
  بأسماء النوافذ نفسها، مع «نقطة البيع» حين لا عميل للفاتورة.
- **معرّف المستند و`doc_type`** عمودان مخفيّان على «مستندات المخزون» و«حركة صنف تفصيلي»
  ليُبنى عليهما رابط المستند لاحقاً، كما بُنيت بطاقات الجزء الثالث على أعمدة `s_*`.
- **فلتران جديدان:** `docType` («📄 نوع العملية» الثمانية) و`serial` («🔢 الرقم
  التسلسلي» — مدخلٌ نصّي، نوعٌ جديد `kind: 'serial'` في المحرّك والواجهة)، و«🔄 نوع
  العملية» في «حركة صنف تفصيلي» على فلتر `kind` لأن `procType` محجوزٌ لتقارير الفواتير.

## 📒 تقارير المحاسبة — `frmRptBalances` · `frmRptEntries` · `frmRptIncomeStatement` · `frmRptCostCenter` · `frmTaxRptPeriod` (phase 10, part five)

| Key | النافذة | ما يقرأه |
|---|---|---|
| `account-balances` | `frmRptBalances` | `journal_entry_lines` مقسومةً على `source_type = 'opening'` («قيد إفتتاحي») وما عداها، لكل حسابٍ تحت «الحساب الرئيسي» |
| `journal-entries` | `frmRptEntries` «🔍 البحث» | `journal_entries` مع رقم المستند من الجدول الذي يسمّيه `source_type` |
| `journal-entry-lines` | `frmRptEntries` «🧾 تفاصيل القيد» | `journal_entry_lines` مع الحساب ومركز التكلفة |
| `income-statement-accounts` | `frmRptIncomeStatement` | الحسابات ذات `type IN ('revenue','expense')` مُجمَّعةً على آبائها + سطر «قيمة مخزون بضاعة آخر المدة» |
| `cost-center-statement` | `frmRptCostCenter` | `cost_center_id` على السطور، «تجميعي» بسطرٍ لكل حساب و«تفصيلي» بسطرٍ لكل حركة |
| `vat-return-period` | `frmTaxRptPeriod` | `TaxRptPeriod.repx`: ثلاثة عشر بنداً — ستة مبيعات وستة مشتريات وصافي الضريبة |

قرارات المحرّك في هذا الجزء:

- **`Entry.type = 0` هو «قيد إفتتاحي»** (`EntryTypes` Id 0) و`type <> 0` هو الحركة؛ كلّ
  نافذةٍ في الجزء تقسم أرقامها على هذا الخط. السحابة تُسمّي القيد نفسه
  `source_type = 'opening'` — وهو المفتاح الذي يطبعه بيان الحساب أصلاً باسم
  «قيد إفتتاحي» في `ENTRY_TYPE_LABELS` — فصار «رصيد افتتاحي» و«حركة» عمودين من
  استعلامٍ واحد لا استعلامين.
- **`Accounts_Index.FinalAcc = 2`** (المصروفات · إيرادات، `CrystalLiteDB.txt` L2515-L2516)
  يقابله `accounts.type IN ('revenue','expense')`، والتجميع على الأب (`_Type == 1`)
  هو `coalesce(parent.id, acc.id)` — أي «حسابات رئيسية» باسمها.
- **الشجرتان:** `accounts.path` شجرة ltree من الجذر، فالحسابُ ابنٌ لِما اختير إذا كان
  `path <@ <المختار>` (وهو سير `GetParent` في `ParentCode`)؛ أمّا `cost_centers` فعلى
  `parent_id` وحده، فمشى التقرير عليها بـ`WITH RECURSIVE`. وفرّق التقرير بين الوضعين
  كما يفرّق الديسكتوب: «تجميعي» كل الأبناء، و«تفصيلي» الأبناء المباشرون، أو المركز نفسه
  إن لم يكن له أبناء (`DetailedResults` L276-L282).
- **صيغة الرصيد من وجهين** كما في L373-L430: `حركة = max(مدين − دائن، 0)` على كل وجه،
  ثم `ختامي = افتتاحي + حركة` ثم **تصفيةٌ ثانية** تُبقي وجهاً واحداً غير صفر.
- **«🧾 نوع القيد» ستة عشر اسماً** من `EntryTypes` تُقرأ من `source_type` و`kind`؛
  «سند قبض من عميل» و«سند صرف لمورد» (Id 5 · 6) يندمجان في «سند قبض» و«سند صرف»
  (Id 7 · 8) كما يفعل `entryTypeOf()` أصلاً، لأنّ السطر يحمل نوعه بنفسه.
- **فلاتر جديدة:** `accountId` (ونوعه `account` في المحرّك والواجهة — قائمةٌ من
  `GET /accounts`) و`entryNo` و`docNo` («🔢 رقم القيد» · «📄 رقم المستند») و`quarter`
  و`month` («📆 ربع سنة» · «📆 شهري»، اللذان يكتبان الفترة فوق صندوقي التاريخ كما تفعل
  `SetDate` في L219-L266).
- **«📋 حالة القيد»:** «معتمد» و«لاغي» — والملغي عندنا هو ما **عُكس** بقيدٍ يشير إليه،
  لأنّ السحابة لا تبدّل حالة القيد بل تعكسه؛ و«مسودة» هي الحالة الوحيدة غير المُرحَّلة.

## 💰 تقارير الخزينة والرواتب والمستخدمين — `frmRptKhzna` · `frmRptSalary` · `frmRptReseved` · `frmrptUsersRecords` · `frmRptRentInvoices` (phase 10, part six)

| Key | النافذة | ما يقرأه |
|---|---|---|
| `cash-statement` | `frmRptKhzna` | `journal_entry_lines` على حساب الصندوق مجمَّعةً على القيد، بسطر «رصيد سابق» يفتح الفترة |
| `salary-statement` | `frmRptSalary` | `salary_payments` — كل إذن صرف راتب بسطر |
| `salary-reserved` | `frmRptReseved` | `payroll_runs` + `payroll_run_lines` — كل مسيّر رواتب مستحق بسطر |
| `user-records` | `frmrptUsersRecords` | `audit_log` — سجلّ التدقيق، وهو `Log4NetLog` عند الديسكتوب |
| `rent-invoices` | `frmRptRentInvoices` | `rental_invoices` و`marina_bookings` بلا فاتورة («حجوزات») |

قرارات المحرّك في هذا الجزء:

- **«رصيد سابق» سطرٌ لا رقم** (L198-L233) — أول سطر في الشبكة، يظهر كلما اختيرت فترة،
  والرصيد بعده متحرّك بنافذة تراكمية؛ والبطاقتان «⚖️ الرصيد الإجمالي» و«📅 رصيد الفترة
  المحددة» مجموعان من السطور نفسها، لا استعلامان آخران.
- **حساب الصندوق على الصندوق** (L159-L164) — الديسكتوب يبحث عن الحساب بمطابقة الاسم
  (`Accounts_Index.AName = Stocks.name AND Type = 2`)؛ والسحابة تعلّقه على الخزينة
  (`cash_locations.account_id`)، وترفض بالجملة نفسها حين يغيب.
- **«💰 الإجمالي» = الصافي + الخصومات** (L104-L113) — لأنّ «بدلات أخرى» لا عمود لها في
  شبكة الديسكتوب، وإجماليٌّ لا يجمع إلى الصافي المطبوع في الإذن نفسه كذبة.
- **`proc_type` بلا عمود** (`LoadProcesses` L232-L239) — «تأجير» فاتورةٌ مُرحَّلة، و«مرتجع»
  فاتورةٌ مبيعاتُها مردودة، و«معلق» فاتورةٌ لم تُرحَّل، و«حجوزات» حجزٌ بلا فاتورة؛
  و`CalcIncome` (L258-L274) يحسب 1 و3 إيراداً و2 مرتجعاً ويترك 4 خارج الحساب — وهو ما
  تفعله بطاقات «إيرادات · مرتجع · الصافي».
- **فلاتر جديدة:** `cashLocationId` («🏦 الصندوق») و`groupId` («📁 الفئة») و`year`
  («📅 السنة» — مربّع نصّي كصاحبه في `frmRptSalary`)، و«👤 المستخدم» يركب فلتر الموظف
  لأنّ السجلّ يسمّي الفاعل والديسكتوب يسمّي الموظف، والطريق بينهما العضوية.

## 🖨️ إعدادات الطباعة — `frmSettings.xaml` «خيارات الطباعة» · `frmInvRptType` · `Print.cs` (phase 10, part seven)

`SettingPrint` is the desktop's print profile: one row per document kind, read by 69 `.cs`
files through `Class/Print.cs` and written by `frmSettings.xaml.cs` L2125-L2156 (delete +
insert). The cloud keeps the table, the field names and the defaults, and replaces the
`Inv_Id` integer with a **named scope**, because the desktop's own windows disagree about
what those integers mean: `frmSettings` saves 0 الإفتراضي · 1 مشتريات · 2 مبيعات · 3 نقطة بيع ·
4 تأجير · 5 عقود · 6 تقارير (L2095-L2116), while `frmRptKhzna` L106 reads `Inv_Id=12`,
`frmRptEntries` reads 9 and `frmRptRentInvoices` L541 reads 14.

| Scope | الديسكتوب | `Inv_Id` في `frmSettings` |
|---|---|---|
| `default` | «الإفتراضي» | 0 |
| `purchases` | «مشتريات» | 1 |
| `sales` | «مبيعات» | 2 |
| `pos` | «نقطة بيع» | 3 |
| `rental` | «تأجير» | 4 |
| `contracts` | «عقود» | 5 |
| `reports` | «تقارير» | 6 |
| `report:<key>` | — | — |

`print_settings` (migration `0061`) is tenant-scoped and RLS-protected like every other
tenant table. A report's own scope is consulted first, then `reports`, then `default` —
`PrintSettingsService.effective()` walks that chain, so «🧩 تفعيل إعدادات الطباعة» keeps
working the way the radios promise.

| Route | Permission |
|---|---|
| `GET /reports/print-settings` | `reporting.view` |
| `GET /reports/print-settings/:scope` | `reporting.view` |
| `PUT /reports/print-settings/:scope` | `reporting.layout.manage` |
| `DELETE /reports/print-settings/:scope` | `reporting.layout.manage` |

What the printed sheet honours (`PrintTemplatesService.reportSheet`):

- **`printNo` — عدد النسخ.** `Printing()` loops `Print()` that many times (L201-L206); the
  sheet is repeated that many times, each copy on its own page, and the doc-meta line prints
  «عدد النسخ: N». «👁️ معاينة الطباعة» and «طباعة / PDF» print the same sheet — both call
  `ReportingService.printOptionsFor()`, so the desktop's one `Print.cs` stays one code path.
- **`printType` — نوع الورقة.** 1 = A4 landscape, 2 = 🧾 ورق صغير (80mm). The two radios of
  `frmInvRptType.xaml` «🖨️ افتراضي طباعة الفواتير».
- **`printHeader` · `printFooter` — الترويسة والتذييل.** `Printing()` injects `header.repx`
  and `footer.repx` into the `headerRpt` / `footerRpt` subreports; here the company block
  (name · tax no · CR · contact) and the contact line under the grid are what appear.
- **`printStamp` · `stampImageUrl` — الختم.** The stamp image prints under the signatures.
- **`note` — ملاحظات التقرير.** Printed under the grid, `txtNote` of `frmSettings`.
- **`casherPrinter` · `kitchenPrinter` — الطابعتان.** Saved, and shown beside the print
  button (a `.no-print` toolbar note). A server cannot reach a shop's printer; the
  browser's print dialog is the operator's.

`?copies=` and `?paper=a4|small` override the row for one print without saving anything —
the cashier who needs four copies once does not have to change the shop's defaults.

Documents read their own scope through `PrintTemplatesService.documentPage()`, because
`Print.cs` is the desktop's invoice printer before it is its report printer: `frmPurchInv`
prints with `new Print(1)` → `purchases`, `frmSalesInvoice` with `new Print(InvType)` = 2 →
`sales`, `frmCloseShift` reads `SettingPrint WHERE Inv_Id = 6` → `reports`, and the voucher
(`frmSandQD`, `new Print(11)`) and the journal entry (`FrmNewEntry`, `Inv_Id=9`) use numbers
no radio of `frmSettings` can write, so they fall through to `default`. Each document gets
the same treatment: `printNo` copies, the paper of `printType`, `header.repx` / `footer.repx`
and the stamp.

Defaults when no row exists are `Print.cs` L54-L64 (`PrintHeader=true`, `PrintFooter=false`,
`printNo=1`, `printItemType=1`) with `printType=1`, because this platform prints A4 PDFs and
`frmInvRptType` opens on «📄 ورقة A4». Images are URLs, not the desktop's `[image]` bytes:
this service has no byte store.

Validation is a gate, not a suggestion: `printNo` 1..50, `printType` 1|2, images must be
`http(s)` URLs, an unknown scope is 404 `PRINT_SCOPE_INVALID`, and `report:<key>` is
rejected unless the report is registered. A typo therefore cannot create a row that
silently prints nothing.

## 📑 كشوف الحساب — `frmCustAccount` · `frmCustAccountGet` · `frmCustLastPay` (phase 10, part eight)

The 32 `frmRpt*` windows of `PHASE_10_REPORTS.md` §1 are done after parts 1–7. The desktop
has a second family that the table does not count — the seven «كشف حساب» windows — and this
part is that family. Four of the seven were already live from earlier phases
(`GET /statements/general-ledger/:id` with `with_descendants=1` is both «كشف حساب تفصيلي»
and «كشف حساب رئيسي», `GET /statements/cost-center/:id` is «تقرير مركز كلفة», and
`GET /hrm/employee-statement` is «كشف حساب موظف»), so this part adds the three that were
missing and finishes the filters of the four that were not:

| Key | Window | Columns |
|---|---|---|
| `customer-balances` | `frmCustAccount` «أرصدة حساب العملاء» | `#` · `🔢 رقم الحساب` · `👤 اسم العميل` · `💸 حركة مدين` · `💰 حركة دائن` · `⚖️ الرصيد` · `📌 الحالة` |
| `party-statement` | `frmCustAccountGet` «📋 كشف حساب عميل» | `م` · `مدين` · `دائن` · `العميل / المورد` · `رقم القيد` · `تاريخ القيد` · `البيان` |
| `customer-last-payment` | `frmCustLastPay` «📋 حركة آخر سداد للعملاء» | `رقم الحساب` · `اسم العميل` · `الهاتف` · `قيمة آخر سداد` · `تاريخ آخر سداد` · `نوع السند` · `الرصيد` · `الحالة` · `رقم القيد` |

Three rules the desktop's `.xaml.cs` files state and the SQL keeps:

- **👤 حركة الطرف هي حركة حسابه** — `partyMovement()` in `report-catalog.ts`. Both windows
  read `Entry_sub.acc_no = Customers.AccountCode` (L221 · L336), so the party's
  `receivable_account_id` / `payable_account_id` are what count. Counting the lines that
  merely carry the party would count a collection twice: the receipt debits the صندوق *and*
  credits the customer, and both lines name him. Lines carrying the party are the
  **fallback** for a party the chart never gave an account, so his payments do not vanish.
- **⚖️ الرصيد على جانبٍ واحد** — `statementCards()`/`statementGrandTotal`. `UpdateSummary`
  (L583-L609) puts the رصيد on one side only, and the two cards are summed from the rows,
  so they cannot both carry money.
- **💳 آخر سداد** — `ORDER BY je.date DESC, entry_time DESC, created_at DESC, line_no`
  (L222-L231 `SELECT TOP 1 … ORDER BY id DESC`) with `debit = 0 ? credit : debit` (L258).
  `frmCustLastPay` has **no** date box, so the report declares no period param at all.

`partyKind` is a new filter (`all` · `customer` · `supplier` — the 🔵 الكل · 👤 عملاء · 🏭
موردين radios of `frmCustAccountGet`), and it is what lets one report serve the supplier's
statement as well as the customer's, exactly as the desktop's one window does.

The four windows that were already live gained the two filters they were missing, in
`accounting.service.ts` (not here): **⏰ الوقت** — `frmAccountBalance` has a time box beside
each date box (`BuildDateTimeFilter` L458-L463), and `journal_entries` keeps the date and
the time apart, so they are glued back together (the opening balance reads the same clock:
a قيد posted at nine is *before* a period that opens at noon of the same day) — and
**📋 نوع القيد**, spoken in the `source_type` vocabulary the النوع column already prints,
because `cmbEntryType` (L108-L127) is index-based and disagrees with `GetEntryTypeName`
about what each number means.

| Route | Permission |
|---|---|
| `GET /reports/customer-balances?partyId=&partyKind=&salesmanId=&from=&to=` | `reporting.view` |
| `GET /reports/party-statement?partyId=&partyKind=&branchId=&from=&to=` | `reporting.view` |
| `GET /reports/customer-last-payment?partyId=&partyKind=` | `reporting.view` |
| `GET /statements/general-ledger/:id?…&from_time=&to_time=&kind=` | `accounting.reports.view` |
| `GET /statements/cost-center/:id?…&kind=` | `accounting.reports.view` |

Tests: `apps/api/test/report-party-statements.spec.ts` (14) plus two appended to
`accounting-statement.spec.ts`; live script `scripts/verify-party-statements.mjs`
(67 checks, every figure asserted as a difference from a baseline, entries reversed rather
than deleted).

## Saved layouts — مصمم التقارير

`report_layouts` (migration `0028`) is the whole persistence of the report designer, and it
stores **presentation only**: which of a report's own columns are visible, in what order,
under what heading, plus default filters and an `is_default` flag per report.

| Route | Permission |
|---|---|
| `GET /reports/layouts?report_key=` | `reporting.view` |
| `POST /reports/layouts` | `reporting.layout.manage` |
| `PATCH /reports/layouts/:id` | `reporting.layout.manage` |
| `DELETE /reports/layouts/:id` | `reporting.layout.manage` |

The report's SQL is never user-authored. `normalizeColumns` drops any key the registered
report does not produce and refuses a layout with nothing left visible
(`REPORT_LAYOUT_EMPTY`), and an unknown `reportKey` is a 404 on save. That is what keeps a
"designer" from becoming a query editor pointed at other tenants' data — and it means a
layout keeps working when the report behind it is rewritten.

`GET /reports/:key` accepts `?layout=<id|name>`; omitting it applies the report's default
layout, and `?layout=none` forces the raw column set. Layout filters are merged *under* the
caller's own filters, so a saved default is a starting point rather than a cage.

These layout routes are declared **before** `@Get(':key')` in the controller — otherwise
`/reports/layouts` would be parsed as a report named "layouts".

Both `ReportingService` and `ReportLayoutsService` take the injected `DATABASE_HANDLE`
rather than the module-level `getDatabase()` singleton, so a test (or any second pool) runs
reports against the database it was actually given.

## Printed documents

`PrintTemplatesService` renders the six papers a company hands out: the sales invoice, the
purchase invoice, the receipt/payment voucher, the journal voucher and the daily shift
close. Each route returns `{ html }` — one self-contained A4 page with its own stylesheet,
no external font, image or script — because the admin shows it inside a sandboxed iframe
and the same string is what gets saved to disk or sent to a printer.

| Route | Document |
|---|---|
| `GET /reports/print/invoices/:id` | فاتورة مبيعات / مردود / عرض سعر |
| `GET /reports/print/purchase-invoices/:id` | فاتورة مشتريات / مردود مشتريات |
| `GET /reports/print/vouchers/:id` | سند قبض / سند صرف |
| `GET /reports/print/journal-entries/:id` | سند قيد |
| `GET /reports/print/shifts/:id` | إغلاق اليومية |

All five require `reporting.view` and are tenant-scoped through `withTenantTx`, so a
document id from another tenant is a 404 rather than a leak.

Two details are deliberate:

- **The amount in words** (`tafqeet.ts`) is printed on every money document. It implements
  the conventional accounting form — unit before ten (`واحد وعشرون`), the dual
  (`مائتان`, `ألفان`), the 3–10 plural (`ثلاثة آلاف`) and the accusative singular after
  11–99 (`خمسة عشر ريالاً`) — and names the currency and its fraction from an ISO code.
- **The ZATCA QR** is drawn only when the invoice actually carries a reported TLV payload.
  Until then the slot prints a sentence saying so, because a decorative square that no
  scanner can read is worse than an honest gap.

## Exports

`POST /reports/:key/export` (permission `reporting.export.execute`) re-runs the report
server-side with the query string it was given — the same filters and the same saved layout
as the screen — and returns a finished file:

| `format` | Payload | Notes |
|---|---|---|
| `csv` | `encoding: 'utf-8'` | Leading BOM, so Excel on Windows reads Arabic instead of mojibake. |
| `xlsx` | `encoding: 'base64'` | A real workbook written by `xlsx.ts`: right-to-left sheet, frozen header, auto-filter, `#,##0.00` numeric cells and a bold totals band. |
| `pdf` | `encoding: 'utf-8'` | A print-ready A4 **landscape** page on the company letterhead; the browser's print dialog turns it into a PDF. |

Three decisions worth keeping:

- **The client never builds the file.** It used to serialise the rows already on screen, which
  ignored the layout and silently dropped anything not rendered. The export is now the report,
  not a screenshot of it.
- **Only clean decimals become numeric cells.** An account code (`1101`), a document number
  (`SI-000006`) or anything with leading zeros stays text, so Excel cannot "helpfully" turn it
  into a number or a date.
- **Filters are spelled out in the header band.** `branchId=<uuid>` prints as
  `الفرع: الفرع الرئيسي`; the lookup is best-effort and falls back to the raw value, because a
  caption must never be the reason an export fails.

There is no PDF renderer in the process on purpose: producing Arabic PDF text requires
embedding a font with contextual shaping, and the print dialog already produces a smaller,
selectable, better-typeset document.
