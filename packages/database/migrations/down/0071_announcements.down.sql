-- 0071_announcements.down.sql — تراجع P-C7.
-- يُحذف سجلّ التسليم أولاً (المرجع)، ثم المستند، ثم رمز الصلاحية الذي أضافه الترحيل.
DROP TABLE IF EXISTS announcement_reads;
DROP TABLE IF EXISTS announcements;
DELETE FROM permissions WHERE code = 'console.notifications.manage';
