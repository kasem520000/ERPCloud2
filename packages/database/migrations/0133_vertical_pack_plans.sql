-- 0133_vertical_pack_plans.sql
--
-- M7 — تغليف المنتج: باقات الحزم العمودية الأربع (جملة · تصنيع · مصنع أغذية · بيع
-- متجول).
--
-- الجهاز كله كان قائماً (billing_plans + billing_plan_entitlements من 0019/0068،
-- حقوق feature.* من سجلّ الإعدادات)، لكن ما من باقةٍ مزروعةٍ تبيعه: صفحة الأسعار
-- تقرأ القاعدة وتعرض ما لا شيء فيه. هذا الترحيل يزرع الباقات الأربع للحزم، وكل
-- باقة تفتح حزمتها (سطر feature.* واحد) وتحمل حدّ مستخدمين معقولاً — فتظهر في
-- الموقع فوراً، ويستطيع المشغّل إصدار ترخيصٍ عليها فتُفتح الحزمة للمستأجر.
--
-- القاعدة: الإدخال صامت لا يطغى — `ON CONFLICT DO NOTHING` في كل الصفوف. ما عدّله
-- المشغّل (سعراً أو إيقافاً) من ملكه بعد الزرع؛ الترحيل يقارب قاعدةً فارغة لا
-- قاعدةً مُدارة. الأسعار من كتالوج المتجر نفسه (تطبيق التصنيع 149، البيع المتجول
-- 129)، ومصنع الأغذية حزمة إنتاجٍ وتوزيع فسعره أعلى قليلاً.

INSERT INTO billing_plans (id, code, name, interval, amount, currency, active)
VALUES
  (gen_random_uuid(), 'pack_wholesale',    'حزمة الجملة والتوزيع',  'month', 149.0000, 'SAR', true),
  (gen_random_uuid(), 'pack_manufacturing','حزمة التصنيع والإنتاج', 'month', 149.0000, 'SAR', true),
  (gen_random_uuid(), 'pack_food_factory', 'حزمة مصنع الأغذية',     'month', 199.0000, 'SAR', true),
  (gen_random_uuid(), 'pack_van_sales',    'حزمة البيع المتجول',    'month', 129.0000, 'SAR', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO billing_plan_entitlements (id, plan_id, kind, key, value)
SELECT gen_random_uuid(), p.id, 'module', e.key, 'true'::jsonb
FROM billing_plans p
JOIN (VALUES
  ('pack_wholesale',     'feature.wholesale'),
  ('pack_manufacturing', 'feature.manufacturing'),
  ('pack_food_factory',  'feature.food_factory'),
  ('pack_van_sales',     'feature.van_sales')
) AS e(plan_code, key) ON e.plan_code = p.code
ON CONFLICT (plan_id, key) DO NOTHING;

INSERT INTO billing_plan_entitlements (id, plan_id, kind, key, value)
SELECT gen_random_uuid(), p.id, 'limit', 'limits.max_users', to_jsonb(e.max_users)
FROM billing_plans p
JOIN (VALUES
  ('pack_wholesale',     15),
  ('pack_manufacturing', 15),
  ('pack_food_factory',  20),
  ('pack_van_sales',     10)
) AS e(plan_code, max_users) ON e.plan_code = p.code
ON CONFLICT (plan_id, key) DO NOTHING;
