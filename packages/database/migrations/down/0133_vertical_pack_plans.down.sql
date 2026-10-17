-- 0133_vertical_pack_plans.down.sql
--
-- Reverses 0133: removes the four seeded pack plans and their entitlements.
--
-- ⚠️ The delete of `billing_plans` fails loudly (FK from `tenant_subscriptions`) when a
-- customer already holds a licence on a pack plan — deliberately: packaging that was
-- bought is not silently rolled back. On a database that only ever ran the seed, the
-- delete succeeds and the pricing page returns to whatever it showed before.

DELETE FROM billing_plan_entitlements
WHERE plan_id IN (SELECT id FROM billing_plans WHERE code IN
  ('pack_wholesale', 'pack_manufacturing', 'pack_food_factory', 'pack_van_sales'));

DELETE FROM billing_plans
WHERE code IN ('pack_wholesale', 'pack_manufacturing', 'pack_food_factory', 'pack_van_sales');
