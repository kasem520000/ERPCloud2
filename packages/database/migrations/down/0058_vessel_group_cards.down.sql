-- Down for 0058_vessel_group_cards.sql — ⛵ المرسى: 📋 بطاقة الفئة و⏰ فترات التأجير.
--
-- What is lost: 🔢 رقم الفئة واسم الفئة (EN) وقيمة الساعة وقيمة النصف ساعة وعرضيهما
-- بالدقائق و🖼️ صورة الفئة، و⏰ المدة و🎁 العرض من كل صف تسعير.
--
-- What stays: every فئة وكل صف تسعير — `vessel_groups.name` و`code` و`vessel_group_pricing.price`
-- لم تُمسَّ، فتظلّ الفئة تُسمّى ويظلّ سعر الساعة ونصف الساعة يُقرأ من `period_kind`
-- ('hour' · 'half_hour') كما كان قبل هذا الترحيل. و🔢 الرقم يُستعاض عنه بترتيب الإنشاء
-- عند العرض، فتبقى ⏮/◀/▶/⏭ تمشي.
--
-- Nothing that existed before this migration is touched.

-- ⏰ المدة تعود أربعاً: القيد إلى ما كان عليه في `0018`.
DELETE FROM vessel_group_pricing WHERE period_kind ~ '^period_[0-9]+$';
ALTER TABLE vessel_group_pricing DROP CONSTRAINT IF EXISTS vessel_group_pricing_period_kind_check;
ALTER TABLE vessel_group_pricing ADD CONSTRAINT vessel_group_pricing_period_kind_check
  CHECK (period_kind IN ('hour', 'half_hour', 'offer', 'day'));

DROP INDEX IF EXISTS vessel_group_pricing_period_key;
ALTER TABLE vessel_group_pricing DROP COLUMN IF EXISTS offer_minutes;
ALTER TABLE vessel_group_pricing DROP COLUMN IF EXISTS minutes;
ALTER TABLE vessel_group_pricing DROP COLUMN IF EXISTS period_id;

DROP INDEX IF EXISTS vessel_groups_tenant_number_key;
ALTER TABLE vessel_groups DROP COLUMN IF EXISTS image_url;
ALTER TABLE vessel_groups DROP COLUMN IF EXISTS half_hour_offer_minutes;
ALTER TABLE vessel_groups DROP COLUMN IF EXISTS half_hour_price;
ALTER TABLE vessel_groups DROP COLUMN IF EXISTS hour_offer_minutes;
ALTER TABLE vessel_groups DROP COLUMN IF EXISTS hour_price;
ALTER TABLE vessel_groups DROP COLUMN IF EXISTS name_en;
ALTER TABLE vessel_groups DROP COLUMN IF EXISTS number;
