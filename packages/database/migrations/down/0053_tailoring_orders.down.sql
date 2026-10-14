-- Down for 0053_tailoring_orders.sql — 🧵 طلب التفصيل.
--
-- What is lost: the orders themselves (رقم الطلب · موعد التسليم · السعر · المدفوع ·
-- الحالة · القماش · التصميم), the خيارات chosen for each order, the أنواع التفصيل and
-- their default prices, the خيارات catalogue, and the order statuses.
--
-- What stays: `customer_measurements` (the قياس half of the tailor's work, migration
-- 0035) and every party the orders pointed at. Nothing that existed before this
-- migration is touched.

DROP INDEX IF EXISTS tailoring_order_options_tenant_key;
DROP TABLE IF EXISTS tailoring_order_options;

DROP INDEX IF EXISTS tailoring_orders_tenant_status_idx;
DROP INDEX IF EXISTS tailoring_orders_tenant_party_idx;
DROP INDEX IF EXISTS tailoring_orders_tenant_date_idx;
DROP INDEX IF EXISTS tailoring_orders_tenant_number_key;
DROP TABLE IF EXISTS tailoring_orders;

DROP INDEX IF EXISTS tailoring_option_values_category_idx;
DROP INDEX IF EXISTS tailoring_option_values_tenant_name_key;
DROP TABLE IF EXISTS tailoring_option_values;

DROP INDEX IF EXISTS tailoring_option_categories_tenant_idx;
DROP INDEX IF EXISTS tailoring_option_categories_tenant_name_key;
DROP TABLE IF EXISTS tailoring_option_categories;

DROP INDEX IF EXISTS tailoring_types_tenant_code_key;
DROP INDEX IF EXISTS tailoring_types_tenant_name_key;
DROP TABLE IF EXISTS tailoring_types;

DROP INDEX IF EXISTS tailoring_order_statuses_tenant_idx;
DROP INDEX IF EXISTS tailoring_order_statuses_tenant_code_key;
DROP TABLE IF EXISTS tailoring_order_statuses;
