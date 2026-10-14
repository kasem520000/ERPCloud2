-- 0092_price_list_unit.sql — R19 «قوائم أسعار واعية بالوحدات»
-- (`docs/desktop-parity/PHASE_05_INVENTORY.md` §13، والمؤجَّل المُسمّى «Unit-aware pricing lists»).
--
-- الديسكتوب يخزن السعر لكل وحدة: `ItemPrices` (`SmartAuditERP/Class/ItemPrices.cs`)
-- يحمل `UnitID` و`SalePrice`/`PurchPrice` و`WholesalePrice`/`ConsumerPrice`، و`ListItemunit.cs`
-- يبني `ProductUnit.UnitEquality`، و`ItemOper.cs` L744/L2523 يقرأ السعر بالوحدة.
-- والسحابة كانت تملك نصفها: `item_units.sale_price`/`purchase_price` لكل وحدة، لكن
-- `price_list_items` كان يحمل `item_id` و`unit_price` و`min_qty` فقط — بلا وحدة.
-- فلا تستطيع قائمة أسعار أن تقول «علبة 12 بـ120» و«حبة بـ12» معاً.
--
-- هذا الترحيل يضيف `unit_id` إلى `price_list_items`، اختيارياً، مع فهرس جزئي،
-- وFK إلى `units_of_measure` مع `SET NULL` (الوحدة المحذوفة لا تُبطل السعر، بل يعود
-- إلى سعر الصنف الأساسي).
--
-- آمن للإعادة: `IF NOT EXISTS` و`WHERE NOT EXISTS` للفهرس، والعمود NULL-able.

ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units_of_measure(id) ON DELETE SET NULL;

-- القديم كان (price_list_id, coalesce(item_id, nil), min_qty) بلا وحدة — فلا تستطيع قائمة
-- أن تحمل «حبة بـ10» و«علبة 12 بـ120» معاً لنفس الصنف ونفس الشريحة. نستبدله بآخر يحمل الوحدة.
DROP INDEX IF EXISTS price_list_items_scope_key;
CREATE UNIQUE INDEX IF NOT EXISTS price_list_items_scope_key
  ON price_list_items (
    price_list_id,
    coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
    min_qty
  );

CREATE INDEX IF NOT EXISTS price_list_items_unit_idx
  ON price_list_items (tenant_id, unit_id) WHERE unit_id IS NOT NULL;

-- فهرس مركب للبحث السريع عن سعر صنف/وحدة/شريحة كمية داخل قائمة
CREATE INDEX IF NOT EXISTS price_list_items_item_unit_qty_idx
  ON price_list_items (price_list_id, item_id, unit_id, min_qty);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'price_list_items' AND column_name = 'unit_id'
  ) THEN
    RAISE EXCEPTION '0092: price_list_items.unit_id was not created';
  END IF;
END $$;

-- PROJECT_CONTRACT §13.4
ALTER ROLE erp_api NOBYPASSRLS;
