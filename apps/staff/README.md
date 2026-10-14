# Staff — tenant admin + ERP back office

Arabic-first Next.js 15 App Router back-office for the core ERP modules. Served
from the `app.*` domain and deployed separately from every other surface, while
calling the same shared API (`apps/api`).

## Run

```bash
pnpm --filter @erp/staff dev
pnpm --filter @erp/staff build
```

Set `NEXT_PUBLIC_API_BASE_URL` to the API base URL, for example
`http://localhost:3000/api/v1`. In a split-domain deploy also set
`NEXT_PUBLIC_MARKETING_URL` and `NEXT_PUBLIC_PLATFORM_URL`.

## Structure

- `app/` — routes for dashboard and sections 1-12 from `ADMIN_PANEL_MASTER_REQUIREMENTS`.
- `components/` — shared UI kit: data table, filter bar, status badge, KPI card,
  money/quantity inputs, confirmation dialog, loading/empty/error/forbidden states, and
  report runner.
- `lib/` — API client, i18n helpers, formatting, and navigation registry.
- `tests/` — route/kit coverage checks.

## Security and UX

- RTL Arabic is the default; LTR is represented by the AR/EN switch and i18n helpers.
- Navigation entries carry required permissions so callers can hide links by scope.
- Browser print CSS is included for printable sales, shift, and report artifacts.
- Column chooser state is persisted in `localStorage` and can later sync to server
  settings when exposed by the API.
- CSP headers are configured in `next.config.mjs`.
- No signup on this surface: new tenants register on the marketing site, which
  hands them back to the login screen with `?tenant=` prefilled. Sessions handed
  over from the marketing smart login arrive via a `?token=` bridge that is
  consumed and stripped from the address bar.

## Screens added by P-C5 (2026-09-17)

| Screen | Route | Permission | Endpoints |
|---|---|---|---|
| الاستخدام والحصص | `/settings/usage` | `tenant.view` (read-only; `Forbidden` otherwise) | `GET /usage` |

The screen is the tenant's own view of the same engine the platform console reads: the eight
metrics with their limit, source and state, plus a 30-day chart for the metered counters. It is
read-only on purpose — limits are the platform's to set (`/platform/tenants/:id/settings` on the
operator side, or the `limits.*` defaults), and a tenant that could raise its own ceiling would
make the gate decorative.

## Screens added by P-C6 (2026-09-17)

| Screen | Route | Permission | Endpoints |
|---|---|---|---|
| البريد — القوالب والسجلّ | `/settings/email` | `tenant.email.log.view` (read) · `tenant.email.template.manage` (edit) | `GET /email/templates` · `PUT /email/templates/:event` · `GET /email/messages` · `GET/PUT /email/settings` |

Three tabs: **قوالبي** (edit the tenant's own text over the platform's, with «أعِد نصّ المنصة»
to drop the override) · **سجلّي** (the tenant's outbound log with event/status filters and
counts) · **هويّة المُرسِل** (sender name, reply-to and sending domain, plus the provider —
read-only). The provider and the caps belong to the platform console on purpose: a tenant that
could switch the transport or raise its own ceiling would make the platform's gate decorative.
`{{variables}}` are the event's declared ones only — an unknown variable is refused at save
time, and a missing one at delivery time, so neither reaches a customer's inbox.

## Screens added by P-C7 (2026-09-17)

| Screen | Route | Permission | Endpoints |
|---|---|---|---|
| مركز الإشعارات | `/notifications` | `tenant.notification.view` | `GET /notifications` · `POST /notifications/:id/read` |

The inbox lists what was addressed to the calling membership — platform announcements
(`type=announcement`, text read from the notification `payload` in the UI language) and system
notices — newest first, with «تحديد كمقروء» per row and «قراءة الكل». The **bell in the top
bar** shows the same `meta.unread` this screen shows (no second counter), polling once a minute
and staying silent when the call fails. Marking a read **also stamps the platform's delivery
ledger** (`announcement_reads`), which is what makes the console's «القراءات» column truthful.

## Screens added by P-C8 (2026-09-17)

| Screen | Route | Permission | Endpoints |
|---|---|---|---|
| (لا شاشة جديدة) لافتة الدخول المؤقّت | كل شاشة | — | `GET /me` (حقل `impersonation`) |

When the console hands a **temporary access token** over (the token travels in the URL
*fragment*: `#support=…`, so it is never sent to a server), the workspace adopts it as a
**view-only session**: `readSession()` returns it without a refresh token — a break-glass token
is never renewed — and a red banner (`components/impersonation-banner.tsx`) sits above every
screen saying who is inside the tenant, why, and for how long. The banner is driven by
`me.impersonation` alone, so it cannot be dismissed while the token still carries `imp`; its
button leaves the view locally, and the session itself is ended from the console.

## What P-C9 (2026-09-17) changed here

Nothing. The part is a console part: it turned the operator's daily service questions into
screens (`/jobs` with retry and cancel, `/health` with six server-measured probes, `/files`
with a real quarantine, `/audit` with a `before`/`after` diff viewer) and it added the
`console.jobs.manage` code that separates *reading* the queue from *running* it. The customer
surface — and this app's screens, navigation and session handling — did not change, which is
itself a result: the quarantine the console writes is enforced by the API, so the customer's
`GET /files/:id` answers 404 without a single line changing in the workspace.

## Coverage

All core sections are navigable: organization, catalog, accounting,
parties, inventory, sales, purchases, treasury, e-invoicing, reporting, and migration /
compat devices. The platform console moved to `apps/platform-admin`; the customer
portal lives in `apps/customer-portal`.

## What R1 (2026-09-19) changed here

The two user screens now carry the desktop's own words, with the line each label came
from: `settings/users` shows «📋 قائمة المستخدمين» · «👤 الموظف» · «🔑 اسم المستخدم
(البريد الإلكتروني)» · «💰 حدود الخصم», and `settings/roles` shows «⚙️ تعديل الصلاحيات».
More than labels: the invite and edit forms gained the two membership fields that replaced
the desktop's `OperMaxDiscount` table — **«أعلى نسبة للخصم %»** and **«أعلى قيمة للخصم»**
(`memberships.max_discount_pct` / `max_discount_amount`, migration `0085`), listed per user
in a new «حدّ الخصم» column. Empty means *no limit*; `0` is a limit that forbids any
discount, and the column says «بلا حدّ» so the two are never confused on screen.

`sales/invoices/new` and `sales/pos` read the same fields from `me.membership` and print
«حدّك: …» beside the discount box — **a notice, not the enforcement**: the check lives in
`assertDiscountWithinLimit` on the API, in the single `createInTx` path both the form and
the POS checkout go through. The permission `sales.discount.override` (the desktop's
`ckDiscount`, «تجاوز الخصم الافتراضي») is what lifts the limit for its holder.

## What R2 (2026-09-20) changed here

The sales invoice screens now carry the desktop window's own words. `sales/invoices/new`
is titled «🧾 فاتورة مبيعات» (`frmInvSale.xaml:347`) and its fields are «👤 العميل» (:459),
«🏪 المستودع» (:482), «💵 عميل نقدي» (:540), «📱 الجوال» (:546), «👨‍💼 المندوب» (:521) and
«🔻 خصم» (:989), with the desktop's two buttons side by side: «💾 حفظ» (:1263) and
«💾🖨️ حفظ + طباعة» (:1257) — the second saves and opens the print sheet. `sales/invoices/[id]`
gained «🔖 رقم المرجع» (:405, resolved to the original invoice number for a return),
«📋 الحالة» (:423), «💳 طريقة الدفع» (:414) with the desktop's three options
«آجلة»/«نقدية»/«بنك» (:418–:420), the till/bank picker labelled «🏦 الصندوق» (:476) or
«🏛️ البنك» (:488) as the method changes, «💰 تسديد» (:1197), «🖨️ طباعة» (:1254) and
«🗑️ إلغاء الفاتورة» (:1260 — the cloud's name for the desktop's soft delete).

**Line grids and totals follow the desktop's own column order** (`frmInvSale.xaml`
L695–L831, L942–L967): «📦 الصنف · الوحدة · الكمية · السعر · المجموع · الخصم · الإجمالي ·
الضريبة · الصافي» and «📊 المجموع · 🔻 الخصم · 💵 الإجمالي · 🧾 الضريبة · ✅ الصافي». It is
not decoration: in the desktop «الإجمالي» is the net **after discount, before VAT** and
«الصافي» is the total **with VAT** (`frmInvSale.xaml.cs:1429–1432`), which is exactly the
cloud's `net`/`total` — so labels and DTO fields now line up one to one. The discount input
stays labelled «خصم %» (the cloud stores a rate and computes the amount) and the computed
amount sits in its own «الخصم» column. `TotalsPanel` takes a `variant`; the purchase screen
passes `purchase` and gets the purchase window's wording (`frmInvPurch.xaml:1056–1101`).

More than labels: the posting engine now refuses **both** directions of a broken document
chain — `SALES_VOID_HAS_RETURNS` (409, listing the blocking documents) when a void would
orphan a posted return, and `SALES_REFERENCE_VOIDED` (409, before any write) when a return
or credit note is posted against a voided invoice.

## What R11 (2026-09-22) changed here — الشاشات الثلاث الأخيرة

The navigation tree had three rows left in `api` state — the endpoints existed, the screens did not:
«🧵 أنواع التفصيل» · «📋 بطاقة بند» · «🏗️ مراحل مشروع». They were served by the `/s/[...slug]`
scaffold, which honestly said «قيد التطوير». All three are real routes now, outside `/s/`:

* **`/projects/stages`** — the two panels of `Form_WPF/frmProjectStagesPM.xaml`: «🗂️ المجموعة:»
  (the stage templates, applied to a project in the group's order) and «➕ إضافة حالة» on the
  project's own stages, plus «⬆️ لأعلى» / «⬇️ لأسفل» (L347/L353) and the window's footer
  («✖» · «⏮» · «◀» · «▶» · «⏭» · «🖨️ طباعة» · «🗑️ حذف» · «💾 حفظ» — L497–544). The four arrows
  navigate between **records** in the desktop window, so here they move the *selected stage* —
  which is what the desktop refusals ask for anyway («يجب تحديد المرحلة المراد إلغاها»,
  `frmProjectStagesPM.xaml.cs:212`). `frmStagePM.xaml` gives the card its columns:
  «🔢 الرقم» · «📝 اسم المرحلة» · «الحالة» · الاعتماد · «ملاحظة الاعتماد».
* **`/projects/boq`** — «📋 بطاقة بند» from `frmTermsPM.xaml` (Title «بنـــد», L6): «🔢 الرقم» ·
  «📝 الاسم» · الكمية · سعر البيع · التكلفة التقديرية · مدة التنفيذ · «المفوتر سابقاً»
  (read-only — the progress bills write it), with «💾 حفظ» · «✏️ تعديل» · «🗑️ حذف». The refusals
  are the window's own words: «من فضلك أدخل رقم البند» (L244) · «من فضلك أدخل اسم البند» (L249) ·
  «كود البند مدخل مسبقاً» (L270, now the server's 409 `BOQ_TERM_CODE_TAKEN`).
* **`/tailoring/types`** — «🧵 أنواع التفصيل». The desktop only *reads* `TailoringTypes`
  (`frmOrderDetails.xaml.cs:60`, filling «نوع التفصيل:» at `:177`), so this screen is a cloud
  addition, declared as such: name (required) · code · default price · «متاح», with «إخفاء»
  instead of a hard delete (the table is soft-deleted, like the desktop's `IsActive=0`).

The tree flip also moved three links in `apps/marketing/lib/industries.ts` from `/s/...` to the
real routes, so a visitor no longer lands on a scaffold.

Three server defects surfaced **before** any screen was written, all found by probing the routes
live: `GET /projects/stage-templates` answered **400 `INVALID_ID`** (the route was never declared
before `@Get(':id')`, and Nest matches in declaration order) · `POST /projects` without `partyId`
answered **500** from a `NOT NULL` constraint · and so did a stage without a name and a BOQ term
without a code. They are 422s with Arabic messages now. `DELETE /projects/stages/:id` renumbers the
remaining stages **inside one transaction** (`+1000000` shift before the final write) so the unique
index `project_stages_order_key(project_id, stage_order)` never collides and no gap is left.

`tests/project-definitions.spec.ts` (10/10) pins the pure half — `lib/project-definitions.ts`:
ordering, the tail insert (`max+1`, as in `frmProjectStagesPM.xaml.cs:236`), the two ends that do
not move, and the desktop refusal strings verbatim.

## What R10 (2026-09-21) changed here — «⏮ ◀ ▶ ⏭» التنقّل بين القيود

The journal register used to open an entry in a panel inside the list. It now has a card of its
own: **`/accounting/journal-entries/[id]`** — the entry read-only (its header fields, its lines, and
«مجموع المدين:» / «مجموع الدائن:» / «الفرق=»), with the desktop window's own footer
(`FrmNewEntry.xaml` L427–431): «✖ خروج» · «⏮ الأول» · «◀ السابق» · «▶ التالي» · «⏭ الأخير»,
plus «🖨️ طباعة» and «👁️ معاينة» (L454–455). A button whose neighbour does not exist is
**disabled, never hidden** — that is how the desktop window keeps its footer steady under the
operator's finger. The arrows come from `FrmNewEntry.xaml.cs` L843–861: «الأول» is the oldest
entry, «التالي» the next one forward in time — **not the row below in the grid**, because the
register lists newest first while the arrows walk the other way. So the card says where it stands:
«موضع القيد: n من m», counted from the oldest, and an entry outside the current filter says
«موضع القيد: خارج النطاق المعروض» instead of pretending to be «1 من 1».

The filter travels with the operator: `from` · `to` · `branchId` · `fiscalPeriodId` · `status` are
copied into every arrow's href and into «✖ خروج», which returns to the register it came from. The
whole decision lives in **`lib/journal-nav.ts`** (pure, no React) and is pinned by
`tests/journal-navigation.spec.ts` (6/6) — the labels and the disabled-not-hidden rule are the two
things easiest to break silently.

The old `?entry=<id>` link from the ledger still works: `/accounting/journal-entries?entry=…`
**redirects** to the card, and the register's «تفاصيل» column (and `ledger/page.tsx:422`) now link
to it directly. `?auto=1` on `/print/[doc]/[id]` makes «🖨️ طباعة» print as soon as the sheet is
ready while «👁️ معاينة» only shows it — the two buttons stay two buttons.

## What R9 (2026-09-21) changed here — «📊 مركز التكلفة»

Both invoice screens now carry the window's own cost-centre list: «📊 مركز التكلفة:» in
`sales/invoices/new` (`frmInvSale.xaml:530`, `cmbCostCenter`) and «📊 مركز التكلفة» — without the
colon, as the purchase window writes it — in `purchases/invoices/new` (`frmInvPurch.xaml:467`).
The shared grid behind them (`components/invoice-editor.tsx`) grows a «📊 مركز التكلفة» column on
every line when the caller passes `costCenters`, and the empty option says «— مركز الفاتورة —»:
on the desktop a line that names no centre takes the header's (`Class/InvoiceOper.cs:2461`), and the
line's own centre wins when it has one (`:2432`). So the wire contract is «absent, not empty» —
`toApiLines` omits the key for a silent line, and `tests/invoice-cost-centers.spec.ts` (3/3) pins
exactly that, plus that a fresh line starts with no centre at all.

The two document cards print the centre **by name**, not by id (`Class/Print.cs:772`), as a
«📊 مركز التكلفة» row on the invoice card and as a column on each line — a line that inherited the
header shows the header's name, so what the operator reads is what was posted.

No new route: the lists are read from the existing `GET /cost-centers`, the same one
`/accounting/cost-centers` and «بطاقة المصاريف» already use.

## What R8 (2026-09-21) changed here — «🔢 التسلسلي» و«📁 رقم الدفعة»

Both invoice grids carry the two columns the desktop writes into `InvoiceItemDetail`
(`Class/InvoiceOper.cs:1635`) and reads back (`:3885`): «📁 رقم الدفعة» and «🔢 التسلسلي», one
row per unit, written free-hand and resolved by the server when the document is **posted** —
a draft keeps the text and moves nothing. `components/invoice-editor.tsx` grows the two columns
behind `withNumbers` and keeps computing the totals itself, so what the operator reads before
saving is exactly what gets stored; the POS ticket stays without them (the cashier scans, the
invoice screen writes numbers).

The header of both screens carries the window's own field, «🔢 التسلسلي:» (`frmInvSale.xaml`
L592 · `txtSrchSerialNo`), read on `Enter` as the desktop reads it (`frmInvSale.xaml.cs:3599` →
`SearchBySerialNo:722`). Typing a number on the shelf appends a line that already carries it;
otherwise the window's three messages appear in its own words, kept in
`lib/serial-numbers.ts` and pinned by `tests/serial-numbers.spec.ts`: «تم إدراج هذا الرقم
التسلسلي من قبل» (:733) · «تم بيع أو إخراج هذا الرقم التسلسلي» (:769) · «لا يوجد صنف بهذا الرقم
التسلسلي» (:780). The purchase window has **no** such field in its header — its entry point is the
grid's context menu (`frmInvPurch.xaml:714` → `.cs:897`) — so there the field is an addition, and
it is justified as such in §R8.4 of `docs/desktop-parity/PHASE_02_SALES_ENGINE.md`.

A held POS ticket (`pos/holds`) now stores its lines as the shared draft, so numbers typed before
a hold survive the recall; older holds are completed with `emptyLine()` on restore instead of
crashing on the missing keys.


## What R3 (2026-09-20) changed here

The purchase invoice screens now carry `frmInvPurch.xaml`'s own words — the **full** window
(the trimmed `frmPurchInv.xaml` copy has bare buttons and would have produced a shorter label
table than the desktop really has). `purchases/invoices/new` is titled «فاتورة المشتريات»
(:7) with «👤 اسم المورد» (:383), «🏪 المستودع» (:414) and «📋 المرجع» (:545, the supplier's
invoice number — duplicated references print the window's own
«عفوآ رقم المرجع موجود مسبقآ هل تريد الاستمرار ؟», `frmInvPurch.xaml.cs:1211`, as a notice and
**not** a block, exactly like the desktop), plus the desktop's two buttons in its own order:
«💾 حفظ» (:1428) and «🖨️💾 حفظ مع طباعة» (:1424 — the icons are reversed compared with the
sales window). `purchases/invoices/[id]` gained «🔢 الرقم» (:366), «📅 التاريخ» (:434),
«🕐 وقت الفاتورة» (:503), «💳 طريقة الدفع» (:330) with the desktop's three options
«آجلة»/«نقدية»/«بنك» (`frmInvPurch.xaml.cs:191–193`), the till/bank picker labelled
«🏦 الصندوق» (:340) or «🏦 البنك» (:424), «🖨️ طباعة» (:1411), «🗑️ إلغاء الفاتورة» (:1406), the
lines card «📋 بنود الفاتورة» (:665) and the summary rows «📊 عدد البنود» · «📦 إجمالي الكمية»
· «🏷️ خصم الفاتورة» (:920–:936).

**The line grid follows the desktop's column order** (:732–:867): «🔍 الصنف · الكمية · السعر ·
المجموع · الخصم · الإجمالي · الضريبة · الصافي», where «المجموع» is quantity × price,
«الإجمالي» is after the line's share of the invoice discount and «الصافي» adds VAT — the
`gross`/`net`/`total` of `calculateInvoiceTotals` and of `ItemOper.CalcTotal`'s
`ItemSumPrice`/`lineTotal`/`ItemNetPrice`. Two columns have no desktop counterpart
(«📦 مصاريف محمّلة» · «📦 التكلفة النهائية») because the desktop melts the additional cost
into the item cost at save time (`ItemAdditonalCos`, `ItemOper.cs:2086`) — the cloud shows
the allocation and the result instead of hiding them.

**And the paid rows are finally readable:** `GET /purchase-invoices/:id` now returns
`payments` from `payment_allocations` (ordered by `allocatedAt`), so the card
«💵 الدفعات المسدّدة» shows the cash settlement row the posting engine itself wrote instead of
`paidTotal` alone.

## What R4 (2026-09-20) changed here

The till gained the desktop's speed features — and the screens now say what the windows say.

**⏸️ Hold tickets, nine slots.** The strip under the till is `frmPOS.xaml`'s row of holds
(:1129–:1179): nine buttons «1»…«9» that turn green when busy (`frmPOS.xaml.cs:1904–:1907`,
copied as an inline colour) and «⏸️ تعليق  F7» (:1175 — and F7 really is bound, :311). Pressing a
free button holds the cart; pressing a busy one recalls it; a click refuses on a non-empty cart
with the window's own «يوجد أصناف في الجدول» (:1952); a right-click releases the slot. The
engine repeats the same text when the ninth slot is taken («لقد وصلت للحد الاقصي من عمليات
الايقاف المؤقت», :1932 → `POS_HOLD_LIMIT_REACHED`). Unlike the desktop — which saves a held
ticket as an invoice with `inv_type=3/proc_type=3` and therefore burns a number for a sale that
never happened — the cloud stores **the cart**, because numbering happens at posting.

**🔀 متعدد — several tenders on one ticket** (`frmPOSPay.xaml:286`). Each row is «💵 كاش» /
«🖧 شبكة» / «💳 تحويل» (`:268`·`:274`·`:282`) with its amount and its own drawer or bank, and a
«⚖️ مطابقة» line (:548) shows مطابق / زيادة / ناقص *before* the cashier commits — the same
answer the engine gives (`POS_TENDER_MISMATCH`). What is not covered by the tenders stays on the
customer's account, so «دفع 50 نقداً والباقي على الحساب» is one ticket and one journal entry
(`partial`), not an invoice plus a receivable written by hand. The receipt prints the tenders
one by one and «على حساب العميل» under them.

**✋ The price field is the permission.** The desktop disables the price editor for anyone
without `User.EditPrice` (`Class/User.cs:24`) and answers «لا يمكن تعديل السعر»
(`frmPOS.xaml.cs:1377`) — the cloud greys the field for a cashier without `pos.priceoverride`
and the engine refuses with the same Arabic sentence (403), so hiding is not the enforcement.

**⚙️ إعدادات الكاشير** (`frmCasherSetting.xaml`) are real settings at last: `📷 الباركود
أوتوماتيك` (:239 — Enter in the search box adds the single match), `👆 الشاشة تدعم التاتش سكرين`
(:252 — larger tiles), `📦 عرض المجموعات والأصناف` (:265 — the category chips),
`🚗 قيمة التوصيل الافتراضية` (:271) · `🛡️ قيمة التأمين الافتراضية` (:279) · `📏 الوحدة
الافتراضية` (:287). The till reads them with `GET /pos/settings` (`pos.view` — a cashier has no
`tenant.settings.manage`) and `/settings/general` writes them with the window's own labels and
its «حفظ الإعدادات» button (:300).

**🔗 قيد الإغلاق** (`/sales/shifts`) closes the loop `EntryOper.BindCloseShiftToEntry` (L402)
opened: a counted shift with a variance now says «مربوط» or offers «🔗 ربط», and a drawer that
matches to the fils is refused with the engine's own «الصندوق مطابق — لا قيد» — which is the
truth: a zero difference is not an entry.

## What R5 (2026-09-20) changed here

The batch came out of its own screen and onto the document line, where the desktop keeps it.

**📁 رقم الدفعة · 📅 تاريخ الإنتاج · ⏳ تاريخ الانتهاء** — three columns on the line grids of
`/inventory/vouchers`, `/inventory/adjustments` and `/inventory/transfers`, the captions
`frmItemSerialNo.xaml` uses (:434–:460). The clerk types the number off the pack — a new
batch is created with those dates, an existing one is looked up by (item · number) — and the
dates under it are the pack's own. A batch already registered keeps its dates: an empty box
fills them, a box that disagrees is refused by the engine with the batch and both dates named
(`409 LOT_EXPIRY_MISMATCH`), so a lot can never end up with two expiry dates and an expiry
report that reads whichever it likes. An item that is not lot-tracked greys the three boxes and
the engine refuses the number (`422 LOT_NOT_TRACKED`). The number box keeps a `datalist` of the
registered batches for that item, so picking one is a click instead of a retyping.

**📥 تاريخ الاستلام** — the lot screen used to write the receiving date into a box labelled
«📅 تاريخ الإنتاج»: one column, two meanings, and the destructive one at that. `item_lots` now
has `production_date` beside `received_at` (migration 0088 copies the old value once), the form
asks for both by their names, and the lot grid shows `📅 تاريخ الإنتاج` · `⏳ تاريخ الانتهاء` ·
`📥 تاريخ الاستلام` as three separate columns.

The posted document shows what it was told: `📁 رقم الدفعة` with its production and expiry
dates on the line card, read off the line itself — not re-derived from the lot.

## Design System v3

The staff surface is built on the shared kit in `packages/ui` (see its README for the
full contract). Local notes for this app:

- **Tokens.** `app/globals.css` imports `@erp/ui/tokens.css` and nothing else declares
  the contract. Dark mode is complete here — the theme key is `erp.theme`
  (`light|dark|system`), the top bar carries `ThemeToggle`, and the blocking
  `ThemeScript` in `app/layout.tsx` prevents a flash of the wrong theme.
- **Bilingual shell.** The top bar also carries the AR/EN switch. It drives
  `lib/i18n.tsx`, which sets `<html lang>` and `<html dir>`; keys are additive only.
- **`/design`** renders `DesignGallery` — every component once, in both themes. It is
  `notFound()` in production; it exists for review, not for users. Note that it sits
  behind the app's own `AuthGate` like every other route — the gate was **not** relaxed
  to open a colour palette to anonymous visitors. Sign in first, then open `/design`.
- **Screen honesty.** The sidebar carries a `تغطية الشاشات` card counting how many
  registered screens are `ready` versus `api` versus `planned` (`lib/navigation.ts` is
  the registry). A screen whose status is not `ready` renders an honest
  `EmptyState` naming its endpoint or its missing permission — it is never hidden and
  never faked.
- **POS is dark-first.** The POS screens assume the dark palette and are the model the
  dark theme is tuned against.
- **Layout.** 288 px sticky sidebar, 56 px top bar, 1400 px content measure.
