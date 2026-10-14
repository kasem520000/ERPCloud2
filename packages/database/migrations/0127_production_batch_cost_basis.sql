-- 0127_production_batch_cost_basis.sql
--
-- 💵 أساس تكلفة دفعة الإنتاج — a fact written when the batch is created, not a guess read back
-- from "is there a linked order?".
--
-- Why now: a production batch must have a real source of materials (قائمة مواد أو مكوّنات — see
-- `createProductionBatch`, 422 `VAN_PRODUCTION_INPUT_REQUIRED`), so from this change on **every**
-- batch carries a `production_order_id` or a `manufacturing_order_id`. The screen used to infer the
-- cost basis from exactly that link:
--
--     cost_basis = linked order ? 'manufacturing_order' : 'manual_input_or_item_cost'
--
-- which was a fair inference while the link was optional, and becomes a false statement the moment
-- the link is mandatory: a batch whose materials left the shelf at zero value (رصيد افتتاحي بلا
-- تسعير، ماء وملح بلا تكلفة) is costed by the accountant's typed number or by the item card, yet the
-- screen would read «تكلفة فعلية من أمر تصنيع» — and, with it, «الفاقد محمّل على تكلفة المنتج
-- الجيد», which is only true when the order's own cost was used.
--
-- The service already computes the true basis (`manufacturing_order` | `manual_input` |
-- `item_cost`) at creation time; this column is where it is kept.
--
-- No backfill on purpose: a NULL means "a batch written before this column existed", and for those
-- rows the screen falls back to the old derivation, which is the most that can honestly be said
-- about a historical row. Writing a guessed basis into history would make the two cases
-- indistinguishable forever.

ALTER TABLE factory_production_batches
  ADD COLUMN IF NOT EXISTS cost_basis text
    CHECK (cost_basis IS NULL OR cost_basis IN ('manufacturing_order', 'manual_input', 'item_cost'));

COMMENT ON COLUMN factory_production_batches.cost_basis IS
  'أساس تكلفة الوحدة المسجّلة على الدفعة: manufacturing_order = تكلفة فعلية من أمر تصنيع/إنتاج رسمي (قيمة مواد موجبة)، manual_input = تكلفة أدخلها المستخدم، item_cost = تكلفة بطاقة الصنف. NULL = دفعة سابقة لهذا العمود (تُقرأ بالاستنتاج القديم).';
