-- Down migration for 0100 — approval workflow engine.
DROP TABLE IF EXISTS approval_decisions;
DROP TABLE IF EXISTS approval_requests;
DROP TABLE IF EXISTS approval_steps;
DROP TABLE IF EXISTS approval_workflows;

DELETE FROM role_permissions WHERE permission_code IN ('approval.manage', 'approval.approve');
DELETE FROM permissions WHERE code IN ('approval.manage', 'approval.approve');
