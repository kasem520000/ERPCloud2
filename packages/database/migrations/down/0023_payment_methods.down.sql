-- 0023_payment_methods.down.sql
ALTER TABLE parties DROP COLUMN IF EXISTS payment_method_id;
DROP TABLE IF EXISTS payment_methods;
