-- Down for 0057_marina_bookings.sql — ⛵ المرسى: الحجوزات والمخالفات.
--
-- What is lost: 🔢 أرقام الحجوزات والمخالفات ونوع الحجز و⏱️ المدة (ساعة · دقيقة) و💰
-- القيمة، وكمية الإضافة وسعر وحدتها، و⚠️ نوع المخالفة ومدتها، وضريبة فاتورة التأجير
-- وصافيها.
--
-- What stays: every حجز ومخالفة وفاتورة تأجير قائمة — الصفوف باقية، و`starts_at`/
-- `ends_at` للحجز و`amount` للإضافة و`description` للمخالفة و`total` للفاتورة لم
-- تُمسَّ. والقيم التي أُضيفت تُستعاض عنها: ⏱️ المدة من التاريخين، و💰 القيمة من تسعير
-- الفئة، والضريبة والصافي يُحسبان من الإجمالي.
--
-- Nothing that existed before this migration is touched.

DROP INDEX IF EXISTS marina_violations_tenant_type_idx;
DROP INDEX IF EXISTS marina_violations_tenant_number_key;
ALTER TABLE marina_violations DROP COLUMN IF EXISTS period_days;
ALTER TABLE marina_violations DROP COLUMN IF EXISTS violation_type;
ALTER TABLE marina_violations DROP COLUMN IF EXISTS number;

ALTER TABLE marina_booking_additions DROP COLUMN IF EXISTS unit_price;
ALTER TABLE marina_booking_additions DROP COLUMN IF EXISTS quantity;

ALTER TABLE rental_invoices DROP COLUMN IF EXISTS document_date;
ALTER TABLE rental_invoices DROP COLUMN IF EXISTS net_amount;
ALTER TABLE rental_invoices DROP COLUMN IF EXISTS tax_amount;

DROP INDEX IF EXISTS marina_bookings_tenant_date_idx;
DROP INDEX IF EXISTS marina_bookings_tenant_number_key;
ALTER TABLE marina_bookings DROP COLUMN IF EXISTS rental_amount;
ALTER TABLE marina_bookings DROP COLUMN IF EXISTS period_minutes;
ALTER TABLE marina_bookings DROP COLUMN IF EXISTS period_hours;
ALTER TABLE marina_bookings DROP COLUMN IF EXISTS booking_type;
ALTER TABLE marina_bookings DROP COLUMN IF EXISTS document_date;
ALTER TABLE marina_bookings DROP COLUMN IF EXISTS number;
