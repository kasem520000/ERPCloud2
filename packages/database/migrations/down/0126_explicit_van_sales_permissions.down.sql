-- 0126_explicit_van_sales_permissions.down.sql
--
-- ⚠️ تحذير صريح — هذا التراجع **يحذف صلاحيات**، ولا يستطيع التمييز بين ما أضافه ملف الصعود
-- وما منحه المدير بيده بعده: فكلاهما صفّ عادي في `role_permissions` ولا يحمل أي علامة. لذلك
-- يحذف الأكواد الخمسة من كل دور يملك `sales.invoice.create`، بما فيها الممنوحة صراحةً عن قصد.
--
-- ⚠️ ولا معنى لتشغيله وحده: الكود (منذ إصلاح `permissionGrants`) لم يعد يستنتج أكواد الاعتماد
-- والإدارة من صلاحيات المبيعات، فحذفها هنا يعني أن كاتب الفواتير يفقد فعلاً اعتماد الإغلاق
-- وإدارة التحميل والتسعير وتجاوز الأسعار (403) — وهي النتيجة المقصودة من الإصلاح، لا حالة سابقة
-- سليمة يُرجَع إليها. لا تشغّله إلا مع إرجاع الكود نفسه إلى ما قبل الإصلاح، أو بقرار صريح من
-- مالك المنشأة بسحب هذه الصلاحيات من كل الأدوار التي تملك `sales.invoice.create`.
--
-- ما لا يفعله: لا يمسّ أي مستند أو رصيد أو قيد محاسبي، ولا يحذف دوراً، ولا يحذف عضوية،
-- ولا يمسّ أدواراً لا تملك `sales.invoice.create` (ومنها دور المالك `*` والأدوار التي ضُبطت
-- للتوزيع صراحةً دون صلاحيات مبيعات).

DELETE
FROM role_permissions
WHERE permission_code IN ('van_sales.production.manage',
                          'van_sales.pricing.manage',
                          'van_sales.load.manage',
                          'van_sales.closing.approve',
                          'van_sales.override.approve')
  AND role_id IN (SELECT role_id FROM role_permissions WHERE permission_code = 'sales.invoice.create');
