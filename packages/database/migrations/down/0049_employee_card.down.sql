-- Down for 0049_employee_card.sql — the employee card's fields, dropped again.
--
-- What is lost: the employee's ديانة of personal data (birth date, insurance, identity,
-- marital status, nationality, gender, contacts, address, notes) and the link to the GL
-- account the card created. The account itself is not dropped — it is a posted-to account
-- in the tenant's chart and only the employee's pointer to it disappears.
--
-- Departments are flattened: every قسم becomes an إدارة of its own rather than being
-- merged into its parent, because a row cannot say which of the two it was.

UPDATE departments d
   SET parent_id = NULL
  FROM departments p
 WHERE d.parent_id = p.id
   AND d.tenant_id = p.tenant_id;

DROP INDEX IF EXISTS employees_account_idx;

ALTER TABLE employees
  DROP COLUMN IF EXISTS employee_account_id,
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS mobile,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS gender,
  DROP COLUMN IF EXISTS nationality,
  DROP COLUMN IF EXISTS marital_status,
  DROP COLUMN IF EXISTS national_id,
  DROP COLUMN IF EXISTS insurance_no,
  DROP COLUMN IF EXISTS birth_date;

DROP INDEX IF EXISTS departments_parent_idx;

ALTER TABLE departments
  DROP COLUMN IF EXISTS parent_id;
