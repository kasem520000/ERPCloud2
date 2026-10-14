-- تراجع P-M5: الرمزان وحدهما يسقطان (لا جدول ولا عمود في هذا الترحيل).
DELETE FROM permissions WHERE code IN ('console.content.view', 'console.content.manage');
