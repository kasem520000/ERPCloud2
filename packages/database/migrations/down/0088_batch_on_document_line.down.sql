-- down/0088_batch_on_document_line.down.sql — عكس 0088 حرفياً: يُزيل ما أُضيف ولا يمسّ ما قبله.
--
-- الترتيب: الفهارس أولاً (فلا يبقى فهرسٌ على عمودٍ محذوف)، ثم أعمدة السطور الثلاثة،
-- ثم عمود تاريخ الإنتاج على الدفعة.
--
-- ⚠️ ما يضيع عند التنفيذ: تواريخ الإنتاج على الدفعات، وأرقام الدفعات وتواريخها المكتوبة
-- على السطور. و`lot_id` على السطور **يبقى** — فهو من 0035 لا من 0088 — فالدفعةُ المربوطة
-- بمستندها تبقى مربوطة، والذي يضيع هو النصّ الذي كتبه المُدخِل (وهو قابل للاسترجاع من
-- بطاقة الدفعة نفسها: رقمُها وتاريخُ انتهائها في `item_lots`).

DROP INDEX IF EXISTS item_lots_expiry_idx;
DROP INDEX IF EXISTS stock_transfer_lines_batch_idx;
DROP INDEX IF EXISTS stock_adjustment_lines_batch_idx;
DROP INDEX IF EXISTS stock_voucher_lines_batch_idx;

ALTER TABLE stock_transfer_lines   DROP COLUMN IF EXISTS expiry_date;
ALTER TABLE stock_transfer_lines   DROP COLUMN IF EXISTS production_date;
ALTER TABLE stock_transfer_lines   DROP COLUMN IF EXISTS batch_no;

ALTER TABLE stock_adjustment_lines DROP COLUMN IF EXISTS expiry_date;
ALTER TABLE stock_adjustment_lines DROP COLUMN IF EXISTS production_date;
ALTER TABLE stock_adjustment_lines DROP COLUMN IF EXISTS batch_no;

ALTER TABLE stock_voucher_lines    DROP COLUMN IF EXISTS expiry_date;
ALTER TABLE stock_voucher_lines    DROP COLUMN IF EXISTS production_date;
ALTER TABLE stock_voucher_lines    DROP COLUMN IF EXISTS batch_no;

ALTER TABLE item_lots DROP COLUMN IF EXISTS production_date;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
