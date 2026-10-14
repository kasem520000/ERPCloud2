-- Down for 0054_tailoring_invoices.sql — 🧾 فاتورة التفصيل.
--
-- What is lost: the invoices themselves (رقم الفاتورة · الجوال · السعر · الإجمالي ·
-- المدفوع · الحالة · نوع الثوب · المقاسات), the payments recorded against them, and the
-- 👔 أنواع الثوب الأربعة.
--
-- What stays: `tailoring_orders` و`tailoring_order_statuses` من الجزء الثاني (migration
-- 0053) — فاتورة التفصيل تشير إلى الحالات ولا تملكها — وكل سند قبض رُبطت به دفعة: السند
-- وثيقة خزينة، وحذف الفاتورة لا يحذفه (`ON DELETE set null`). Nothing that existed
-- before this migration is touched.

DROP INDEX IF EXISTS tailoring_invoice_payments_invoice_idx;
DROP TABLE IF EXISTS tailoring_invoice_payments;

DROP INDEX IF EXISTS tailoring_invoices_tenant_status_idx;
DROP INDEX IF EXISTS tailoring_invoices_tenant_name_idx;
DROP INDEX IF EXISTS tailoring_invoices_tenant_party_idx;
DROP INDEX IF EXISTS tailoring_invoices_tenant_date_idx;
DROP INDEX IF EXISTS tailoring_invoices_tenant_number_key;
DROP TABLE IF EXISTS tailoring_invoices;

DROP INDEX IF EXISTS tailoring_garment_types_tenant_idx;
DROP INDEX IF EXISTS tailoring_garment_types_tenant_code_key;
DROP TABLE IF EXISTS tailoring_garment_types;
