-- Down for 0050_salary_adjustment_card.sql — the document half of an adjustment.
--
-- What is lost: the رقم السند, the type link, the payment method, and which documents
-- were deleted. The adjustments themselves stay, with their amounts, their dates and
-- their approval state — which is what a payroll run reads.
--
-- The types table is dropped with them, so an adjustment's النوع is gone; the amount and
-- its `kind` (addition/deduction) survive on the row, which is all the arithmetic needs.

DROP INDEX IF EXISTS salary_adjustments_type_idx;
DROP INDEX IF EXISTS salary_adjustments_tenant_number_key;

ALTER TABLE salary_adjustments
  DROP COLUMN IF EXISTS deleted_by,
  DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS payment_method,
  DROP COLUMN IF EXISTS type_id,
  DROP COLUMN IF EXISTS number;

DROP INDEX IF EXISTS salary_adjustment_types_tenant_idx;
DROP INDEX IF EXISTS salary_adjustment_types_tenant_code_key;
DROP TABLE IF EXISTS salary_adjustment_types;
