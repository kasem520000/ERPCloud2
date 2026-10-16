-- 0130_production_wip.sql
--
-- M6.2 — مرحلة «تحت التشغيل» (WIP) لأمر الإنتاج: الصرف والإكمال خطوتان منفصلتان.
--
-- Until now `production_orders` moved both directions in one transaction (`complete`
-- consumed the components and received the output together), so there was no moment at
-- which materials had left the shelf without a finished item to show for them — which
-- is exactly why `wipAccountId` was deliberately absent from the posting-profile
-- vocabulary. This migration is that moment arriving:
--
--   * `POST /inventory/production-orders/:id/issue` — components leave the warehouse at
--     the moving average (status `draft` → `in_progress`, `issued_at` set,
--     `component_cost` = what actually left). The value is now on the floor.
--   * `complete` — on an issued order it only receives the output at the accumulated
--     cost; the legacy draft path (consume + produce in one transaction) is untouched,
--     so no existing tenant changes behaviour.
--
-- Additive only, idempotent (`IF NOT EXISTS`); no new table, no RLS changes (the
-- columns live inside `production_orders`, which already carries the canonical
-- tenant-isolation policy). The status column is plain text — `in_progress` needs no
-- constraint edit. `down` drops the two columns: issued orders fall back to looking
-- like never-issued drafts; the journal entries they posted are the accountant's
-- ledger and are never touched by a rollback.

ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS wip_posted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN production_orders.issued_at IS
  'M6.2 — لحظة صرف المكوّنات إلى الأرضية؛ بينها وبين completed_at القيمة تحت التشغيل';
COMMENT ON COLUMN production_orders.wip_posted IS
  'هل رُحِّل الصرف عبر حساب تحت التشغيل؟ يحدّد زوج حسابات الإكمال: wip_posted ⇒ منتج تام ← تحت التشغيل، وإلا ⇒ منتج تام ← مواد خام';
