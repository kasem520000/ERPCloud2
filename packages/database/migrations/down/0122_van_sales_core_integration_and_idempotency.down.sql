-- 0122_van_sales_core_integration_and_idempotency.down.sql
DELETE FROM role_permissions WHERE permission_code LIKE 'van_sales.%';
DELETE FROM permissions WHERE code LIKE 'van_sales.%';

DROP INDEX IF EXISTS factory_production_batches_tenant_idempotency_idx;
DROP INDEX IF EXISTS van_load_orders_tenant_idempotency_idx;
DROP INDEX IF EXISTS van_sales_documents_tenant_idempotency_idx;
DROP INDEX IF EXISTS van_stock_movements_tenant_idempotency_idx;
DROP INDEX IF EXISTS van_stock_movements_closing_unique_idx;
DROP INDEX IF EXISTS van_load_orders_tenant_number_key;
DROP INDEX IF EXISTS van_sales_documents_tenant_number_key;
DROP INDEX IF EXISTS factory_production_batches_tenant_batch_key;

DROP TABLE IF EXISTS van_sales_customer_price_history;

ALTER TABLE van_sales_customer_prices
  DROP COLUMN IF EXISTS effective_from,
  DROP COLUMN IF EXISTS effective_to,
  DROP COLUMN IF EXISTS updated_by,
  DROP COLUMN IF EXISTS change_reason;

ALTER TABLE van_stock_movements
  DROP COLUMN IF EXISTS inventory_transaction_id,
  DROP COLUMN IF EXISTS voucher_id,
  DROP COLUMN IF EXISTS idempotency_key;

ALTER TABLE van_sales_documents
  DROP COLUMN IF EXISTS receipt_voucher_id,
  DROP COLUMN IF EXISTS stock_delivery_id,
  DROP COLUMN IF EXISTS tax_policy_status,
  DROP COLUMN IF EXISTS idempotency_key;

ALTER TABLE van_load_orders
  DROP COLUMN IF EXISTS van_warehouse_id,
  DROP COLUMN IF EXISTS stock_transfer_id,
  DROP COLUMN IF EXISTS return_transfer_id,
  DROP COLUMN IF EXISTS damage_voucher_id,
  DROP COLUMN IF EXISTS approval_request_id,
  DROP COLUMN IF EXISTS shortage_policy_status,
  DROP COLUMN IF EXISTS idempotency_key;

ALTER TABLE factory_production_batches
  DROP COLUMN IF EXISTS production_order_id,
  DROP COLUMN IF EXISTS manufacturing_order_id,
  DROP COLUMN IF EXISTS lot_id,
  DROP COLUMN IF EXISTS inventory_transaction_id,
  DROP COLUMN IF EXISTS scrap_qty,
  DROP COLUMN IF EXISTS idempotency_key;
