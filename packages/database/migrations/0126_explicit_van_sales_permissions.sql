-- 0126_explicit_van_sales_permissions.sql
--
-- 🚐 صلاحيات التوزيع الصريحة — an invisible privilege becomes a visible, editable, revocable one.
--
-- What the code used to do (`packages/contracts/src/permissions.ts ← permissionGrants`):
--
--   * `sales.view`          ⇒ implied `van_sales.view`                     (read — kept)
--   * `sales.invoice.create`⇒ implied **every** `van_sales.*` code, including
--                             `van_sales.closing.approve` (اعتماد إغلاق العهدة وتسوية العجز)
--                             and `van_sales.override.approve` (تجاوز الأسعار المثبّتة وسقوف
--                             البونص), whenever the role carried no explicit `van_sales.*`
--                             code of its own.
--
-- So an invoice clerk became — with no decision by any manager, no row in `role_permissions`,
-- and nothing visible in the roles screen — an approver of custody settlements and of price and
-- bonus overrides. Project policy (§5) is explicit: `sales.view` / `sales.invoice.create` must
-- not imply approval rights, and hiding a right behind an inference rule is worse than hiding a
-- button, because no administrator can see it to revoke it.
--
-- The code now implies only reading (`sales.view` ⇒ `van_sales.view`) and the operational trio a
-- clerk needs so his day does not stop (`van_sales.invoice.create`, `van_sales.collection.create`,
-- `van_sales.closing.submit`). The five approval/management codes
-- (`van_sales.production.manage`, `van_sales.pricing.manage`, `van_sales.load.manage`,
-- `van_sales.closing.approve`, `van_sales.override.approve`) require an explicit grant.
--
-- This file is the compatibility half of that change: it writes down, as ordinary
-- `role_permissions` rows, what those roles already held implicitly — so **no user loses a right
-- he was using**, and from now on the right appears in the roles screen where the manager can see
-- it, keep it, or revoke it deliberately.
--
-- Safety:
--   * only roles that hold `sales.invoice.create` and **no** explicit `van_sales.*` code (other
--     than `van_sales.view`) are touched — the exact population the old inference applied to;
--   * roles already configured explicitly for distribution are left completely alone;
--   * a role holding `*` (مالك المنشأة) is untouched: it matches neither predicate and needs
--     nothing — the wildcard already satisfies every tenant code;
--   * only INSERTs, never an UPDATE or a DELETE of a permission row, and never a change to any
--     document, balance or journal entry;
--   * `ON CONFLICT DO NOTHING` on the primary key `(role_id, permission_code)` ⇒ idempotent:
--     running it twice inserts nothing the second time;
--   * codes are inserted only if they exist in `permissions` (seeded by `0122`), so the file
--     cannot fail on a foreign key in a partially seeded database;
--   * additive and reversible (`down/0126_explicit_van_sales_permissions.down.sql`).

INSERT INTO role_permissions (role_id, permission_code)
SELECT rp.role_id, implied.code
FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id AND r.deleted_at IS NULL
       CROSS JOIN (
         VALUES ('van_sales.production.manage'),
                ('van_sales.pricing.manage'),
                ('van_sales.load.manage'),
                ('van_sales.closing.approve'),
                ('van_sales.override.approve')
       ) AS implied(code)
WHERE rp.permission_code = 'sales.invoice.create'
  AND EXISTS (SELECT 1 FROM permissions p WHERE p.code = implied.code)
  AND NOT EXISTS (SELECT 1
                  FROM role_permissions x
                  WHERE x.role_id = rp.role_id
                    AND x.permission_code LIKE 'van_sales.%'
                    AND x.permission_code <> 'van_sales.view')
ON CONFLICT (role_id, permission_code) DO NOTHING;
