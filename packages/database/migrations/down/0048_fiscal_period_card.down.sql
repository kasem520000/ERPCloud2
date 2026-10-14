-- Down for 0048_fiscal_period_card.sql — the period card's two fields, dropped again.
-- A period keeps its name, its dates, its status and who closed it; what is lost is the
-- note on it and which period was marked active, and the latter is re-chosen in a click.

DROP INDEX IF EXISTS fiscal_periods_one_active_idx;

ALTER TABLE fiscal_periods
  DROP COLUMN IF EXISTS is_active,
  DROP COLUMN IF EXISTS notes;
