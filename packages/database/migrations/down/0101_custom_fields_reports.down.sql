DROP TABLE IF EXISTS custom_field_values;
DROP TABLE IF EXISTS custom_reports;
DROP TABLE IF EXISTS custom_fields;

DELETE FROM permissions
WHERE code IN ('custom_fields.manage', 'custom_fields.view', 'custom_reports.manage', 'custom_reports.view');
