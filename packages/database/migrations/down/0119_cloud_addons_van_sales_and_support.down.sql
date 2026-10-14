-- 0119_cloud_addons_van_sales_and_support.down.sql

DELETE FROM tenant_apps WHERE app_code IN ('manufacturing', 'tailoring', 'optics', 'marina', 'projects', 'employee_app', 'van_sales');
DELETE FROM marketplace_apps WHERE code IN ('manufacturing', 'tailoring', 'optics', 'marina', 'projects', 'employee_app', 'van_sales');

DROP TABLE IF EXISTS van_sales_documents;
DROP TABLE IF EXISTS van_load_orders;
DROP TABLE IF EXISTS van_sales_customer_prices;
DROP TABLE IF EXISTS marketplace_addon_requests;
