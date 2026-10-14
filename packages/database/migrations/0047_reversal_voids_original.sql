-- Phase 07 part four — the reversal that never was.
--
-- `reverseJournal` posts a mirrored entry and then marks the original `void`. The guard
-- trigger installed in `0004_accounting.sql` L115 lets that one mutation through:
--
--     IF OLD.status = 'posted' AND NOT (TG_OP = 'UPDATE' AND NEW.status = 'void') THEN
--       RAISE EXCEPTION 'posted journal entries are immutable' ...
--     END IF;
--     RETURN OLD;
--
-- — and then returns `OLD`, so the value it just allowed is thrown away. Every reversal
-- since then has left its original `posted`: the ledger still nets out (the mirrored
-- entry cancels it), which is why no balance test ever failed, but the register shows
-- two posted entries where the desktop shows one posted and one voided, and — the part
-- that does cost money — a report scoped to a dimension reads the original's amount
-- while the reversal carries none, so 🌳 شجرة مراكز التكلفة keeps spending that was
-- reversed.
--
-- … and it was not only reversals. `sales.service.ts`, `purchases.service.ts` and
-- `inventory.service.ts` void a journal entry when the document behind it is cancelled,
-- and every one of those voids was discarded too: a cancelled sale kept its revenue.
--
-- The fix is the function's return value: an update the guard allows must be applied.
-- `reverseJournal` no longer asks for a `void` — its mirrored entry is the whole
-- reversal, and voiding the original as well would subtract the amount twice.
-- Deletes still return `OLD` (there is no `NEW` to return), and every other mutation of
-- a posted entry is still refused by the exception above.

CREATE OR REPLACE FUNCTION prevent_posted_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' AND NOT (TG_OP = 'UPDATE' AND NEW.status = 'void') THEN
    RAISE EXCEPTION 'posted journal entries are immutable' USING ERRCODE = '42501';
  END IF;
  -- A delete has no NEW; any update that reached this line is one the guard allows.
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
