# Marina pack (Phase 22 + Phase 09 parts six, seven & nine)

Feature flag: `pack.marina`. Covers vessel groups, hour/half-hour/offer pricing, vessels,
owner percentage links, bookings with insurance/companions metadata, booking additions,
rental invoice composition through the sales service, violations and lightweight daily
operation plans.

## Where the documents come from (Phase 09 part six)

| Window | File | What it holds |
|---|---|---|
| الحجوزات | `Form_WPF/frmBookingM.xaml` («الحجوزات») | «📋 بيانات الحجوزات» و«🔍 البحث» — 🔢 الرقم · 📅 التاريخ · 📋 الفئة · 🔖 حالة الحجز («مؤكد»/«غير مؤكد») · 🚢 نوع الحجز («حجز عادي»/«بحر مفتوح») · ⏱️ المدة ساعة/دقيقة · 💰 القيمة · 🎁 الإضافات (الكمية · السعر · الإجمالي) · مجاميع «إجمالي الإضافات · الإجمالي · ضريبة 15% · الصافي» |
| المخالفات | `Form_WPF/frmViolationM.xaml` («المخالفات») | 🔢 الرقم · ⛵ المركب · ⚠️ نوع المخالفة · ⏱️ مدة المخالفة (يوم) · 📝 ملاحظة — وثلاثة رفوض: «يجب اختيار المركب» · «يجب تحديد مدة المخالفة» · «يجب تحديد نوع المخالفة» |
| بحث الفواتير | `Form_WPF/frmInvoiceRentSrch.xaml` («بحث الفواتير») | «🔍 خيارات البحث»: العميل أو جواله · التاريخان · الصافي من/إلى، و«🧾 قائمة الفواتير»: الرقم · التاريخ · العميل · الصافي · الجوال |

The save is one transaction over three tables (`frmBookingM.xaml.cs` L590–L740):
`RentInvoice` (with `tot_Rent` · `tot_Additions` · `tax` · `tot_net` · `RentPeriod`), then
`Booking`, then `delete BookingAddition` and the additions again. The totals are
`CalcuAll` (L478) — `ضريبة = ROUND(الإجمالي × MainVAT ÷ 100, 2)` و`الصافي = الإجمالي +
الضريبة` — with `MainVAT` read from `SettingGeneral where Inv_Id=4`
(`marina.vatRate` here, 15 by default).

`booking-documents.service.ts` carries the two documents; `group-cards.service.ts`
carries the فئة and its ⏰ فترات التأجير; `additions.service.ts` carries the ➕ الإضافات;
`marina.service.ts` keeps the definitions, the operations and the rental invoice. The **operations controller is registered first** in
`marina.module.ts`: its static `bookings/uninvoiced` must be mapped before the documents'
`bookings/:id` — and inside the documents controller `groups/navigate` is declared before
`groups/:id` for the same reason.

## Where the ➕ الإضافات come from (Phase 09 part nine)

| Window | File | What it holds |
|---|---|---|
| 📋 إضافات | `Form_WPF/frmAdditions.xaml` («📋 إضافات» — «📋 إدارة الإضافات») | 🔢 الرقم (read-only) · 📝 الاسم · 💰 القيمة · ➕ جديد · 💾 حفظ · 🗑️ حذف، وشبكة بالأعمدة نفسها |
| 🎁 الإضافات | `Form_WPF/frmBookingM.xaml` («الحجوزات») | `cmbAdditions` · الكمية · السعر · الإجمالي · «➕ إضافة صنف جديد» |

`Additions(id, name, SalePrice, IsDeleted)` is read by «🎁 الإضافات» and written by
`frmAdditions`:

```
select id, Name from Additions where IsDeleted=0                  -- LoadAdditions
select SalePrice from Additions where IsDeleted=0 and id=…        -- «السعر» عند الاختيار
insert into Additions(name, SalePrice, IsDeleted) values(…, …, 0)  -- «💾 حفظ»
update Additions set name=…, SalePrice=… where id=…                -- «💾 حفظ» على قديم
delete from Additions where id=…                                   -- «🗑️ حذف»
```

and its refusals are `MARINA_ADDITION_NAME_REQUIRED` «يجب إدخال اسم الإضافة ⚠️» (422) ·
`MARINA_ADDITION_QUANTITY_REQUIRED` «يجب إدخال الكمية  » (422) ·
`MARINA_ADDITION_NOT_FOUND` «الإضافة غير موجودة» (404) ·
`MARINA_ADDITION_DELETE_REQUIRED` «يجب تحديد الإضافة المراد حذفها ⚠️» (404).

Three departures from the window, all recorded in `PHASE_09_VERTICALS.md` §12.3: 🔢 الرقم
is a stored column (`max(الرقم) + 1`) rather than the window's `count + 1`, which collides
as soon as a row is deleted; «🗑️ حذف» retires the تعريف instead of erasing it, so the
حجوزات that already carry it keep their «الإجمالي»; and 🧾 الاستخدام (`usageCount`) is
shown instead of refusing a تعريف in use.

## Where the definitions come from (Phase 09 part seven)

| Window | File | What it holds |
|---|---|---|
| 📋 بطاقة فئة | `Form_WPF/frmGroupM.xaml` («📋 بطاقة فئة») | 🖼️ صورة الفئة · 🔢 الرقم · رمز الفئة · اسم الفئة (عربي/EN) · قيمة الساعة · عرض الساعة (دقيقة) · قيمة النصف ساعة · عرض النصف ساعة (دقيقة) · «➕ إضافة مدة» · «📋 قائمة الفئات» · ⏮ ◀ ▶ ⏭ · 🗑️ حذف · 💾 حفظ · ➕ جديد |
| ⏰ فترات التأجير | `Form_WPF/frmAddPeriod.xaml` («⏰ فترات التأجير») | 🏷️ الفئة، ثم «⏰ المدة · 💵 السعر · 🎁 العرض · 🗑️» — عشر مددٍ من `RentPeriod` |

`frmGroupM.btnSave_Click` writes `GroupMarine`, then `delete RentPeriodSub where
MGroupID=…`, then the two canonical periods — `periodID=2` (ساعة) من قيمة الساعة،
و`periodID=1` (نصف ساعة) من قيمة النصف ساعة — **on every save**, whatever `frmAddPeriod`
had stored. `frmAddPeriod.SaveRentPeriods` is the mirror: `delete` everything for the فئة
then every row of the grid. Both are kept, so a caller that replaces the periods replaces
the whole tariff — including «ساعة» و«نصف ساعة» اللتين يقرأهما تسعير الحجز.

⏰ المدة is a constant (`RENT_PERIODS` in `group-cards.service.ts`), not a table: the
desktop's `RentPeriod` has no window of its own and is seeded in `AlterDb.txt` L3317
(نصف ساعة … خمس ساعات). Only `period_id` is stored; `minutes` is derived from it, and
`period_kind` stays `'hour'`/`'half_hour'` for the two canonical durations so the pricing
of a حجز (`marina.service.ts` → `calculateMarinaPeriod`) is unchanged.

## Endpoints

| Method | Path | Permission | What it is |
|---|---|---|---|
| GET | `/marina/bookings` | `marina.view` | the list; `?number=` · `?customer=` (name or phone) · `?partyId=` · `?vesselId=` · `?status=` · `?from=`/`?to=` |
| GET/POST | `/marina/bookings`, `/marina/bookings/{id}` | view / manage | the card; «يجب تحديد مدة الحجز» before anything is written |
| PATCH/DELETE | `/marina/bookings/{id}` | `marina.manage` | تعديل (with `version`) · حذف ناعم |
| POST/DELETE | `/marina/bookings/{id}/additions`, `…/additions/{additionId}` | `marina.manage` | 🎁 الإضافات — العدد × السعر |
| POST | `/marina/bookings/{id}/rental-invoice` | `marina.invoice` | `RentInvoice` — القيمة · الإضافات · التأمين · الإجمالي · الضريبة · الصافي |
| GET/POST | `/marina/violations`, `/marina/violations/{id}` | view / manage | ⚠️ المخالفات، وثلاثة رفوض بترتيبها |
| PATCH/DELETE | `/marina/violations/{id}` | `marina.manage` | تعديل · حذف ناعم («اختر المخالفة ليتم حذفها») |
| GET | `/marina/groups` | `marina.view` | «📋 قائمة الفئات» بفتراتها وعدد مراكبها |
| GET | `/marina/rent-periods` | `marina.view` | ⏰ المدة — the ten durations of `RentPeriod` |
| GET | `/marina/groups/navigate` | `marina.view` | ⏮ ◀ ▶ ⏭ — `?dir=first|previous|next|last` و`?currentId=`; stays put at the ends |
| GET/POST | `/marina/groups`, `/marina/groups/{id}` | view / manage | 📋 بطاقة فئة — «ادخل الفئة» · «الفئة تم ادخالها مسبقا» · «رابط صورة الفئة غير صحيح» |
| PATCH/DELETE | `/marina/groups/{id}` | `marina.manage` | تعديل (with `version`) · «هذه الفئة لها ارتباطات فرعية لايمكن حذفها» · «اختر الفئة ليتم حذفها» (404) |
| PUT | `/marina/groups/{id}/periods` | `marina.manage` | ⏰ فترات التأجير — `delete` then every row; «يجب إستكمال البيانات ⚠️» |
| DELETE | `/marina/vessels/{id}` | `marina.manage` | تقاعد مركب — a فئة cannot be removed while it holds one |
| GET | `/marina/rental-invoices` | `marina.view` | «🔍 خيارات البحث»: `?customer=` · `?from=`/`?to=` · `?minNet=`/`?maxNet=` |
| POST | `/marina/rental-invoices/link` | `marina.invoice` | إصدار فواتير لحجوزاتٍ بلا فاتورة |

## Tests

- `apps/api/test/marina-booking-documents.spec.ts` — 11 tests: the card and its four
  totals, the refusals, the additions, the version conflict, the search, the violation and
  its three refusals, the rental invoice and its search, the delete, the permission split
  and tenant isolation.
- `apps/api/test/marina-operations.spec.ts` — preparation, rota, invoice linking and the
  frozen day (a booking dated into a closed day is still refused).
- `apps/api/test/marina-group-cards.spec.ts` — 9 tests: the ten durations, the card and the
  two periods written from it, the four refusals, the update and `VERSION_CONFLICT`, the
  periods and «يجب إستكمال البيانات ⚠️», ⏮ ◀ ▶ ⏭, the two delete refusals, the permission
  split and tenant isolation.
- `scripts/verify-marina.mjs` — 45 live checks against a running stack; re-runnable and
  non-destructive (it deletes the bookings and violations it creates, in a `finally`).
- `scripts/verify-marina-groups.mjs` — 58 live checks for the فئة and its فترات; every
  فئة and مركب it writes is deleted in a `finally`.

## Staff screens

`/marina/bookings` (⛵ الحجوزات), `/marina/violations` (⚠️ المخالفات) and
`/marina/link-invoices` (🧾 بحث الفواتير — with «🔍 خيارات البحث» and the linking action).
`/marina/groups` (📋 بطاقة فئة) carries the فئة with its ⏰ فترات التأجير in a second
window, and `/marina/vessels` keeps the rest of the definitions (vessels · owners).
