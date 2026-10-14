-- 0029_einvoice_counter.down.sql
ALTER TABLE einvoice_submissions DROP CONSTRAINT IF EXISTS einvoice_submissions_status_check;
UPDATE einvoice_submissions SET status = 'pending' WHERE status IN ('prepared','signed');
ALTER TABLE einvoice_submissions ADD CONSTRAINT einvoice_submissions_status_check
  CHECK (status IN ('pending','cleared','reported','failed','not_implemented'));
ALTER TABLE einvoice_chain DROP COLUMN IF EXISTS counter;
