-- 0130_production_wip.down.sql
--
-- Reverses 0130: drops the WIP columns from `production_orders`. ⚠️ An order that was
-- issued looks like a plain draft again (no issued_at / wip_posted), so re-running 0130
-- up after this can resurrect half-finished flows — run this only when the whole
-- two-stage flow is being rolled back. Journal entries the issues/completions posted
-- live in `journal_entries` and are NOT touched: they are the accountant's ledger, and
-- reversing them is a reversal entry, never a dropped column. The `wipAccountId`
-- posting-profile key is left in place: it is an additive registry entry in the
-- contracts vocabulary, and stored mappings that reference it keep parsing.

ALTER TABLE production_orders
  DROP COLUMN IF EXISTS issued_at,
  DROP COLUMN IF EXISTS wip_posted;
