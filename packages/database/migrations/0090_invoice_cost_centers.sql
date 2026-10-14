-- 0090_invoice_cost_centers.sql — R9 «📊 مركز التكلفة على فاتورة البيع والشراء»
-- (المؤجَّل المُسمّى في `docs/desktop-parity/PHASE_02_SALES_ENGINE.md` §R2.5 البند 6
-- و`PHASE_03_PURCHASE_ENGINE.md` §R3.5 البند 4).
--
-- الديسكتوب يحمل مركز التكلفة مرّتين: **على رأس الفاتورة** (قائمة «📊 مركز التكلفة:» —
-- `frmInvSale.xaml` L530 و`frmInvPurch.xaml` L467، والقيمة تُحفظ في `Invoices.CCcode` ←
-- `Invoic.InvCCcode`) و**على السطر** (`Inv_Sub.ItemCostCenter`، يُكتب في
-- `Class/InvoiceOper.cs` L1635 ويُقرأ عائداً L3885). وعند بناء القيد يُوسم به حساب البند
-- (الخطة`: account.CCcode = invoiceItem.ItemCostCenter` — L2432) أو حساب الفاتورة إذا لم
-- يكن للسطر مركز (L2461: `account.CCcode = inv.InvCCcode`).
--
-- والسحابة كان عندها نصف البنية: `journal_entry_lines.cost_center_id` موجود منذ المرحلة
-- المالية ووسمه `reverseJournal` يحمله عند العكس (ترحيل `0047`)، و
-- `purchase_invoice_lines.cost_center_id` موجود أيضاً — لكن **فاتورة البيع لا تحمل مركزاً
-- ولا رأس الفاتورة من الوجهين**، فلا يصل مركز التكلفة إلى قيد فاتورة أصلاً، وكشف مركز
-- الكلفة (`frmCostCenterBalance`) لا يرى مبيعاتٍ ولا مشتريات.
--
-- هذا الترحيل يضيف العمود حيث ينقص: رأس فاتورة البيع، ورأس فاتورة الشراء، وسطر فاتورة
-- البيع (وسطر الشراء قائمٌ). والقيمة `NULL` تعني «بلا مركز» — وهو الافتراضي في الديسكتوب
-- أيضاً (`-1`).
--
-- ولا شيء يُحذف ولا يُضيّق: كل العمليات `IF NOT EXISTS`، والعمود `NULL`-able.
-- آمن للإعادة التشغيل.

-- =============================================================================
-- 1. مركز التكلفة على رأس فاتورة البيع وسطرها
-- =============================================================================

ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES cost_centers (id) ON DELETE SET NULL;
ALTER TABLE sales_invoice_lines ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES cost_centers (id) ON DELETE SET NULL;

-- =============================================================================
-- 2. مركز التكلفة على رأس فاتورة الشراء (وسطرها قائمٌ من قبل)
-- =============================================================================

ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES cost_centers (id) ON DELETE SET NULL;
-- دفاعٌ: لو مرّت بيئةٌ بلا عمود السطر (بذرةٌ قديمة) يُضاف هنا بدل أن يسقط الاستعلام لاحقاً.
ALTER TABLE purchase_invoice_lines ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES cost_centers (id) ON DELETE SET NULL;

-- =============================================================================
-- 3. الفهارس — كل كشف مركز كلفة يقرأ بالمركز، وكل استعلامٍ نطاقه المستأجر
-- =============================================================================

CREATE INDEX IF NOT EXISTS sales_invoices_cost_center_idx
  ON sales_invoices (tenant_id, cost_center_id) WHERE cost_center_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_invoice_lines_cost_center_idx
  ON sales_invoice_lines (tenant_id, cost_center_id) WHERE cost_center_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_invoices_cost_center_idx
  ON purchase_invoices (tenant_id, cost_center_id) WHERE cost_center_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_invoice_lines_cost_center_idx
  ON purchase_invoice_lines (tenant_id, cost_center_id) WHERE cost_center_id IS NOT NULL;

COMMENT ON COLUMN sales_invoices.cost_center_id IS
  'مركز التكلفة الافتراضي للفاتورة كلها — `Invoices.CCcode` في الديسكتوب (frmInvSale.xaml L530).';
COMMENT ON COLUMN sales_invoice_lines.cost_center_id IS
  'مركز تكلفة السطر — `Inv_Sub.ItemCostCenter` (InvoiceOper.cs L1635)؛ يسبق مركز الرأس عند وسم القيد (L2432 ثم L2461).';
COMMENT ON COLUMN purchase_invoices.cost_center_id IS
  'مركز التكلفة الافتراضي للفاتورة كلها — `frmInvPurch.xaml` L467.';
