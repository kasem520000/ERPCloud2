-- Down for 0042_shift_close_number.sql — an open shift has no number to lose, and the
-- close report falls back to the drawer's timestamps.

DROP INDEX IF EXISTS shift_closes_number_key;

ALTER TABLE shift_closes
  DROP COLUMN IF EXISTS number;
