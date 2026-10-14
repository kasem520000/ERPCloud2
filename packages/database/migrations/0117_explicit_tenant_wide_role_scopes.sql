-- 0117_explicit_tenant_wide_role_scopes.sql
-- AUD-03 — الوصول الشامل على مستوى المنشأة لم يعد يُفترض ضمنياً عند غياب صفوف
-- `membership_role_scopes`؛ بل يُشترط وجود صفّ صريح يحمل المعرّف القياسي
-- `TENANT_WIDE_SCOPE_ID` (`00000000-0000-0000-0000-000000000000`).
--
-- تحافظ هذه الهجرة على وصول منح الأدوار القائمة قبل هذا التغيير (`membership_roles`)
-- التي لم يُضبط لها أي تقييد في `membership_role_scopes` لنوع نطاق معيّن (`branch`,
-- `warehouse`, `cash_location`) بتحويلها صراحةً إلى `TENANT_WIDE_SCOPE_ID`، بينما
-- الأدوار الجديدة الممنوحة لاحقاً بلا تهيئة نطاق تبقى غير مهيأة (بلا وصول ضمني شامل).

INSERT INTO membership_role_scopes (membership_id, role_id, scope_type, scope_id)
SELECT
  mr.membership_id,
  mr.role_id,
  st.scope_type,
  '00000000-0000-0000-0000-000000000000'::uuid
FROM membership_roles mr
CROSS JOIN (VALUES ('branch'), ('warehouse'), ('cash_location')) AS st(scope_type)
WHERE NOT EXISTS (
  SELECT 1
  FROM membership_role_scopes mrs
  WHERE mrs.membership_id = mr.membership_id
    AND mrs.role_id = mr.role_id
    AND mrs.scope_type = st.scope_type
)
ON CONFLICT DO NOTHING;
