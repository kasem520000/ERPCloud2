-- Down migration for 0108 — personal BI dashboards.
DELETE FROM role_permissions WHERE permission_code IN ('dashboards.view', 'dashboards.manage');
DELETE FROM permissions WHERE code IN ('dashboards.view', 'dashboards.manage');

DROP TABLE IF EXISTS dashboard_widgets;
DROP TABLE IF EXISTS dashboards;
