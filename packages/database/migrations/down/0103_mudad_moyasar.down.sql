-- Down migration for 0103 — Mudad, GOSI and online payment links.
DELETE FROM role_permissions WHERE permission_code IN ('payroll.wps.export', 'payments.links.manage');
DELETE FROM permissions WHERE code IN ('payroll.wps.export', 'payments.links.manage');

DROP TABLE IF EXISTS payment_links;
DROP TABLE IF EXISTS payment_provider_configs;
DROP TABLE IF EXISTS payroll_gosi_files;
DROP TABLE IF EXISTS payroll_wps_files;
DROP TABLE IF EXISTS payroll_compliance_settings;

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_gosi_scheme_check;
ALTER TABLE employees DROP COLUMN IF EXISTS gosi_scheme;
ALTER TABLE employees DROP COLUMN IF EXISTS insurance_expires_on;
ALTER TABLE employees DROP COLUMN IF EXISTS iqama_expires_on;
