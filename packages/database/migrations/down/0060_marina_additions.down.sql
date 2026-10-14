-- Down for 0060_marina_additions.sql — ⛵ المرسى: ➕ الإضافات.
--
-- What is lost: تعريف كل إضافة — 🔢 الرقم و📝 الاسم و💰 القيمة (`marina_additions`)،
-- والرابط بين صفّ «🎁 الإضافات» وتعريفه (`marina_booking_additions.addition_id`).
--
-- What stays: every صفّ إضافة على حجز قائم — `description` · `quantity` · `unit_price` ·
-- `amount` مكتوبةٌ بنصّها في `marina_booking_additions`، فالاسم والسعر والكمية التي
-- حُسبت في «الإجمالي» باقية، وفواتير التأجير (`rental_invoices.additions_amount`) لم
-- تُمسَّ. وحين يُعاد الترحيل تُعرَّف الإضافات من جديد، وتبقى الحجوزات القديمة كما كانت.
--
-- Nothing that existed before this migration is touched.

ALTER TABLE marina_booking_additions DROP COLUMN IF EXISTS addition_id;
DROP INDEX IF EXISTS marina_booking_additions_addition_idx;

DROP TABLE IF EXISTS marina_additions;
