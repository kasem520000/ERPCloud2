-- تراجع P-M6: الرمزان وحدهما يسقطان (لا جدول ولا عمود في هذا الترحيل).
DELETE FROM permissions WHERE code IN ('console.leads.view', 'console.leads.manage');
