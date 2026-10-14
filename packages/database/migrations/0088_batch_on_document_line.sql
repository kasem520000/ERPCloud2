-- 0088_batch_on_document_line.sql — R5 «نصف الدفعة على سطر المستند»
-- (`docs/desktop-parity/PHASE_05_INVENTORY.md` §R5، والمؤجَّل المُسمّى في §13).
--
-- الديسكتوب يكتب على **كل سطر مستند** ثلاثةً إلى جانب الرقم التسلسلي:
--   `INSERT into InvoiceItemDetail(…, ItemSerialNo, BatchNo, ItemProductionDate,
--    ItemExpireDate, …)` — `Class/InvoiceOper.cs` L1635؛ ويقرأها عائدةً عند فتح
--   المستند (L3886–L3888: `BatchNo`, `ItemProductionDate`, `ItemExpireDate`).
-- والسحابة كان عندها نصفُها الأول: `lot_id` على السطر و`serial_nos` (§12). وهذا الترحيل
-- يضيف نصفها الثاني، مع تصحيحٍ صغير في جدول الدفعات نفسه:
--
--   1. **`item_lots.production_date`** — تاريخ الإنتاج عمودٌ مستقلّ عن `received_at`
--      (الاستلام). شاشة الدفعات كانت تكتب الاستلام في حقلٍ عنوانه «📅 تاريخ الإنتاج»،
--      وهما تاريخان مختلفان: البضاعة تُنتَج في يومٍ وتُستلم في يوم.
--
--   2. **`batch_no` · `production_date` · `expiry_date`** على سطور المستندات المخزنية
--      الثلاثة (`stock_voucher_lines` · `stock_adjustment_lines` · `stock_transfer_lines`):
--      ما كتبه المُدخِل كما هو على العبوة، محفوظاً ولو لم تكن الدفعة مسجَّلةً بعد —
--      فالسطر الذي يذكر دفعةً جديدة **يُنشئها** ويحفظ تاريخيها (`resolveUploadedLots`)،
--      كما يفعل كاتبُ الديسكتوب حين يكتب تاريخ الانتهاء على السطر أول مرة
--      (`InvoiceOper.cs` L1586–L1590).
--
-- ولا شيء يُحذف ولا يُضيّق: كل العمليات `IF NOT EXISTS` والأعمدةُ الجديدة `NULL`-able،
-- فالمستندات القائمة تبقى كما هي وبلا دفعة.
--
-- آمن للإعادة التشغيل.

-- =============================================================================
-- 1. تاريخ الإنتاج على الدفعة
-- =============================================================================

ALTER TABLE item_lots ADD COLUMN IF NOT EXISTS production_date date;

-- من كان قد كتب الاستلام في خانة «تاريخ الإنتاج» له صفٌّ قائم: يُنسخ إلى العمود الجديد
-- **مرّة واحدة** (و`received_at` يبقى مكانه)، فلا تُقرأ شاشةُ الدفعات فجأةً بلا تاريخ.
-- الشرط `production_date IS NULL` يمنع الكتابة الثانية عليه بعد أن يُضبط يدوياً.
UPDATE item_lots
   SET production_date = (received_at AT TIME ZONE 'UTC')::date
 WHERE production_date IS NULL
   AND received_at IS NOT NULL;

-- =============================================================================
-- 2. الدفعة وتواريخها على سطور المستندات
-- =============================================================================

ALTER TABLE stock_voucher_lines    ADD COLUMN IF NOT EXISTS batch_no text;
ALTER TABLE stock_voucher_lines    ADD COLUMN IF NOT EXISTS production_date date;
ALTER TABLE stock_voucher_lines    ADD COLUMN IF NOT EXISTS expiry_date date;

ALTER TABLE stock_adjustment_lines ADD COLUMN IF NOT EXISTS batch_no text;
ALTER TABLE stock_adjustment_lines ADD COLUMN IF NOT EXISTS production_date date;
ALTER TABLE stock_adjustment_lines ADD COLUMN IF NOT EXISTS expiry_date date;

ALTER TABLE stock_transfer_lines   ADD COLUMN IF NOT EXISTS batch_no text;
ALTER TABLE stock_transfer_lines   ADD COLUMN IF NOT EXISTS production_date date;
ALTER TABLE stock_transfer_lines   ADD COLUMN IF NOT EXISTS expiry_date date;

-- الدفعة على السطر تُبحث بالرقم: فهرسٌ على (المستأجر، الصنف، الرقم) في الجداول الثلاثة
-- يجعل «دفعةٌ بهذا الرقم لهذا الصنف» استعلامَ فهرسٍ لا مسحَ سطور.
CREATE INDEX IF NOT EXISTS stock_voucher_lines_batch_idx
  ON stock_voucher_lines (tenant_id, item_id, batch_no) WHERE batch_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_adjustment_lines_batch_idx
  ON stock_adjustment_lines (tenant_id, item_id, batch_no) WHERE batch_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_transfer_lines_batch_idx
  ON stock_transfer_lines (tenant_id, item_id, batch_no) WHERE batch_no IS NOT NULL;

-- الدفعات المتقاربة في الانتهاء تُقرأ بالتقرير: فهرسُ الصلاحية على الدفعة نفسها.
CREATE INDEX IF NOT EXISTS item_lots_expiry_idx
  ON item_lots (tenant_id, expiry_date) WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'item_lots' AND column_name = 'production_date'
  ) THEN
    RAISE EXCEPTION '0088: item_lots.production_date was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'stock_voucher_lines' AND column_name = 'batch_no'
  ) THEN
    RAISE EXCEPTION '0088: stock_voucher_lines.batch_no was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'stock_transfer_lines' AND column_name = 'expiry_date'
  ) THEN
    RAISE EXCEPTION '0088: stock_transfer_lines.expiry_date was not created';
  END IF;
END $$;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
