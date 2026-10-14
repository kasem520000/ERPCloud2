-- Down for 0055_measurements.sql — 📏 القياسات.
--
-- What is lost: the 📏 خصائص القياسات themselves (اسم الخاصية · ترتيبها · حالتها), and
-- the two columns this migration added to `customer_measurements` (👤 اسم صاحب القياس
-- و📅 التاريخ) — the القياسات themselves stay, because the القياس is the document and
-- the columns are only its labels: every row keeps its `party_id`, its `measurements`
-- jsonb and its ملاحظات, and the grid falls back to «قياس بتاريخ …» exactly as
-- `frmOrderDetails.LoadCustomerMeasurements` L259 does when `MeasurementName` is null.
--
-- What stays: `tailoring_orders` و`tailoring_order_statuses` (0053) — a طلب may point
-- at a قياس and is never deleted with it — و`tailoring_invoices` ومقاساتها (0054)،
-- وكل قياسٍ كُتب قبل هذا الترحيل بمفاتيحه الحرّة (`height` · `shoulder` …).
-- Nothing that existed before this migration is touched.

DROP INDEX IF EXISTS customer_measurements_tenant_date_idx;
ALTER TABLE customer_measurements DROP COLUMN IF EXISTS measurement_date;
ALTER TABLE customer_measurements DROP COLUMN IF EXISTS name;

DROP INDEX IF EXISTS tailoring_measurement_attributes_tenant_idx;
DROP INDEX IF EXISTS tailoring_measurement_attributes_tenant_name_key;
DROP TABLE IF EXISTS tailoring_measurement_attributes;
