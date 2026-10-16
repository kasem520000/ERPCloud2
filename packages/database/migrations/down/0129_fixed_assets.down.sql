-- 0129_fixed_assets.down.sql
--
-- Reverses 0129: drops the three fixed-asset tables. ⚠️ This deletes the register and
-- the depreciation run ledger — run it only when the whole fixed-assets flow is being
-- rolled back. The journal entries the runs posted live in `journal_entries` and are
-- NOT touched (they are the accountant's ledger; reversing them is a reversal entry,
-- never a dropped table). The three `accounting.assets.*` permission codes are left in
-- place: codes are additive registry entries, and any role that references them keeps
-- working; removing them is a registry decision, not a table rollback.

DROP TABLE IF EXISTS asset_depreciation_entries;
DROP TABLE IF EXISTS fixed_assets;
DROP TABLE IF EXISTS asset_categories;
