-- 0128_field_sync_queue.down.sql
--
-- Reverses 0128: drops the field-sync ledger. ⚠️ This deletes the conflict inbox and every
-- replay marker — run it only when the whole field-sync flow is being rolled back. Already
-- replayed documents live in `van_sales_documents` / the official engines and are NOT
-- touched, so re-applying the up file afterwards loses only the ledger rows, not the
-- business documents. The RLS policy and grants live on the table and drop with it.

DROP TABLE IF EXISTS field_sync_queue;
