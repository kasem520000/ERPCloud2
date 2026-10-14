-- Down for 0041_treasury_custody.sql — the custodian links and the notes column go
-- together; a box with no signature is the state this migration existed to leave.

DROP POLICY IF EXISTS tenant_isolation ON cash_location_custodians;

DROP INDEX IF EXISTS cash_location_custodians_employee_idx;
DROP INDEX IF EXISTS cash_location_custodians_key;

DROP TABLE IF EXISTS cash_location_custodians;

ALTER TABLE cash_locations
  DROP COLUMN IF EXISTS notes;
