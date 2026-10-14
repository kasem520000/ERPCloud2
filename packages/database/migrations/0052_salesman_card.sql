-- Phase 09 part one — 🧑‍💼 المندوبون والعمولات.
--
-- `Form_WPF/frmSalesMen.xaml` («شاشة المندوبين») is a two-tab card:
--
--   • «🧑‍💼 بيانات المندوبين» — `🧑‍💼 اسم المندوب:` · `عمولة المبيعات:` ·
--     `عمولة التحصيل:` · `عمولة الربح:` · `الهاتف` · `الجوال` ·
--     `البريد الإلكتروني` · `ملاحظات`, and the button
--     `📋 طباعة فواتير مندوب وعمولاتهم` which opens `frmInvBySalesMen`.
--   • «🔍 البحث» — `اسم المندوب` · «🔍 بحث», then
--     «📋 قائمة المندوبين» with the columns
--     `الرقم · 🧑‍💼 اسم المندوب · عمولة المبيعات · 📧 البريد الإلكتروني ·
--      📞 الهاتف · 📱 الجوال`.
--
-- `frmSalesMen.xaml.cs` is where the rules are:
--
--   • `btnSave_Click` L155 — one INSERT/UPDATE over
--     `salesmen(name, comm, tel, mobile, email, notes, IS_Deleted, Profit_Comm,
--     Colle_Comm)`, then «تم حفظ المندوب بنجاح.» / «تم تحديث بيانات المندوب.»
--   • `btnDelete_Click` L215 — «اختر مندوباً ليتم حذفه.» when nothing is selected,
--     otherwise `UPDATE salesmen SET IS_Deleted=1`.
--   • `LoadDG` L63 / `Search` L128 — `WHERE name LIKE N'%…%' AND IS_Deleted=0`.
--   • `Button1_Click` L272 — opens `frmInvBySalesMen`, the commissions report.
--
-- `Form_WPF/frmInvBySalesMen.xaml` («مبيعات مندوب خلال فترة») is the reader of those
-- three percentages. `ProcessInvoiceRow` L295 and `LoadReceiptsByType` L444 both do
-- `SELECT comm, name, Profit_Comm, Colle_Comm FROM salesmen WHERE id=…`, and the
-- arithmetic is at L322–L338:
--
--   sales commission      = comm        % × netForComm          (always)
--   collection commission = Colle_Comm  % × netForComm          (only when pay_type is set)
--   profit commission     = Profit_Comm % × (netForComm − cost) (only when the profit is +)
--
-- The cloud's `salesmen` was a name and a flag — nothing to compute a commission with,
-- so «كم يستحق هذا المندوب؟» had no answer at all even though every فاتورة carries a
-- `salesman_id`. These six columns are the desktop's card; nothing here renames or
-- removes a column that the API already answers with.
--
-- `employee_id` is the one column the desktop has no counterpart for, and it exists
-- because the cloud split the desktop's single `salesmen` table in two: a فاتورة names
-- a `salesmen` row (`sales_invoices.salesman_id`) while a سند قبض names an `employees`
-- row (`vouchers.salesman_id`, migration 0025). The desktop joins both to `salesmen`
-- by id. Linking the two cards is what lets one مندوب own both his invoices and his
-- receipts — the report reads through the link in both directions.

ALTER TABLE salesmen
  ADD COLUMN IF NOT EXISTS commission_rate numeric(9, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS collection_commission_rate numeric(9, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS profit_commission_rate numeric(9, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES employees (id) ON DELETE set null,
  ADD COLUMN IF NOT EXISTS tel text,
  ADD COLUMN IF NOT EXISTS mobile text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS notes text;

-- One مندوب card per employee card — the link is what joins invoices to receipts.
CREATE UNIQUE INDEX IF NOT EXISTS salesmen_tenant_employee_key
  ON salesmen (tenant_id, employee_id)
  WHERE employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS salesmen_tenant_active_idx
  ON salesmen (tenant_id, name)
  WHERE active;

COMMENT ON COLUMN salesmen.commission_rate IS
  'عمولة المبيعات — `salesmen.comm`; `frmInvBySalesMen.xaml.cs` L330: salesComm = comm% × netForComm';
COMMENT ON COLUMN salesmen.collection_commission_rate IS
  'عمولة التحصيل — `salesmen.Colle_Comm`; L336/L453: only when the invoice has a pay_type (the cloud: when it has payments)';
COMMENT ON COLUMN salesmen.profit_commission_rate IS
  'عمولة الربح — `salesmen.Profit_Comm`; L341: profitComm = Profit_Comm% × (netForComm − AvrgCost), and only when that base is positive';
COMMENT ON COLUMN salesmen.employee_id IS
  'بطاقة الموظف — cloud-only bridge: `sales_invoices.salesman_id` names this card, `vouchers.salesman_id` names the employee card; the commissions report reads both';
COMMENT ON COLUMN salesmen.tel IS
  '📞 الهاتف — `frmSalesMen.xaml` «الهاتف»';
COMMENT ON COLUMN salesmen.mobile IS
  '📱 الجوال — `frmSalesMen.xaml` «الجوال»';
COMMENT ON COLUMN salesmen.email IS
  '📧 البريد الإلكتروني — `frmSalesMen.xaml` «البريد الإلكتروني»';
COMMENT ON COLUMN salesmen.notes IS
  'ملاحظات — `frmSalesMen.xaml` «ملاحظات»';
