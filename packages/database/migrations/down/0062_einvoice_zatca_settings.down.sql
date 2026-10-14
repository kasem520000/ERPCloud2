-- Down for 0062_einvoice_zatca_settings.sql — ⚙️ إعدادات الربط الضريبي - زاتكا.
--
-- What is lost: إعدادات الربط (بيئة الربط · التفعيل · التاريخ · خصائص شهادة CSR) وختم كل
-- خطوة من خطوات التأهيل (`csr_generated_at` · `compliance_csid_at` ·
-- `production_csid_at` · `compliance_checked_at` · `renewed_at`)، ومعرّف طلب شهادة
-- الامتثال (`request_id`) وشهادة الإنتاج (`p_request_id` · `p_csid_enc` ·
-- `p_secret_enc`).
--
-- What stays: the credentials themselves — `csr` · `private_key_enc` · `csid_enc` ·
-- `secret_enc` were there before this migration and are not touched, so a tenant that
-- already onboarded keeps its key and its CSID and only has to re-run «🧪 اختبار الربط».
-- Submissions (`einvoice_submissions`) and the hash chain (`einvoice_chain`) are untouched.
--
-- Nothing that existed before this migration is dropped.

ALTER TABLE einvoice_credentials DROP COLUMN IF EXISTS p_secret_enc;
ALTER TABLE einvoice_credentials DROP COLUMN IF EXISTS p_csid_enc;
ALTER TABLE einvoice_credentials DROP COLUMN IF EXISTS p_request_id;
ALTER TABLE einvoice_credentials DROP COLUMN IF EXISTS request_id;

DROP POLICY IF EXISTS einvoice_settings_tenant_isolation ON einvoice_settings;
DROP INDEX IF EXISTS einvoice_settings_tenant_idx;
DROP INDEX IF EXISTS einvoice_settings_tenant_authority_key;

DROP TABLE IF EXISTS einvoice_settings;
