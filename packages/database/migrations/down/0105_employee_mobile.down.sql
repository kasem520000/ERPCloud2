-- Down migration for 0105 — employee mobile PWA.
DELETE FROM role_permissions WHERE permission_code IN ('employee.self.view', 'employee.self.manage', 'employee.team.approve');
DELETE FROM permissions WHERE code IN ('employee.self.view', 'employee.self.manage', 'employee.team.approve');

DROP TABLE IF EXISTS employee_push_outbox;
DROP TABLE IF EXISTS employee_push_subscriptions;
DROP TABLE IF EXISTS employee_requests;
DROP TABLE IF EXISTS employee_attendance;
DROP TABLE IF EXISTS employee_geofences;
