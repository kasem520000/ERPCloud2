-- Down for 0040_treasury_voucher_detail.sql — drops the four voucher detail columns
-- with their index and foreign key. The data goes with them: a down migration is a
-- rollback of the schema, not an archive.

DROP INDEX IF EXISTS vouchers_location_date_idx;
DROP INDEX IF EXISTS vouchers_salesman_idx;

ALTER TABLE vouchers
  DROP CONSTRAINT IF EXISTS vouchers_salesman_id_fkey;

ALTER TABLE vouchers
  DROP COLUMN IF EXISTS foreign_amount;

ALTER TABLE vouchers
  DROP COLUMN IF EXISTS salesman_id;

ALTER TABLE vouchers
  DROP COLUMN IF EXISTS voucher_time;

ALTER TABLE vouchers
  DROP COLUMN IF EXISTS description;
