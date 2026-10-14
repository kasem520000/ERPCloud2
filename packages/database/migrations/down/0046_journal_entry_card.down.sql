-- Down for 0046_journal_entry_card.sql — the three card fields, dropped again. Nothing
-- else reads them, and the entry keeps its date, number and lines.

DROP INDEX IF EXISTS journal_entry_lines_salesman_idx;

ALTER TABLE journal_entry_lines
  DROP COLUMN IF EXISTS salesman_id;

ALTER TABLE journal_entries
  DROP COLUMN IF EXISTS is_vat,
  DROP COLUMN IF EXISTS entry_time;
