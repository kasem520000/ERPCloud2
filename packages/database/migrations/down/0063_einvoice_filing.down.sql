-- Down for 0063_einvoice_filing.sql — 🧾 الإرسال والتوقيع والسلسلة.
--
-- What is lost: عدّاد الفاتورة (`chain_index`)، وكلمة الهيئة على الإرسال
-- (`authority_status`)، والمستند المُصادَق الذي تعيده الهيئة للفواتير الضريبية
-- (`cleared_invoice`)، وفهرس الترتيب بالتاريخ.
--
-- What stays: the submission row itself with its status, its hash, the previous hash, the
-- QR and the UBL document it was built from (`request_payload`), and the response blob the
-- answer was also written into. Nothing that existed before this migration is dropped: the
-- three columns are additive, and the filing path reads them back with `?? undefined`
-- fallbacks, so an environment rolled back to 0062 keeps filing.

DROP INDEX IF EXISTS einvoice_submissions_recent_idx;

ALTER TABLE einvoice_submissions DROP COLUMN IF EXISTS cleared_invoice;
ALTER TABLE einvoice_submissions DROP COLUMN IF EXISTS authority_status;
ALTER TABLE einvoice_submissions DROP COLUMN IF EXISTS chain_index;
