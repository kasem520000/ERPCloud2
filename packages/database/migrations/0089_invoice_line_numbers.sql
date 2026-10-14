-- 0089_invoice_line_numbers.sql — R8 «الأرقام التسلسلية والدفعات على سطور فواتير البيع والشراء»
-- (`docs/desktop-parity/PHASE_05_INVENTORY.md` §13، والمؤجَّل المُسمّى في §R2.5 البند 6 و§R3.5 البند 4).
--
-- الديسكتوب يكتب الأرقام الأربعة على **سطر الفاتورة** نفسها، لا على سطور المستندات المخزنية
-- وحدها: `INSERT into InvoiceItemDetail(…, ItemSerialNo, BatchNo, ItemProductionDate,
-- ItemExpireDate, …)` — `Class/InvoiceOper.cs` L1635؛ ويقرأها عائدةً عند فتح المستند (L3885)،
--ونافذة البيع تبحث بالرقم التسلسلي في الرأس («🔢 التسلسلي:» — `frmInvSale.xaml` L592 ←
-- `SearchBySerialNo` L722) وتعرض الأرقام في نافذةٍ مستقلّة (`frmItemSerialNo`) من قائمة السياق
-- («🔢 الرقم التسلسلي» L679).
--
-- والسحابة كان عندها النصف الأول على **المستندات المخزنية** (§12 للأرقام التسلسلية و§R5 للدفعة
-- وتواريخها، الترحيل 0039 و0088)، وفواتير البيع والشراء تكتب سطورها بلا أرقام. هذا الترحيل
-- يسدّ النصف الثاني: نفس الأعمدة الخمسة على جدولَي سطور الفواتير، فالسطر يحفظ ما على العبوة
-- ولو كانت الدفعة غير مسجَّلة، والترحيل هو الذي يربط الأرقام بـ`item_serials` و`item_lots`.
--
-- ولا شيء يُحذف ولا يُضيّق: كل العمليات `IF NOT EXISTS`، والأعمدة الجديدة `NULL`-able عدا
-- `serial_nos` الذي يُولد بمصفوفةٍ فارغة — فالفواتير القائمة تبقى كما هي وبلا أرقام.
--
-- آمن للإعادة التشغيل.

-- =============================================================================
-- 1. الأعمدة الخمسة على سطور فاتورة البيع
-- =============================================================================

ALTER TABLE sales_invoice_lines ADD COLUMN IF NOT EXISTS serial_nos jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE sales_invoice_lines ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES item_lots (id) ON DELETE SET NULL;
ALTER TABLE sales_invoice_lines ADD COLUMN IF NOT EXISTS batch_no text;
ALTER TABLE sales_invoice_lines ADD COLUMN IF NOT EXISTS production_date date;
ALTER TABLE sales_invoice_lines ADD COLUMN IF NOT EXISTS expiry_date date;

COMMENT ON COLUMN sales_invoice_lines.serial_nos IS
  '🔢 الأرقام التسلسلية as typed on the line — InvoiceItemDetail.ItemSerialNo (InvoiceOper.cs L1635); resolved into stock_document_serials when the invoice posts';
COMMENT ON COLUMN sales_invoice_lines.batch_no IS
  '📁 رقم الدفعة as written on the packaging; the lot is found or created at posting time';
COMMENT ON COLUMN sales_invoice_lines.production_date IS
  '📅 تاريخ الإنتاج printed on the packaging (its own date, not the receipt date)';
COMMENT ON COLUMN sales_invoice_lines.expiry_date IS
  '⏳ تاريخ الانتهاء printed on the packaging';

-- =============================================================================
-- 2. الأعمدة نفسها على سطور فاتورة الشراء (والمرتجع منهما في الجدولين أنفسهما)
-- =============================================================================

ALTER TABLE purchase_invoice_lines ADD COLUMN IF NOT EXISTS serial_nos jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE purchase_invoice_lines ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES item_lots (id) ON DELETE SET NULL;
ALTER TABLE purchase_invoice_lines ADD COLUMN IF NOT EXISTS batch_no text;
ALTER TABLE purchase_invoice_lines ADD COLUMN IF NOT EXISTS production_date date;
ALTER TABLE purchase_invoice_lines ADD COLUMN IF NOT EXISTS expiry_date date;

COMMENT ON COLUMN purchase_invoice_lines.serial_nos IS
  '🔢 الأرقام التسلسلية as typed on the line — a receipt creates them, a return takes them out';
COMMENT ON COLUMN purchase_invoice_lines.batch_no IS
  '📁 رقم الدفعة on a purchase line: what the supplier''s packaging says; the lot is found or created at posting time';
COMMENT ON COLUMN purchase_invoice_lines.production_date IS
  '📅 تاريخ الإنتاج on the supplier''s packaging';
COMMENT ON COLUMN purchase_invoice_lines.expiry_date IS
  '⏳ تاريخ الانتهاء on the supplier''s packaging';

-- =============================================================================
-- 3. الفهارس — «دفعةٌ بهذا الرقم لهذا الصنف» استعلامُ فهرس لا مسحَ سطور
-- =============================================================================

CREATE INDEX IF NOT EXISTS sales_invoice_lines_batch_idx
  ON sales_invoice_lines (tenant_id, item_id, batch_no) WHERE batch_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_invoice_lines_batch_idx
  ON purchase_invoice_lines (tenant_id, item_id, batch_no) WHERE batch_no IS NOT NULL;

-- «أين فاتورة هذا الرقم التسلسلي؟» — الرابط المحسوم في `stock_document_serials` هو مصدر
-- الحقيقة عند الترحيل، وهذان الفهرسَان يجعلان البحث المطبوخ على السطر (قبل الترحيل) ممكناً.
CREATE INDEX IF NOT EXISTS sales_invoice_lines_serial_idx
  ON sales_invoice_lines USING gin (serial_nos jsonb_path_ops);
CREATE INDEX IF NOT EXISTS purchase_invoice_lines_serial_idx
  ON purchase_invoice_lines USING gin (serial_nos jsonb_path_ops);

-- =============================================================================
-- 4. RLS — الجدولان يرثان سياسة الجدول الأب (`sales_invoices`/`purchase_invoices`)
--    وهما مفروضان أصلاً؛ ولا يُضاف هنا شيء لأن الجدولين لم يُنشآ في هذا الترحيل.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'sales_invoice_lines' AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'sales_invoice_lines must keep RLS enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'purchase_invoice_lines' AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'purchase_invoice_lines must keep RLS enabled';
  END IF;
END $$;
