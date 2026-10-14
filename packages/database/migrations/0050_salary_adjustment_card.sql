-- Phase 08 part two — 🎁 الحوافز والجزاءات (`Form_WPF/frmEmpSalaryAddSub.xaml`).
--
-- `frmEmpSalaryAddSub.xaml` («الحوافز والجزاءات») is one card over one grid:
--
--   • «إدخال الحوافز والخصومات للموظفين» — `الموظف` (اختر الموظف...) · `النوع`
--     (اختر النوع...) · `المبلغ` · `التاريخ` · `الوقت` · `طريقة الدفع` (نقدي/بنكي) ·
--     الصندوق أو البنك (`cmbDepositTo`) · `✅ تضاف على الراتب` / `✂️ تخصم من الراتب` ·
--     `ملاحظات` · «رقم السند:»
--   • «قائمة الحركات» — `RecordId · EmpId · EmpName · Value · TypeName · RecordDate`
--     تُضيَّق بالموظف (`cmbEmpSrch` أو `chkAllEmp`) وبمدى تاريخ (`من`/`إلى`).
--
-- `frmEmpSalaryAddSub.xaml.cs` is where the rules are:
--
--   • `ValidateInputs` L566 — four refusals, in the window's own words:
--     «يجب اختيار موظف» · «يجب اختيار نوع الإجراء» · «يجب إدخال مبلغ» ·
--     «يجب اختيار الصندوق أو البنك».
--   • `LoadNextNumber` L225 — «رقم السند» is `ISNULL(MAX(id),0)+1`.
--   • `CmbType_EditValueChanged` L540 — the type decides the sentence on the checkbox:
--     type 1 → «✅ تضاف على الراتب», every other type → «✂️ تخصم من الراتب».
--   • `CreateReceiptObject` L665 — the note writes itself when the clerk leaves it
--     empty: «مكافأة للموظف …» / «خصم للموظف …» / «سلفة للموظف …».
--   • `BindReceiptToEntry` L718 — one journal entry per document (type 28): the
--     employee's own account (`Employees.AccCode`, the account Part One creates) on one
--     side and the صندوق/البنك on the other.
--   • `PopulateParameters` L846 — `Cash` or `Bank` is written depending on
--     `طريقة الدفع`, never both.
--
-- The cloud's `salary_adjustments` holds the payroll half of the idea — an approved
-- addition or deduction that a payroll run picks up in its month window — and nothing of
-- the document: no number, no type, no payment method, no entry, no delete, no search.
-- Both halves are additive here, and every column is nullable so an adjustment already on
-- the books keeps its meaning.
--
-- `SalaryAddSubTypes` is the desktop's lookup; its rows are not in the repository, but
-- the code-behind fixes three of them by id: 1 = مكافأة, 2 = خصم, 3 = سلفة. They are
-- seeded here for every tenant that exists and by `OrgProvisioningService` for every
-- tenant created afterwards.

CREATE TABLE IF NOT EXISTS salary_adjustment_types (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE cascade,
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS salary_adjustment_types_tenant_code_key
  ON salary_adjustment_types (tenant_id, code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS salary_adjustment_types_tenant_idx
  ON salary_adjustment_types (tenant_id, sort_order);

COMMENT ON COLUMN salary_adjustment_types.kind IS
  'addition | deduction — `CmbType_EditValueChanged`: type 1 «✅ تضاف على الراتب», every other type «✂️ تخصم من الراتب»';

-- 🎁 الأنواع الثلاثة التي يعرفها الديسكتوب: مكافأة · خصم · سلفة
INSERT INTO salary_adjustment_types (id, tenant_id, code, name, kind, sort_order)
SELECT
  gen_random_uuid(), tenants.id, seed.code, seed.name, seed.kind, seed.sort_order
FROM tenants
CROSS JOIN (
  VALUES ('bonus', 'مكافأة', 'addition', 1),
         ('deduction', 'خصم', 'deduction', 2),
         ('advance', 'سلفة', 'deduction', 3)
) AS seed (code, name, kind, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM salary_adjustment_types existing
   WHERE existing.tenant_id = tenants.id AND existing.code = seed.code
);

ALTER TABLE salary_adjustments
  ADD COLUMN IF NOT EXISTS number text,
  ADD COLUMN IF NOT EXISTS type_id uuid REFERENCES salary_adjustment_types (id) ON DELETE restrict,
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid;

CREATE UNIQUE INDEX IF NOT EXISTS salary_adjustments_tenant_number_key
  ON salary_adjustments (tenant_id, number)
  WHERE deleted_at IS NULL AND number IS NOT NULL;

CREATE INDEX IF NOT EXISTS salary_adjustments_type_idx
  ON salary_adjustments (tenant_id, type_id);

COMMENT ON COLUMN salary_adjustments.number IS
  'رقم السند — `frmEmpSalaryAddSub.xaml.cs` L225 LoadNextNumber: ISNULL(MAX(id),0)+1';
COMMENT ON COLUMN salary_adjustments.type_id IS
  'النوع — `SalaryAddSubTypes` (مكافأة · خصم · سلفة)';
COMMENT ON COLUMN salary_adjustments.payment_method IS
  'طريقة الدفع — `rdCash`/`rdCheck`: cash | bank, and the chosen صندوق or بنك sits in cash_location_id';
COMMENT ON COLUMN salary_adjustments.deleted_at IS
  'الحذف — `IconButton9_Click` sets IS_Deleted=1; the cloud soft-deletes the same way';
