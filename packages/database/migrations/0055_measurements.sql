-- Phase 09 part four — 📏 القياسات (`Form_WPF/frmMeasurements.xaml` +
-- `Form_WPF/frmMeasurementDetails.xaml` + `Form_WPF/frmMeasurementAttributes.xaml`).
--
-- Three windows, and the cloud only had a `jsonb` blob:
--
--   • `frmMeasurements.xaml` («إدارة قياسات العملاء») — a search box
--     «البحث برقم الجوال أو الاسم:» with the watermark «🔍 الجوال أو الاسم...» and
--     «🔍 بحث» (`btnSearch_Click` / `txtSearch_KeyDown` on Return). The search picks a
--     **customer** — `SELECT TOP 10 id, name, mobile FROM Customers WHERE mobile LIKE
--     @Search OR name LIKE @Search ORDER BY name` — takes the first row, shows
--     «العميل: …» «الجوال: …» (`pnlCustomerInfo`) and lists that customer's قياسات.
--     With no customer the grid is `LoadAllMeasurements`: every active قياس with its
--     customer, `ORDER BY cm.MeasurementDate DESC`.
--   • The grid «📋 قياسات العميل» — `👤 اسم صاحب القياس · 📅 التاريخ · 📝 الملاحظات ·
--     📐 عدد المقاسات · العميل` (الرقم hidden), a double-click being «✏️ تعديل القياس».
--   • The buttons — `➕ إضافة قياس جديد · ✏️ تعديل القياس · 🗑️ حذف القياس · ✖ إغلاق`,
--     and four refusals in the window's own words: «الرجاء إدخال رقم الجوال أو اسم
--     العميل» (empty search) · «لم يتم العثور على عميل» · «الرجاء البحث عن عميل أولًا»
--     (➕ without a customer) · «الرجاء اختيار قياس للتعديل»/«للحذف».
--
-- `frmMeasurementDetails.xaml` («📏 بيانات القياس») is the card: «👤 اسم صاحب القياس *»,
-- «📐 قيم القياسات» — a row per **active** attribute, built at runtime from
-- `SELECT AttributeID, AttributeName FROM MeasurementAttributes WHERE IsActive = 1
-- ORDER BY DisplayOrder`, each with the unit «سم» — and «📝 ملاحظات». `btnSave_Click`
-- refuses twice: «الرجاء إدخال اسم صاحب القياس» and «الرجاء إدخال قياس واحد على الأقل»
-- (a value counts only when it parses to a decimal > 0). Saving is one transaction:
-- INSERT/UPDATE `CustomerMeasurements`, `DELETE FROM MeasurementValues WHERE
-- MeasurementID=@ID` on update, then one INSERT per value > 0.
--
-- `frmMeasurementAttributes.xaml` («📏 إدارة خصائص القياسات») is the definitions window:
-- `📝 اسم الخاصية · 🔢 الترتيب · ⚙️ الحالة` (`CASE WHEN IsActive = 1 THEN 'نشط' ELSE
-- 'معطل' END`) with `➕ إضافة · ✏️ تعديل · 🔕 تعطيل · ▲ تحريك للأعلى · ▼ تحريك للأسفل ·
-- ✖ إغلاق`. A new خاصية takes `ISNULL(MAX(DisplayOrder), 0) + 1`; تعطيل is
-- `IsActive = 0` («سيتم إخفاؤها من القياسات الجديدة»), never a delete; and ▲▼ **swap**
-- `DisplayOrder` with the neighbour.
--
-- Three decisions, because the desktop stores more than it names:
--
--   1. The 39 tailor's columns of part three (`Inv_Sub_Tailor`) and the tenant's
--      خصائص here are different things: the first are fixed by the فاتورة screen, the
--      second are the tenant's own list — the قياس card is **built from them at
--      runtime**, so a tenant that adds «طول الكم» gets a box for it without a release.
--      Values are keyed by attribute **id**, not by its Arabic name, so renaming a
--      خاصية never orphans the numbers already taken.
--   2. The three seeded خصائص (الطول · العرض · الكم) are the repository's own words:
--      they are the example inside the add prompt itself —
--      «أدخل اسم الخاصية (مثل: الطول، العرض، الكم)» (`frmMeasurementAttributes.xaml.cs`
--      `btnAdd_Click`). Rows of `MeasurementAttributes` are data, not code, and they
--      are not in this repository; these three are the only ones it ever names.
--   3. `customer_measurements.measurements` stays `jsonb` and keeps its free-form keys
--      (`height` · `shoulder` …), because `frmCustomers.xaml` L1184 «📐 المقاسات» stores
--      fixed columns of its own (الطول · كتف · الرقبة · وسع اليد · وسع الخطوة · رقم
--      الصفحة) on the same document and the cloud has carried them as keys since the
--      beginning. Nothing already written is renamed or dropped: this migration only
--      **adds** `name` و`measurement_date` and a new definitions table.

-- 📏 خصائص القياسات — `MeasurementAttributes(AttributeID, AttributeName, DisplayOrder, IsActive)`
CREATE TABLE IF NOT EXISTS tailoring_measurement_attributes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE cascade,
  name_ar text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS tailoring_measurement_attributes_tenant_name_key
  ON tailoring_measurement_attributes (tenant_id, name_ar)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS tailoring_measurement_attributes_tenant_idx
  ON tailoring_measurement_attributes (tenant_id, display_order);

-- 📏 الخصائص الثلاث التي يسمّيها الديسكتوب نفسه في مثاله: الطول · العرض · الكم
INSERT INTO tailoring_measurement_attributes (id, tenant_id, name_ar, display_order)
SELECT
  gen_random_uuid(), tenants.id, seed.name_ar, seed.display_order
FROM tenants
CROSS JOIN (
  VALUES ('الطول', 1),
         ('العرض', 2),
         ('الكم', 3)
) AS seed (name_ar, display_order)
WHERE NOT EXISTS (
  SELECT 1 FROM tailoring_measurement_attributes existing
   WHERE existing.tenant_id = tenants.id AND existing.name_ar = seed.name_ar
);

-- 👤 اسم صاحب القياس و📅 التاريخ — `CustomerMeasurements(MeasurementName, MeasurementDate)`
ALTER TABLE customer_measurements ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE customer_measurements ADD COLUMN IF NOT EXISTS measurement_date date;

-- «قياس بتاريخ …» (`frmOrderDetails.LoadCustomerMeasurements` L259) is what the grid
-- shows when 👤 اسم صاحب القياس is null — so the column is nullable, and rows written
-- before this migration keep working.
COMMENT ON COLUMN customer_measurements.name IS
  '👤 اسم صاحب القياس — `MeasurementName` (`frmMeasurements` · `frmMeasurementDetails`)؛ و«قياس بتاريخ …» بديله إن كان فارغاً';
COMMENT ON COLUMN customer_measurements.measurement_date IS
  '📅 التاريخ — `MeasurementDate`، يُملأ بتاريخ اليوم عند الإنشاء ويُرتَّب به تنازلياً';
COMMENT ON COLUMN customer_measurements.measurements IS
  '📐 قيم القياسات — مفاتيحها معرّفات `tailoring_measurement_attributes` (أو مفاتيح حرّة قديمة: height · shoulder …)';

CREATE INDEX IF NOT EXISTS customer_measurements_tenant_date_idx
  ON customer_measurements (tenant_id, measurement_date DESC, created_at DESC);
