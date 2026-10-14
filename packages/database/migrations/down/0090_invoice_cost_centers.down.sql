-- down/0090_invoice_cost_centers.down.sql — عكس 0090 حرفياً: يُزيل ما أُضيف ولا يمسّ ما قبله.
--
-- الترتيب: الفهارس أولاً (فلا يبقى فهرسٌ على عمودٍ محذوف)، ثم الأعمدة.
--
-- ⚠️ ملاحظتان مقصودتان:
-- 1. **`purchase_invoice_lines.cost_center_id` لا يُحذف**: العمود كان قائماً قبل 0090 (أُضيف
--    مع مصاريف الشراء في مرحلةٍ سابقة)، و`ADD COLUMN IF NOT EXISTS` في الصعود كان دفاعاً
--    لا إنشاءً. فالتراجع يُزيل ما أضافه هذا الترحيل وحده.
-- 2. **ما يضيع**: مركز التكلفة المكتوب على رؤوس الفاتورتين وعلى سطور فاتورة البيع.
--    **وما لا يضيع**: مركز التكلفة على سطور القيود (`journal_entry_lines.cost_center_id`) —
--    فكل قيدٍ رُحّل بمركزٍ يبقى موسوماً به، وكشف مركز الكلفة يستمر في قراءة ما رُحّل.
--    وإسقاط الأعمدة لا يُعيد تصنيف المال: القيد جزءٌ من الدفتر ولا يُعاد بناؤه من الفاتورة.

DROP INDEX IF EXISTS purchase_invoice_lines_cost_center_idx;
DROP INDEX IF EXISTS purchase_invoices_cost_center_idx;
DROP INDEX IF EXISTS sales_invoice_lines_cost_center_idx;
DROP INDEX IF EXISTS sales_invoices_cost_center_idx;

ALTER TABLE purchase_invoices DROP COLUMN IF EXISTS cost_center_id;
ALTER TABLE sales_invoice_lines DROP COLUMN IF EXISTS cost_center_id;
ALTER TABLE sales_invoices DROP COLUMN IF EXISTS cost_center_id;
