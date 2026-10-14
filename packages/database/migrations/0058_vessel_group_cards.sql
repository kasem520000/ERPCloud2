-- Phase 09 part seven — ⛵ المرسى: 📋 بطاقة الفئة و⏰ فترات التأجير
-- (`Form_WPF/frmGroupM.xaml` «📋 بطاقة فئة» · `Form_WPF/frmAddPeriod.xaml`
--  «⏰ إدارة فترات التأجير»).
--
-- `frmGroupM` is the card of a فئة of مراكب — what the harbour calls a class — and it
-- carries the tariff that prices every حجز في `frmBookingM`:
--
--   • 🖼️ صورة الفئة — `GroupMarine.image` (📂 اختر / 🗑️ حذف)
--   • 🔢 رقم الفئة (`txtNo`, read-only — `LoadNextNo` = `count(GroupMarine) + 1`)
--   • رمز الفئة (`txtCode`) · اسم الفئة (عربي) (`txtName`) · اسم الفئة (EN) (`txtNameEN`)
--   • قيمة الساعة (`txtHourPrice`) · عرض الساعة (دقيقة) (`txtHourOffer`)
--   • قيمة النصف ساعة (`txtHalfHPrice`) · عرض النصف ساعة (دقيقة) (`txtHalfHOffer`)
--   • «➕ إضافة مدة» → `frmAddPeriod`
--   • «📋 قائمة الفئات» (رقم الفئة · رمز الفئة · اسم الفئة · قيمة الساعة · قيمة النصف ساعة)
--   • ⏮ الأول · ◀ السابق · ▶ التالي · ⏭ الأخير · 🖨️ طباعة · 🗑️ حذف · 💾 حفظ · ➕ جديد
--
-- What `btnSave_Click` writes, in this order:
--
--   insert into GroupMarine(id, code, name, nameEN, HourPrice, HalfHPrice,
--     OfferHour, OfferHalf, IsDeleted, image) …
--   delete from RentPeriodSub where MGroupID=…
--   insert into RentPeriodSub(MGroupID, code, periodID, rent, offer) …   -- periodID = 2 (ساعة)
--   insert into RentPeriodSub(MGroupID, code, periodID, rent, offer) …   -- periodID = 1 (نصف ساعة)
--
-- so the two canonical periods are re-written on **every** save of the card — even when
-- `frmAddPeriod` had added other durations. That is preserved below, and written down in
-- the docs.
--
-- `frmAddPeriod` («⏰ فترات التأجير») is the grid of the rest of the durations:
-- 🏷️ الفئة (`cmbGroup`) then «⏰ المدة · 💵 السعر · 🎁 العرض · 🗑️ حذف», saved as
-- `delete RentPeriodSub where MGroupID=…` followed by every row again, with two refusals
-- in this order: «يجب إستكمال البيانات ⚠️» (a row with no فترة or no سعر) and
-- «يجب اختيار الفئة أولاً ⚠️».
--
-- ⏰ المدة comes from `RentPeriod(id, name)` — ten seeded durations:
--
--   1 نصف ساعة · 2 ساعة · 3 ساعة و نصف · 4 ساعتين · 5 ساعتين و نصف ·
--   6 ثلاث ساعات · 7 ثلاث ساعات و نصف · 8 أربع ساعات · 9 أربع ساعات و نصف · 10 خمس ساعات
--
-- a fixed reference list with no window of its own, so it lives here as a constant in the
-- marina module and only its `id` is stored — the way «حجز عادي»/«بحر مفتوح» are stored.
--
-- Two things this migration does **not** add, and why:
--
--   1. `RentPeriodSub.code` — it is a copy of `GroupMarine.code` written on every insert;
--      the group already carries its own رمز, so the copy is not resurrected.
--   2. an image blob — `GroupMarine.image` is a SQL Server `image` column holding the
--      bytes of the picture; this platform has no attachment store, so 🖼️ صورة الفئة is
--      kept as a URL (`image_url`) and the screen accepts a link or a data URL.

-- 🔢 رقم الفئة — `GroupMarine.id` in the desktop (`LoadNextNo` = `count + 1`).
ALTER TABLE vessel_groups ADD COLUMN IF NOT EXISTS number integer;
-- اسم الفئة (EN) — `GroupMarine.nameEN` (`txtNameEN`).
ALTER TABLE vessel_groups ADD COLUMN IF NOT EXISTS name_en text;
-- قيمة الساعة — `HourPrice` (`txtHourPrice`).
ALTER TABLE vessel_groups ADD COLUMN IF NOT EXISTS hour_price numeric(20, 4) NOT NULL DEFAULT 0;
-- عرض الساعة (دقيقة) — `OfferHour` (`txtHourOffer`).
ALTER TABLE vessel_groups ADD COLUMN IF NOT EXISTS hour_offer_minutes integer NOT NULL DEFAULT 0;
-- قيمة النصف ساعة — `HalfHPrice` (`txtHalfHPrice`).
ALTER TABLE vessel_groups ADD COLUMN IF NOT EXISTS half_hour_price numeric(20, 4) NOT NULL DEFAULT 0;
-- عرض النصف ساعة (دقيقة) — `OfferHalf` (`txtHalfHOffer`).
ALTER TABLE vessel_groups ADD COLUMN IF NOT EXISTS half_hour_offer_minutes integer NOT NULL DEFAULT 0;
-- 🖼️ صورة الفئة — `GroupMarine.image`, as a URL: this platform has no byte store.
ALTER TABLE vessel_groups ADD COLUMN IF NOT EXISTS image_url text;

-- Every فئة written before this migration gets its رقم in the order it was created, so
-- ⏮/◀/▶/⏭ have something to walk.
UPDATE vessel_groups AS g
   SET number = ranked.rn
  FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at, code) AS rn
      FROM vessel_groups
     WHERE number IS NULL
  ) AS ranked
 WHERE g.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS vessel_groups_tenant_number_key
  ON vessel_groups (tenant_id, number)
  WHERE number IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN vessel_groups.number IS '🔢 رقم الفئة — `GroupMarine.id` عند الديسكتوب، و`LoadNextNo` = عدد الفئات + 1';
COMMENT ON COLUMN vessel_groups.name_en IS 'اسم الفئة (EN) — `nameEN` (`txtNameEN`)';
COMMENT ON COLUMN vessel_groups.hour_price IS 'قيمة الساعة — `HourPrice` (`txtHourPrice`)';
COMMENT ON COLUMN vessel_groups.hour_offer_minutes IS 'عرض الساعة (دقيقة) — `OfferHour` (`txtHourOffer`)';
COMMENT ON COLUMN vessel_groups.half_hour_price IS 'قيمة النصف ساعة — `HalfHPrice` (`txtHalfHPrice`)';
COMMENT ON COLUMN vessel_groups.half_hour_offer_minutes IS 'عرض النصف ساعة (دقيقة) — `OfferHalf` (`txtHalfHOffer`)';
COMMENT ON COLUMN vessel_groups.image_url IS '🖼️ صورة الفئة — `GroupMarine.image`؛ رابطٌ لا صورةً مخزّنة، إذ لا مخزن ملفّاتٍ بعد';

-- ⏰ فترات التأجير — `RentPeriodSub(MGroupID, code, periodID, offer, rent)`.
-- `vessel_group_pricing` was already the فئة's tariff (it is what prices a حجز when
-- `Booking.Price` is empty), so the extra durations join it rather than start a second
-- table: `period_id` is `RentPeriod.id`, `minutes` the length of that فترة, و`offer_minutes`
-- هو 🎁 العرض. The two canonical durations keep the `period_kind` the pricing code already
-- reads ('hour' لِ period 2، و'half_hour' لِ period 1) so nothing that prices a حجز اليوم
-- يتغيّر.
ALTER TABLE vessel_group_pricing ADD COLUMN IF NOT EXISTS period_id integer;
ALTER TABLE vessel_group_pricing ADD COLUMN IF NOT EXISTS minutes integer NOT NULL DEFAULT 0;
ALTER TABLE vessel_group_pricing ADD COLUMN IF NOT EXISTS offer_minutes integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS vessel_group_pricing_period_key
  ON vessel_group_pricing (tenant_id, group_id, period_id)
  WHERE period_id IS NOT NULL;

-- ⏰ المدة عشر مددٍ لا أربع: `0018` قيّد `period_kind` بـ
-- ('hour','half_hour','offer','day'), والفترات من 3 إلى 10 تأخذ `period_<id>`، فالقيد
-- يُوسَّع ولا يُلغى.
ALTER TABLE vessel_group_pricing DROP CONSTRAINT IF EXISTS vessel_group_pricing_period_kind_check;
ALTER TABLE vessel_group_pricing ADD CONSTRAINT vessel_group_pricing_period_kind_check
  CHECK (period_kind IN ('hour', 'half_hour', 'offer', 'day') OR period_kind ~ '^period_[0-9]+$');

COMMENT ON COLUMN vessel_group_pricing.period_id IS '⏰ المدة — `RentPeriodSub.periodID`، أي `RentPeriod.id` (1 نصف ساعة … 10 خمس ساعات)';
COMMENT ON COLUMN vessel_group_pricing.minutes IS 'طول المدة بالدقائق — يحسب من `RentPeriod.id` (نصف ساعة = 30 … خمس ساعات = 300)';
COMMENT ON COLUMN vessel_group_pricing.offer_minutes IS '🎁 العرض — `RentPeriodSub.offer`، بالدقائق';
