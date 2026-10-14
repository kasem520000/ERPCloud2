-- Rollback for 0116 — الجدول كله جديد: إسقاطه يعيد الحالة السابقة (كانت الجلسة تنتقل
-- في query string). لا تُرحَّل بيانات: رموز التسليم عابرة بطبيعتها (≤ دقيقة واحدة).
DROP TABLE IF EXISTS session_handoff_codes;
