-- Down for 0047_reversal_voids_original.sql — restore the function as 0004 wrote it.
-- Reversals stop voiding their original again, so this down is the older behaviour, not
-- a fix.

CREATE OR REPLACE FUNCTION prevent_posted_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' AND NOT (TG_OP = 'UPDATE' AND NEW.status = 'void') THEN
    RAISE EXCEPTION 'posted journal entries are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
