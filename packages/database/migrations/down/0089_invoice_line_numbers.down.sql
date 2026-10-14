-- down/0089_invoice_line_numbers.down.sql — عكس 0089 حرفياً: يُزيل ما أُضيف ولا يمسّ ما قبله.
--
-- الترتيب: الفهارس أولاً (فلا يبقى فهرسٌ على عمودٍ محذوف)، ثم أعمدة سطور الشراء، ثم أعمدة
-- سطور البيع.
--
-- ⚠️ ما يضيع عند التنفيذ: الأرقام التسلسلية وأرقام الدفعات وتواريخها المكتوبة على سطور
-- الفواتير (وهي قابلة للاسترجاع من `stock_document_serials` و`item_lots` لما رُحّل فعلاً —
-- فالرابط المحسوم في الجدول الآخر لا يُمسّ). ما **لا** يضيع: حركات المخزون ولا القيود ولا
-- حالة الأرقام في `item_serials`، فالتتبّع المحسوم يبقى قائماً بلا هذه الأعمدة.

DROP INDEX IF EXISTS sales_invoice_lines_serial_idx;
DROP INDEX IF EXISTS purchase_invoice_lines_serial_idx;
DROP INDEX IF EXISTS purchase_invoice_lines_batch_idx;
DROP INDEX IF EXISTS sales_invoice_lines_batch_idx;

ALTER TABLE purchase_invoice_lines DROP COLUMN IF EXISTS expiry_date;
ALTER TABLE purchase_invoice_lines DROP COLUMN IF EXISTS production_date;
ALTER TABLE purchase_invoice_lines DROP COLUMN IF EXISTS batch_no;
ALTER TABLE purchase_invoice_lines DROP COLUMN IF EXISTS lot_id;
ALTER TABLE purchase_invoice_lines DROP COLUMN IF EXISTS serial_nos;

ALTER TABLE sales_invoice_lines DROP COLUMN IF EXISTS expiry_date;
ALTER TABLE sales_invoice_lines DROP COLUMN IF EXISTS production_date;
ALTER TABLE sales_invoice_lines DROP COLUMN IF EXISTS batch_no;
ALTER TABLE sales_invoice_lines DROP COLUMN IF EXISTS lot_id;
ALTER TABLE sales_invoice_lines DROP COLUMN IF EXISTS serial_nos;
