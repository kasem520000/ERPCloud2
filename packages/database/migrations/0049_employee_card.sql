-- Phase 08 part one — 👤 بطاقة الموظف and 🏢 الإدارات والأقسام.
--
-- `Form_WPF/frmEmployees.xaml` («تعريف موظف») is one window with five regions:
--
--   • «بيانات الموظف الأساسية»  — اسم الموظف · رقم الحساب · الإدارة · القسم · الوظيفة ·
--     الحالة · تاريخ الميلاد · تاريخ التعيين · رقم التأمينات · الحالة الاجتماعية ·
--     الجنسية · النوع (ذكر/أنثى) · رقم الهاتف · رقم الموبايل · البريد الإلكتروني
--   • «الرواتب والمستحقات»       — الراتب الأساسي · بدل سكن · بدل مواصلات · طعام · طبي ·
--     مكافأة ثابتة · أخرى · إجمالي الرواتب والمستحقات
--   • «البيانات التكميلية»       — العنوان · رقم الهوية · رقم الحساب البنكي · اسم البنك ·
--     ملاحظات
--   • «صورة الموظف»              — اختر صورة / مسح
--   • «فروع الموظف»              — الفرع (a grid: `EmpBranches`)
--
-- and the window's own grid «قائمة الموظفين» is `الرقم · الاسم · إجمالي المرتب`.
--
-- `frmEmployees.xaml.cs` is where the rules are. `BtnSave_Click` L520 refuses an empty
-- name («يجب إدخال اسم الموظف»), fills `رقم الحساب` from
-- `MaxId("Code", "Accounts_Index", Common.CurrentBranch.EmployeeAcc)` when the operator
-- left it blank, and then writes the account itself (L600 `SaveAccounts`): a `TreeAccount`
-- row named after the employee, hung under the branch's employee account
-- (`ParentCode = Common.CurrentBranch.EmployeeAcc`, default 2241 per
-- `Class/Common.cs` L998), `INSERT`ed when the code is new and renamed (`AName`) when it
-- already exists. `BtnDelete_Click` L730 refuses twice — «لا يمكن حذف موظف مرتبط بمستخدم»
-- and «لا يمكن حذف موظف مرتبط بفواتير» — and only then sets `IS_Deleted = 1`.
--
-- `Form_WPF/frmManagement.xaml` («الإدارات») and `Form_WPF/frmDepartments.xaml`
-- («الأقسام» / «إدخال بيانات الإدارات والأقسام») are the two levels above the employee:
-- `Managements(id, name)` is the parent of `Departments(id, manag_id, name)`
-- (`frmDepartments.xaml.cs` L108 `INNER JOIN Managements m ON d.manag_id = m.id`), and
-- saving a قسم without an إدارة is refused («يجب اختيار إدارة أولاً»).
--
-- The cloud's `employees` row carries the payroll side of the card and nothing else —
-- no birth date, no phone, no address, no account — and its `departments` table is flat,
-- so الإدارة and القسم are the same row. Both are additive here:
--
--   • `departments.parent_id` — a self-reference. A row with no parent *is* an إدارة; a
--     row with one is a قسم. Every department already on the books has no parent, so each
--     of them is an إدارة today, and `الإدارة` on the employee card is read back from the
--     assigned row's parent instead of being stored twice.
--   • the employee columns — all nullable, all new, so an existing employee keeps every
--     value it has and simply has no birth date until someone enters one.
--
-- `employee_account_id` is the `رقم الحساب` of the card: the account `SaveAccounts`
-- creates. It is a real reference to `accounts`, not a copy of the code, because the
-- desktop's `AccCode` is what forces the account to exist at all — the employee's سلف
-- and أمانات are posted to it.

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES departments (id) ON DELETE restrict;

CREATE INDEX IF NOT EXISTS departments_parent_idx ON departments (tenant_id, parent_id);

COMMENT ON COLUMN departments.parent_id IS
  'الإدارة التي يتبع لها القسم — `Departments.manag_id` → `Managements.id` (frmDepartments.xaml «اسم الإدارة التابع لها»); NULL means the row is an إدارة';

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS birth_date date,
  ADD COLUMN IF NOT EXISTS insurance_no text,
  ADD COLUMN IF NOT EXISTS national_id text,
  ADD COLUMN IF NOT EXISTS marital_status text,
  ADD COLUMN IF NOT EXISTS nationality text,
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS mobile text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS employee_account_id uuid REFERENCES accounts (id) ON DELETE set null;

CREATE INDEX IF NOT EXISTS employees_account_idx ON employees (tenant_id, employee_account_id);

COMMENT ON COLUMN employees.birth_date IS
  'تاريخ الميلاد — `frmEmployees.xaml` txtBirthDate; NULL when not recorded';
COMMENT ON COLUMN employees.insurance_no IS
  'رقم التأمينات — `frmEmployees.xaml` txtInsuranceNo (`insurance_no`)';
COMMENT ON COLUMN employees.national_id IS
  'رقم الهوية — `frmEmployees.xaml` TxtCard (`CardNo`)';
COMMENT ON COLUMN employees.marital_status IS
  'الحالة الاجتماعية — `frmEmployees.xaml` cmbMaritalStatus; free text: the desktop reads a `Marital_status` lookup whose rows are not in the repository';
COMMENT ON COLUMN employees.nationality IS
  'الجنسية — `frmEmployees.xaml` cmbNationality (a `Countries` lookup); kept as the nationality name because the cloud has no countries table';
COMMENT ON COLUMN employees.gender IS
  'النوع — `frmEmployees.xaml` rdMale/rdFemale: `male` | `female` (the desktop stores 1/2)';
COMMENT ON COLUMN employees.phone IS 'رقم الهاتف — `frmEmployees.xaml` txtTel';
COMMENT ON COLUMN employees.mobile IS 'رقم الموبايل — `frmEmployees.xaml` txtMobile';
COMMENT ON COLUMN employees.email IS 'البريد الإلكتروني — `frmEmployees.xaml` txtEmail';
COMMENT ON COLUMN employees.address IS 'العنوان — `frmEmployees.xaml` txtAddress';
COMMENT ON COLUMN employees.notes IS 'ملاحظات — `frmEmployees.xaml` txtNotes';
COMMENT ON COLUMN employees.employee_account_id IS
  'رقم الحساب — the account `frmEmployees.xaml.cs` L600 `SaveAccounts` writes under the employee account root (default 2241)';
