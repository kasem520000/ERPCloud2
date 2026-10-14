-- Phase 09 part nine — ⛵ المرسى: ➕ الإضافات (`Form_WPF/frmAdditions.xaml` «📋 إضافات»,
-- لوحته «📋 إدارة الإضافات»).
--
-- `frmAdditions` is the smallest window in the vertical, and the only one whose table the
-- desktop never fills by hand: `Additions(id, name, SalePrice, IsDeleted)` is read by
-- `frmBookingM` through «🎁 الإضافات» (`cmbAdditions`) and written here.
--
--   select id, Name from Additions where IsDeleted=0                    -- LoadAdditions
--   select SalePrice from Additions where IsDeleted=0 and id=…          -- عند الاختيار
--   select * from Additions where IsDeleted=0 and id=…                  -- Add2Dgv
--   insert into Additions(name, SalePrice, IsDeleted) values(…, …, 0)   -- «💾 حفظ»
--   update Additions set name=…, SalePrice=… where id=…                 -- «💾 حفظ» على قديم
--   delete from Additions where id=…                                    -- «🗑️ حذف»
--
-- and the window's three sentences:
--
--   «يجب إدخال اسم الإضافة ⚠️»          — لا اسم ⇒ لا حفظ
--   «يجب تحديد الإضافة المراد حذفها ⚠️» — لا تحديد ⇒ لا حذف
--   «هل أنت متأكد من حذف هذه الإضافة؟ 🗑️» — تأكيد الحذف
--
-- plus the two that follow a successful save: «✅ تم الحفظ بنجاح» و«✅ تم حفظ التعديلات
-- بنجاح», و«✅ تم الحذف بنجاح» بعد الحذف.
--
-- `frmBookingM` («الحجوزات») is the other half of this part, and the reason the table is
-- worth carrying over at all:
--
--   «🎁 الإضافات» (cmbAdditions) · «الكمية» (txtQuant) · «السعر» (txtAdditPrice) ·
--   «الإجمالي» (txtAdditiTot, read-only) · «➕» (btnAddObj, «إضافة صنف جديد» → frmAdditions)
--
--   cmbAdditions_SelectionChanged → txtAdditPrice = SalePrice
--   txtQuant_TextChanged          → txtAdditiTot  = ROUND(price × quant, 2)
--   Add2Dgv                       → «يجب إدخال الكمية  » when the box is empty, and an
--                                   إضافة already in the grid has its كمية **added** to
--                                   the row that is there (`Quantity += quant`)
--   insert into BookingAddition(bookId, AditionID, Price, quanty, notes, IsDeleted)
--
-- Two things this migration adds, then:
--
--   1. `marina_additions` — the تعريف of every إضافة: 🔢 الرقم · 📝 الاسم · 💰 القيمة.
--   2. `marina_booking_additions.addition_id` — `BookingAddition.AditionID`, so a line of
--      «🎁 الإضافات» points at what it came from instead of copying only its name. The
--      desktop copies the name and keeps the id; both are kept here.

-- ➕ الإضافة — `Additions(id, name, SalePrice, IsDeleted)`.
CREATE TABLE IF NOT EXISTS marina_additions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 🔢 الرقم — `txtNo` (read-only عند الديسكتوب: `IsReadOnly="True"`).
  number integer NOT NULL,
  -- 📝 الاسم — `txtName`؛ «يجب إدخال اسم الإضافة ⚠️» إن كان فارغاً.
  name text NOT NULL,
  -- 💰 القيمة — `SalePrice`؛ صندوقٌ فارغٌ يصير صفراً (`txtSalePrice.Text = "0"`).
  sale_price numeric(20, 4) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'SAR',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS marina_additions_tenant_number_key
  ON marina_additions (tenant_id, number)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS marina_additions_tenant_name_idx
  ON marina_additions (tenant_id, name)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE marina_additions IS '➕ الإضافات — `Additions` من `Form_WPF/frmAdditions.xaml` («📋 إضافات»)؛ تقرأها «🎁 الإضافات» في `frmBookingM`';
COMMENT ON COLUMN marina_additions.number IS '🔢 الرقم — يقابله عند الديسكتوب `id` الذي يعرضه «🔢 الرقم» بعد الحفظ';
COMMENT ON COLUMN marina_additions.sale_price IS '💰 القيمة — `Additions.SalePrice`؛ منها يُملأ «السعر» عند اختيار الإضافة في الحجز';

-- `BookingAddition.AditionID` — ما اختاره المشغّل من «🎁 الإضافات».
ALTER TABLE marina_booking_additions ADD COLUMN IF NOT EXISTS addition_id uuid REFERENCES marina_additions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS marina_booking_additions_addition_idx
  ON marina_booking_additions (tenant_id, addition_id)
  WHERE addition_id IS NOT NULL;

COMMENT ON COLUMN marina_booking_additions.addition_id IS '➕ الإضافة — `BookingAddition.AditionID`؛ تعريف الإضافة التي أُنشئ منها هذا الصف';

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['marina_additions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
  EXECUTE format(
    'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
    t, t
  );
END LOOP; END $$;
