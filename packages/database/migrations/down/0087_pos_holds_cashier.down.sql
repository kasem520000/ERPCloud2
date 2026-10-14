-- down/0087_pos_holds_cashier.down.sql — عكس 0087 حرفياً: يُزيل ما أُضيف ولا يمسّ ما قبله.
--
-- والترتيب مقصود: `pos_holds` أولاً (جدولٌ كامل)، ثم فهرس الكاشير، ثم قيد المفتاح الأجنبي،
-- ثم العمود نفسه — فلا يبقى فهرسٌ على عمودٍ محذوف ولا قيدٌ بلا أب.

DROP TABLE IF EXISTS pos_holds;

DROP INDEX IF EXISTS pos_holds_scope_idx;
DROP INDEX IF EXISTS pos_holds_slot_key;

DROP INDEX IF EXISTS sales_invoices_cashier_idx;
ALTER TABLE sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_cashier_id_fkey;
ALTER TABLE sales_invoices DROP COLUMN IF EXISTS cashier_id;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
