-- تراجع P-C10: الجداول الثلاثة والصلاحية.
--
-- ولا يُلمس سجلّ التدقيق: هذا الترحيل لم يضف إليه شيئاً (أعاد تأكيد المنع فقط).
DROP TABLE IF EXISTS data_requests;
DROP TABLE IF EXISTS backup_jobs;
DROP TABLE IF EXISTS backup_artifacts;

DELETE FROM permissions WHERE code = 'console.backups.manage';
