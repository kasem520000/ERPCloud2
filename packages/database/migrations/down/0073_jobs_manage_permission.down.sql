-- تراجع P-C9: الرمز وحده يسقط (لا جدول ولا عمود في هذا الترحيل).
DELETE FROM permissions WHERE code = 'console.jobs.manage';
