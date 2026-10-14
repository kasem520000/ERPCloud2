-- Phase 06 part two — تعريف الخزن والبنوك: ملاحظات الصندوق ومسئولوه.
--
-- `Form_WPF/frmTreasury.xaml` (`Title="تعريف الخزن"`) is not a name and a branch: the
-- save in `frmTreasury.xaml.cs:222` refuses a الصندوق with no مسئول («يجب اختيار موظف
-- مسئول»), and inside the *same transaction* wipes `Stock_Emps` and re-inserts the
-- responsible employees — a box is a box, but somebody signs for it. `frmBanks.xaml`
-- carries the bank's own details on the same row: 🌍 الدولة، 🏙️ المدينة، 📍 المنطقة،
-- تليفون، موبايل، 💰 نسبة الاقتطاع %.
--
-- The cloud's `cash_locations` has the box but neither the signature nor the notes:
-- `cash_location_custodians` is `Stock_Emps` with tenant isolation and a real foreign
-- key, and `notes` is the 📝 ملاحظات field. The bank attributes extend the existing
-- `bank` JSON block — no migration, because that block is a typed document, not a
-- column set.

-- 📝 ملاحظات — `frmTreasury.xaml` puts it in its own group box.
ALTER TABLE cash_locations
  ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN cash_locations.notes IS
  '📝 ملاحظات — the note the desktop keeps on the treasury card';

-- 👤 مسئولي الصندوق — `Stock_Emps (stock_id, emp_id)` in the desktop, one row per
-- responsible employee, replaced wholesale on every save.
CREATE TABLE IF NOT EXISTS cash_location_custodians (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  cash_location_id uuid NOT NULL REFERENCES cash_locations (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  -- `baseAuditColumns()`: who created the link, who touched it, and an optimistic
  -- concurrency version, the same shape every other tenant table carries.
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version integer NOT NULL DEFAULT 1
);

COMMENT ON TABLE cash_location_custodians IS
  '👤 مسئولي الصندوق — the desktop''s Stock_Emps: who signs for this safe or bank account';

-- The same employee cannot be listed twice on one box.
CREATE UNIQUE INDEX IF NOT EXISTS cash_location_custodians_key
  ON cash_location_custodians (tenant_id, cash_location_id, employee_id);

-- "Which boxes does this employee sign for?"
CREATE INDEX IF NOT EXISTS cash_location_custodians_employee_idx
  ON cash_location_custodians (tenant_id, employee_id);

ALTER TABLE cash_location_custodians ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_location_custodians FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cash_location_custodians;
CREATE POLICY tenant_isolation ON cash_location_custodians
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
