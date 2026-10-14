-- 0031_mfa.down.sql
DROP TABLE IF EXISTS mfa_recovery_codes;
ALTER TABLE users DROP COLUMN IF EXISTS mfa_enabled;
