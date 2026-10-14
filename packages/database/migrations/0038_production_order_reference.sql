-- Phase 05 part six — the production order's own header.
--
-- `frmProductionOrder.xaml` asks for three things the order could not remember:
-- `📄 رقم المرجع` + `📅 تاريخ المرجع` (the document this build answers, usually a
-- sales order or a workshop request) and `📐 الوحدة` the produced quantity was
-- counted in. All three are additive and nullable — an existing order keeps the
-- base unit and no reference.
--
-- No default is forced onto `unit_id`: the base unit is resolved at read time from
-- the output item, so a row that predates this migration stays valid.

ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS reference_no text;

ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS reference_date date;

ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units_of_measure (id);

COMMENT ON COLUMN production_orders.reference_no IS
  '📄 رقم المرجع — the document this production order answers';
COMMENT ON COLUMN production_orders.reference_date IS
  '📅 تاريخ المرجع — the date of the referenced document';
COMMENT ON COLUMN production_orders.unit_id IS
  '📐 الوحدة — the unit the produced quantity was counted in; null means the item base unit';

-- A reference is always read together with the order; the unit is read per row.
CREATE INDEX IF NOT EXISTS production_orders_reference_idx
  ON production_orders (tenant_id, reference_no)
  WHERE reference_no IS NOT NULL;
