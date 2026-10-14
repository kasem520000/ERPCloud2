-- 0029_einvoice_counter.sql
-- The ZATCA invoice counter value (ICV).
--
-- Every reported invoice carries a counter that starts at 1 and increases by exactly one,
-- alongside the hash of the previous invoice (PIH). Together they prove to the authority that
-- no invoice was removed from the middle of the sequence. The counter therefore belongs to
-- the same row as the last hash — one row per tenant, authority and environment — so that the
-- `SELECT ... FOR UPDATE` that hands out the next hash hands out the next number in the same
-- breath, and two invoices posted in the same millisecond cannot claim the same ICV.

ALTER TABLE einvoice_chain ADD COLUMN IF NOT EXISTS counter bigint NOT NULL DEFAULT 0;

-- Two states the original constraint did not foresee, because the original flow pretended the
-- authority had answered. `prepared` = the compliant document exists and carries a valid
-- phase-1 QR, but the tenant has not uploaded a key. `signed` = it is signed and waiting for a
-- gateway. Both are honest resting places; neither claims the invoice was filed.
ALTER TABLE einvoice_submissions DROP CONSTRAINT IF EXISTS einvoice_submissions_status_check;
ALTER TABLE einvoice_submissions ADD CONSTRAINT einvoice_submissions_status_check
  CHECK (status IN ('pending','prepared','signed','cleared','reported','failed','not_implemented'));
