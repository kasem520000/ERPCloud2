-- down/0085_membership_discount_limits.down.sql — عكس 0085 حرفياً: يُزيل ما أُضيف ولا يمسّ ما قبله.
--
-- والقيود تُحذف مع العمود تلقائياً، لكنّ الحذف صريحٌ كما في بقية ملفّات `down/`: مَن يقرأ
-- الملفّ يعرف ما يعود بالضبط.

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_max_discount_amount_check;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_max_discount_pct_check;

ALTER TABLE memberships DROP COLUMN IF EXISTS max_discount_amount;
ALTER TABLE memberships DROP COLUMN IF EXISTS max_discount_pct;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
