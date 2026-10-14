-- Down migration for 0106 — warehouse bins and light manufacturing.
DELETE FROM role_permissions WHERE permission_code IN (
  'inventory.bins.manage',
  'manufacturing.view',
  'manufacturing.manage',
  'manufacturing.produce'
);
DELETE FROM permissions WHERE code IN (
  'inventory.bins.manage',
  'manufacturing.view',
  'manufacturing.manage',
  'manufacturing.produce'
);

DROP TABLE IF EXISTS manufacturing_moves;
DROP TABLE IF EXISTS manufacturing_orders;
DROP TABLE IF EXISTS bom_lines;
DROP TABLE IF EXISTS boms;
DROP TABLE IF EXISTS bin_transfers;
DROP TABLE IF EXISTS bin_balances;
DROP TABLE IF EXISTS warehouse_bins;
