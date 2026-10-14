-- Phase 08 part three — 💵 دفع الرواتب (`Form_WPF/frmSalaryPay.xaml`).
--
-- `frmSalaryPay.xaml` («دفع الرواتب») is one إذن صرف per employee per month over a
-- search grid, in two tabs:
--
--   • «💰 دفع الرواتب» — `رقم الإذن` · `اسم الموظف المسؤول` · `تاريخ الإدخال` ·
--     `الفرع` · `الشهر` · `السنة` · `الموظف` · `طريقة الدفع` (نقدي | تحويل بنكي) ·
--     `يصرف من حساب` · `الصندوق/البنك` · `الراتب الأساسي` · `بدل سكن` ·
--     `بدل مواصلات` · `💰 الحوافز` · `🔴 الخصومات` · `💵 الصافي` · `ملاحظات`
--   • «🔍 البحث» — `رقم الإذن` · `الموظف` · `من تاريخ` · `إلى تاريخ` · `كل الفترة` ·
--     «🔍 بحث»، ثم «📋 نتائج البحث عن سندات الرواتب» بأعمدة
--     `رقم الإذن · 👤 الموظف · 💰 المبلغ · الشهر · السنة · 📅 التاريخ · المستخدم`
--
-- `frmSalaryPay.xaml.cs` is where the rules are:
--
--   • `LoadNxtNo` L120 — «رقم الإذن» is `SELECT MAX(id) FROM SalaryPay` + 1.
--   • `btnSave_Click` L421 — three refusals before anything is written:
--     «يجب اختيار الفرع.» · «يجب اختيار الموظف.» · «يجب اختيار الصندوق.»
--   • `btnSave_Click` L470 — **«لقد تم دفع راتب الموظف سابقاً.»** — one document per
--     employee per month: `WHERE IS_Deleted=0 AND year=… AND month=… AND emp=…`.
--   • `btnSave_Click` L486 — «لم يتم العثور على الحساب المقابل للصندوق.» — the صندوق
--     must resolve to an account before money leaves the till.
--   • `CalcEmpSalary` L276 — «📊 عرض الراتب» reads the month's مسيّر
--     (`Salary_Res` ⋈ `Salary_Res_Details`) and refuses with
--     **«لا يوجد رواتب مستحقة للموظف.»** when the employee has nothing due.
--   • `RecalcNet` L340 — `الصافي = الراتب الأساسي + الحوافز + بدل سكن + بدل مواصلات
--     − الخصومات`.
--   • `btnDelete_Click` L568 — «اختر سنداً ليتم حذفه.» then `IS_Deleted = 1`.
--
-- The cloud could pay a whole month at once (`POST /hrm/payroll/runs/:id/pay`, one
-- voucher for the whole run) but had no إذن صرف: no number, no method, no صندوق, no
-- responsible employee, no notes, no duplicate guard, and no way to look one up. This
-- table is that document — one row per employee per month, the way `SalaryPay` is.
--
-- `الشهر` and `السنة` are two combo boxes in the desktop and one `YYYY-MM` key here: a
-- payroll run is keyed by `year_month`, the duplicate guard rides the same key, and the
-- API answers with `month` and `year` split apart so the screen can show both.
--
-- The seven allowances on the employee card are shown as `الراتب الأساسي` · `بدل سكن` ·
-- `بدل مواصلات` — the three the window has boxes for — plus `other_allowances` carrying
-- the rest, so `الصافي` on the إذن is exactly the `net` of the month's مسيّر line.

CREATE TABLE IF NOT EXISTS salary_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE cascade,
  number text NOT NULL,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE restrict,
  branch_id uuid REFERENCES branches (id) ON DELETE set null,
  run_id uuid REFERENCES payroll_runs (id) ON DELETE set null,
  year_month text NOT NULL,
  payment_date date NOT NULL,
  method text NOT NULL,
  cash_location_id uuid REFERENCES cash_locations (id) ON DELETE restrict,
  responsible_employee_id uuid REFERENCES employees (id) ON DELETE set null,
  components jsonb NOT NULL DEFAULT '{}'::jsonb,
  basic numeric(20, 4) NOT NULL DEFAULT 0,
  housing numeric(20, 4) NOT NULL DEFAULT 0,
  transport numeric(20, 4) NOT NULL DEFAULT 0,
  other_allowances numeric(20, 4) NOT NULL DEFAULT 0,
  additions numeric(20, 4) NOT NULL DEFAULT 0,
  deductions numeric(20, 4) NOT NULL DEFAULT 0,
  net numeric(20, 4) NOT NULL DEFAULT 0,
  notes text,
  voucher_id uuid REFERENCES vouchers (id) ON DELETE set null,
  journal_entry_id uuid REFERENCES journal_entries (id) ON DELETE set null,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid
);

-- «رقم الإذن» — one number per tenant, gaps allowed, deleted numbers free again.
CREATE UNIQUE INDEX IF NOT EXISTS salary_payments_tenant_number_key
  ON salary_payments (tenant_id, number)
  WHERE deleted_at IS NULL;

-- «لقد تم دفع راتب الموظف سابقاً.» — `btnSave_Click` L470, one إذن per employee per month.
CREATE UNIQUE INDEX IF NOT EXISTS salary_payments_employee_month_key
  ON salary_payments (tenant_id, employee_id, year_month)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS salary_payments_tenant_date_idx
  ON salary_payments (tenant_id, payment_date);

CREATE INDEX IF NOT EXISTS salary_payments_tenant_employee_idx
  ON salary_payments (tenant_id, employee_id);

COMMENT ON COLUMN salary_payments.number IS
  'رقم الإذن — `frmSalaryPay.xaml.cs` L120 LoadNxtNo: SELECT MAX(id) FROM SalaryPay + 1';
COMMENT ON COLUMN salary_payments.year_month IS
  'الشهر والسنة — two combo boxes in `frmSalaryPay.xaml`, one `YYYY-MM` key here (a payroll run is keyed the same way)';
COMMENT ON COLUMN salary_payments.method IS
  'طريقة الدفع — `rdCash` «نقدي» | `rdBank` «تحويل بنكي»: cash | bank_transfer';
COMMENT ON COLUMN salary_payments.responsible_employee_id IS
  'اسم الموظف المسؤول — `LoadEmp(MainClass.EmpNo)`: the employee record of whoever signs the إذن';
COMMENT ON COLUMN salary_payments.other_allowances IS
  'بدل طعام + بدل علاج + مكافأة ثابتة + أخرى — the four allowances the window has no box for; `الصافي` = basic + housing + transport + other_allowances + additions − deductions';
COMMENT ON COLUMN salary_payments.deleted_at IS
  'الحذف — `btnDelete_Click` L568 sets IS_Deleted=1; the cloud soft-deletes the same way';
