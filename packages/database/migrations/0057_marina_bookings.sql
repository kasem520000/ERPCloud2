-- Phase 09 part six — ⛵ المرسى: الحجوزات والمخالفات
-- (`Form_WPF/frmBookingM.xaml` «الحجوزات» · `Form_WPF/frmViolationM.xaml` «المخالفات» ·
-- `Form_WPF/frmInvoiceRentSrch.xaml` «بحث الفواتير»).
--
-- `frmBookingM` («الحجوزات») is one window on two tabs.
--
--   • «📋 بيانات الحجوزات» — 🔢 الرقم (`txtNo`) · 📅 التاريخ (`txtDate`) · 📋 الفئة
--     (`cmbGroup`) · 🔖 حالة الحجز (`cmbBookingStatu`: «مؤكد»/«غير مؤكد») · 🚢 نوع الحجز
--     («حجز عادي»/«بحر مفتوح») · 🕐 وقت الحجز (`txtTime`) · 📅 تاريخ الحجز
--     (`cmbBookingDate`) · 👤 العميل (`cmbClients` + ➕) · ⚓ المركب (`cmbMarine`) ·
--     💰 القيمة (`txtPrice`) · ⏱️ المدة ساعة (`hour`) ودقيقة (`minute`) · 🎁 الإضافات
--     (`cmbAdditions` من جدول `Additions`، مع الكمية والسعر والإجمالي) · ثم المجاميع:
--     «إجمالي الإضافات» · «الإجمالي» · «ضريبة 15%» · «الصافي».
--   • «🔍 البحث» — رقم الحجز (`Booking.bId`) أو من تاريخ/إلى تاريخ، أو عميل، والشبكة
--     «📋 نتائج البحث»: `رقم الحركة · الرقم · التاريخ · العميل · الجوال · رقم العميل`.
--
-- What it writes (`frmBookingM.xaml.cs` L669–L726), one transaction:
--
--   insert into Booking(InvID, MarineId, UserId, ClientId, Bdate, dateIn, PeriodHour,
--     PeriodMinute, Price, status, BookingType, notes, IsDeleted) …
--   delete BookingAddition where bookId=…            -- then every addition again
--   insert into BookingAddition(bookId, AditionID, Price, quanty, notes, IsDeleted) …
--   insert into RentInvoice(… tot_Rent, tot_Additions, tot_net, tax, RentPeriod …)
--
-- and what it refuses before any of that: «يجب تحديد مدة الحجز» when الساعة والدقيقة
-- both stand at zero. The totals are `CalcuAll` (L478):
--
--   إجمالي الإضافات = Σ(العدد × السعر) · الإجمالي = الإضافات + القيمة ·
--   ضريبة = ROUND(الإجمالي × MainVAT ÷ 100, 2) · الصافي = الإجمالي + الضريبة
--
-- with `MainVAT` read from `SettingGeneral where Inv_Id=4` (`LoadMainSettings` L278) —
-- the marina's own VAT, 15 by default, and the XAML's label «ضريبة 15%» is its shadow.
--
-- `frmViolationM` («المخالفات») is the smaller card: 🔢 الرقم · 📅 التاريخ · ⛵ المركب ·
-- ⚠️ نوع المخالفة · ⏱️ مدة المخالفة (يوم) · 📝 ملاحظة, saved as
-- `insert into Violation(MarineId, Vdate, Period, status, ViolatType, notes, IsDeleted)`,
-- with three refusals in this order: «يجب اختيار المركب» · «يجب تحديد مدة المخالفة» ·
-- «يجب تحديد نوع المخالفة», and the الرقم is `MAX(id) + 1` (`LoadNextNo`).
--
-- Two columns this migration does **not** add, and why:
--
--   1. `Booking.notes` — the window's «📝 ملاحظات» box (`txtNotes`) is only ever *cleared*
--      (`ClearAll` L519); the row is saved with `notes = N' حجز رقم' + txtNo`. So the box
--      is dead in the desktop and is not resurrected here.
--   2. a notes column for the violation — `marina_violations.description` already holds
--      what the desktop stores in `Violation.notes` (📝 ملاحظة); the type is new, the note
--      is not.

-- 🔢 الرقم — `txtNo` is `select Bid from Booking where IsDeleted=0` + 1 in the desktop;
-- the cloud gives every وثيقة رقمها الخاص (`BK-000001`), as `Inv_Tailor` and every other
-- document here do. Rows written before this migration keep `number IS NULL` and are
-- shown by their رقم الحركة instead.
ALTER TABLE marina_bookings ADD COLUMN IF NOT EXISTS number text;
ALTER TABLE marina_bookings ADD COLUMN IF NOT EXISTS document_date date NOT NULL DEFAULT CURRENT_DATE;
-- 🚢 نوع الحجز — `bookingType = rbNormal.IsChecked ? "حجز عادي" : "بحر مفتوح"`.
ALTER TABLE marina_bookings ADD COLUMN IF NOT EXISTS booking_type text NOT NULL DEFAULT 'حجز عادي';
-- ⏱️ المدة ساعة · دقيقة — `PeriodHour` · `PeriodMinute` (`RentPeriod` = ساعة + دقيقة ÷ 60).
ALTER TABLE marina_bookings ADD COLUMN IF NOT EXISTS period_hours integer NOT NULL DEFAULT 0;
ALTER TABLE marina_bookings ADD COLUMN IF NOT EXISTS period_minutes integer NOT NULL DEFAULT 0;
-- 💰 القيمة — `Booking.Price` (`txtPrice`), typed by the operator; `tot_Rent` of the فاتورة.
ALTER TABLE marina_bookings ADD COLUMN IF NOT EXISTS rental_amount numeric(20, 4) NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS marina_bookings_tenant_number_key
  ON marina_bookings (tenant_id, number)
  WHERE number IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS marina_bookings_tenant_date_idx
  ON marina_bookings (tenant_id, document_date, created_at);

COMMENT ON COLUMN marina_bookings.number IS '🔢 الرقم — `txtNo` في `frmBookingM`؛ «حجز رقم …» هو ما يكتبه الديسكتوب في الملاحظات';
COMMENT ON COLUMN marina_bookings.booking_type IS '🚢 نوع الحجز — «حجز عادي» أو «بحر مفتوح»، بنصّهما كما يحفظهما `frmBookingM`';
COMMENT ON COLUMN marina_bookings.period_hours IS '⏱️ المدة ساعة — `PeriodHour`';
COMMENT ON COLUMN marina_bookings.period_minutes IS '⏱️ المدة دقيقة — `PeriodMinute`؛ و`RentPeriod` = الساعة + الدقيقة ÷ 60';
COMMENT ON COLUMN marina_bookings.rental_amount IS '💰 القيمة — `Booking.Price`، وتصير `tot_Rent` في فاتورة التأجير';

-- 🎁 الإضافات — `BookingAddition(bookId, AditionID, Price, quanty, notes, IsDeleted)`:
-- الشبكة عند الديسكتوب `id · الوصف · العدد · السعر · الإجمالي`، فالإضافة كمية وسعرُ وحدة
-- لا مبلغاً واحداً. `amount` يبقى (الإجمالي) لكل صفٍّ كُتب قبل هذا الترحيل.
ALTER TABLE marina_booking_additions ADD COLUMN IF NOT EXISTS quantity numeric(20, 4) NOT NULL DEFAULT 1;
ALTER TABLE marina_booking_additions ADD COLUMN IF NOT EXISTS unit_price numeric(20, 4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN marina_booking_additions.quantity IS 'العدد — `quanty` في `BookingAddition`';
COMMENT ON COLUMN marina_booking_additions.unit_price IS 'السعر — `Price` في `BookingAddition` (سعر الوحدة)؛ والإجمالي = العدد × السعر';

-- ⚠️ المخالفات — `Violation(MarineId, Vdate, Period, status, ViolatType, notes, IsDeleted)`
ALTER TABLE marina_violations ADD COLUMN IF NOT EXISTS number text;
ALTER TABLE marina_violations ADD COLUMN IF NOT EXISTS violation_type text;
ALTER TABLE marina_violations ADD COLUMN IF NOT EXISTS period_days numeric(20, 4);

CREATE UNIQUE INDEX IF NOT EXISTS marina_violations_tenant_number_key
  ON marina_violations (tenant_id, number)
  WHERE number IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS marina_violations_tenant_type_idx
  ON marina_violations (tenant_id, violation_type, violation_date);

COMMENT ON COLUMN marina_violations.number IS '🔢 الرقم — `MAX(id) + 1` في `frmViolationM.LoadNextNo`';
COMMENT ON COLUMN marina_violations.violation_type IS '⚠️ نوع المخالفة — `ViolatType`؛ ورفضها «يجب تحديد نوع المخالفة»';
COMMENT ON COLUMN marina_violations.period_days IS '⏱️ مدة المخالفة (يوم) — `Period`؛ ورفضها «يجب تحديد مدة المخالفة»';

-- 🧾 فاتورة التأجير — `RentInvoice(tot_rent, tot_Additions, tax, tot_net)`:
-- المجاميع التي يحسبها `CalcuAll` وتُحفظ مع الفاتورة، لا تُحسب عند الطباعة وحدها.
ALTER TABLE rental_invoices ADD COLUMN IF NOT EXISTS tax_amount numeric(20, 4) NOT NULL DEFAULT 0;
ALTER TABLE rental_invoices ADD COLUMN IF NOT EXISTS net_amount numeric(20, 4) NOT NULL DEFAULT 0;
ALTER TABLE rental_invoices ADD COLUMN IF NOT EXISTS document_date date;

COMMENT ON COLUMN rental_invoices.tax_amount IS 'ضريبة 15% — `tax`؛ `ROUND(الإجمالي × MainVAT ÷ 100, 2)` من `SettingGeneral where Inv_Id=4`';
COMMENT ON COLUMN rental_invoices.net_amount IS 'الصافي — `tot_net`؛ الإجمالي + الضريبة';
