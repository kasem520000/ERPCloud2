-- Down for 0043_shift_close_entry.sql — the entry itself is left alone (it is a journal
-- entry like any other, and deleting accounting history is not a migration's job); only
-- the shift's pointer to it is dropped.

DROP INDEX IF EXISTS shift_closes_entry_idx;

ALTER TABLE shift_closes
  DROP COLUMN IF EXISTS posted_at,
  DROP COLUMN IF EXISTS journal_entry_id;
