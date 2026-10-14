-- Rollback for 0117 — حذف صفوف المعرّف الصريح للوصول الشامل (`00000000-0000-0000-0000-000000000000`).
DELETE FROM membership_role_scopes
WHERE scope_id = '00000000-0000-0000-0000-000000000000'::uuid;
