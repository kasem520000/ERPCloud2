-- 0094_employee_branches.sql — 🏢 فروع الموظف
-- `frmEmployees.xaml` L172–L188 keeps `EmpBranches`: an employee can work in several branches,
-- each row carrying the branch id. The desktop's `Employees` has a primary `BranchID` and the
-- grid `EmpBranches` carries the extra ones; the cloud keeps the primary on `employees.branch_id`
-- and the extras here. A primary key on (employee_id, branch_id) prevents duplicates, and
-- deleting an employee or a branch cascades the assignment the way the desktop's foreign key does.

CREATE TABLE IF NOT EXISTS employee_branches (
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (employee_id, branch_id)
);

CREATE INDEX IF NOT EXISTS employee_branches_tenant_branch_idx ON employee_branches (tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS employee_branches_employee_idx ON employee_branches (tenant_id, employee_id);
