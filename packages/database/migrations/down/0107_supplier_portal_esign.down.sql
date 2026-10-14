-- Down migration for 0107 — supplier portal and simple e-sign.
DELETE FROM role_permissions WHERE permission_code IN ('supplier_portal.access', 'esign.manage');
DELETE FROM permissions WHERE code IN ('supplier_portal.access', 'esign.manage');

DROP TABLE IF EXISTS esign_events;
DROP TABLE IF EXISTS esign_requests;
DROP TABLE IF EXISTS supplier_invoice_uploads;
DROP TABLE IF EXISTS supplier_rfqs;
DROP TABLE IF EXISTS supplier_portal_sessions;
DROP TABLE IF EXISTS supplier_portal_users;
