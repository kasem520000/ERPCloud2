-- Phase 09 part three — 🧾 فاتورة التفصيل (`Form_WPF/frmViewOrders.xaml` + `AddNewSizes.xaml`).
--
-- `Form_WPF/frmViewOrders.xaml` («عرض الطلبات - ViewOrders») is one search box over one
-- grid:
--
--   • `txtPhoneNum` — «🔍 الهاتف أو اسم العميل...» with «🔍 عرض» (`Button1_Click`),
--     searching as you type (`txtPhoneNum_TextChanged`).
--   • the grid — `📋 رقم الفاتورة · 👤 الاسم · 📱 الجوال · 📅 التاريخ · 💰 الإجمالي ·
--     ✅ المدفوع · ⏳ الباقي · 📌 الحالة · 👁️ عرض`, and «النتائج: {n}» (`lblResultCount`).
--
-- `frmViewOrders.xaml.cs` is where the arithmetic lives:
--
--   • `SearchInData` L55 — `SELECT code, name, phone_num, Date, sale_price, state FROM
--     Inv_Tailor` with `WHERE phone_num LIKE @search OR name LIKE @search ORDER BY code`.
--   • 💰 الإجمالي is **not** the stored price: `salePriceWithTax = sale_price +
--     sale_price * 5.0 / 100.0` (L88) — the same 5% that `AddNewSizes.CreateInvoice`
--     L419 hands to the point of sale as `txtTotVAT`.
--   • ✅ المدفوع is `SELECT paid FROM Inv_Sub_Tailor WHERE inv_code=@code` (L130), and
--     ⏳ الباقي = الإجمالي − المدفوع (L90).
--   • `GetStateText` L119 — `0 مستلم · 1 في الخياطة · 2 جاهز · default تم التسليم`.
--   • `👁️ عرض` opens `AddNewSizes.showResult(code)` (L156).
--
-- `Form_WPF/AddNewSizes.xaml` («إضافة مقاس جديد») is the card that writes `Inv_Tailor`:
--
--   • «📋 البيانات الأساسية» — `👤 اسم العميل` · `📞 رقم الجوال` · `👔 نوع الثوب`
--     (`سعودي · بحريني · اماراتي · كويتي`) · `🔢 العدد` · `💰 السعر` · `💵 الإجمالي` ·
--     `✅ الحالة` (with its own `✔` save button, `stateSaveBtN_Click` L761).
--   • `CalculateTotalPrice` L860 — `الإجمالي = السعر × العدد` and a second box showing
--     `الإجمالي × 1.05`.
--   • `btnSave_Click` L191 — two refusals in the window's own words:
--     «برجاء اختيار العميل» and «يرجي إدخال السعر» (when الإجمالي is `0`).
--   • `InsertNewTailorInvoice` L256 —
--     `insert into Inv_Tailor(code, name, quantity, phone_num, Date, sale_price, state,
--     type, bill) values(..., 0)`, and `Inv_Sub_Tailor` L278 carries the 📐 المقاسات
--     (39 columns) plus `paid`.
--   • «⚙️ لوحة التحكم» — `جديد · حفظ · مكرر · فاتورة · طباعه · إستلام دفعة`. «إستلام دفعة»
--     L664 opens the treasury window (`frmSandQ` with `ISTailor = true`) pre-filled with
--     المتبقي and the note «تم استلام دفعة من عملية رقم {code}».
--
-- Part two gave the cloud the **طلب** (`TailoringOrders`). This part gives it the
-- **فاتورة** the tailor actually bills and gets paid against — a different document, on a
-- different table, with its own number and its own lifecycle. No column or endpoint that
-- already exists is renamed or removed.
--
-- Three decisions, because the desktop stores more than it names:
--
--   1. `state` is an **int index** in the desktop (`stateCB.SelectedIndex`) whose words
--      live in `GetStateText`. Migration `0053` seeded those four words as the tenant's
--      `tailoring_order_statuses`, and the invoice points at the same rows: one lifecycle,
--      named once, instead of a second list that would drift.
--   2. 👔 `type` (`نوع الثوب`) is a second index whose four words *are* in the repository
--      (`typeCB`'s `ComboBoxItem`s: سعودي · بحريني · اماراتي · كويتي). They are seeded
--      into `tailoring_garment_types`, which is a different thing from `tailoring_types`
--      (نوع التفصيل, `frmOrderDetails`) — a type says *what* is sewn, a garment style says
--      *how*.
--   3. The 39 measurement columns of `Inv_Sub_Tailor` become one `jsonb` column keyed by
--      the desktop's own column names (`height1`, `shoulder`, `neckShape`, …), the same
--      choice the cloud already made for `customer_measurements`. Their Arabic labels are
--      not data — they are the `Label Content` of `AddNewSizes.xaml`, and the API serves
--      them as a field catalogue so the screen can render «الطول» · «الكتف» · «شكل اليد»
--      instead of guessing.

-- 👔 نوع الثوب — `typeCB` in `AddNewSizes.xaml` L423
CREATE TABLE IF NOT EXISTS tailoring_garment_types (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE cascade,
  code text NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS tailoring_garment_types_tenant_code_key
  ON tailoring_garment_types (tenant_id, code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS tailoring_garment_types_tenant_idx
  ON tailoring_garment_types (tenant_id, display_order);

-- 👔 الأنواع الأربعة التي يعرفها الديسكتوب: سعودي · بحريني · اماراتي · كويتي
INSERT INTO tailoring_garment_types (id, tenant_id, code, name_ar, display_order)
SELECT
  gen_random_uuid(), tenants.id, seed.code, seed.name_ar, seed.display_order
FROM tenants
CROSS JOIN (
  VALUES ('saudi', 'سعودي', 1),
         ('bahraini', 'بحريني', 2),
         ('emirati', 'اماراتي', 3),
         ('kuwaiti', 'كويتي', 4)
) AS seed (code, name_ar, display_order)
WHERE NOT EXISTS (
  SELECT 1 FROM tailoring_garment_types existing
   WHERE existing.tenant_id = tenants.id AND existing.code = seed.code
);

-- 🧾 فاتورة التفصيل — `Inv_Tailor(code, name, quantity, phone_num, Date, sale_price, state, type, bill)`
CREATE TABLE IF NOT EXISTS tailoring_invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE cascade,
  number text NOT NULL,
  party_id uuid REFERENCES parties (id) ON DELETE restrict,
  customer_name text NOT NULL,
  phone text,
  invoice_date date NOT NULL,
  quantity numeric(20, 4) NOT NULL DEFAULT 1,
  unit_price numeric(20, 4) NOT NULL DEFAULT 0,
  total numeric(20, 4) NOT NULL DEFAULT 0,
  paid_amount numeric(20, 4) NOT NULL DEFAULT 0,
  status_id uuid NOT NULL REFERENCES tailoring_order_statuses (id) ON DELETE restrict,
  garment_type_id uuid REFERENCES tailoring_garment_types (id) ON DELETE set null,
  -- `bill` — «فاتورة» في لوحة التحكم تفتح نقطة البيع؛ 0 ما لم تُحوَّل.
  billed boolean NOT NULL DEFAULT false,
  measurements jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS tailoring_invoices_tenant_number_key
  ON tailoring_invoices (tenant_id, number)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS tailoring_invoices_tenant_date_idx
  ON tailoring_invoices (tenant_id, invoice_date DESC);

CREATE INDEX IF NOT EXISTS tailoring_invoices_tenant_party_idx
  ON tailoring_invoices (tenant_id, party_id);

CREATE INDEX IF NOT EXISTS tailoring_invoices_tenant_name_idx
  ON tailoring_invoices (tenant_id, customer_name);

CREATE INDEX IF NOT EXISTS tailoring_invoices_tenant_status_idx
  ON tailoring_invoices (tenant_id, status_id);

COMMENT ON COLUMN tailoring_invoices.total IS
  '💵 الإجمالي = 💰 السعر × 🔢 العدد (`CalculateTotalPrice` L860) — بلا الضريبة؛ و«💰 الإجمالي» في `frmViewOrders` هو هذا × 1.05';
COMMENT ON COLUMN tailoring_invoices.paid_amount IS
  '✅ المدفوع — `Inv_Sub_Tailor.paid` (L130)؛ و⏳ الباقي = (الإجمالي × 1.05) − المدفوع';
COMMENT ON COLUMN tailoring_invoices.measurements IS
  '📐 المقاسات — أعمدة `Inv_Sub_Tailor` التسعة والثلاثون بأسمائها كما في الديسكتوب (height1 · shoulder · neckShape …)';

-- 💵 إستلام دفعة — ما يربط الفاتورة بسند القبض الذي يفتحه الديسكتوب (`frmSandQ`, L664)
CREATE TABLE IF NOT EXISTS tailoring_invoice_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE cascade,
  invoice_id uuid NOT NULL REFERENCES tailoring_invoices (id) ON DELETE cascade,
  voucher_id uuid REFERENCES vouchers (id) ON DELETE set null,
  amount numeric(20, 4) NOT NULL,
  paid_at date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE INDEX IF NOT EXISTS tailoring_invoice_payments_invoice_idx
  ON tailoring_invoice_payments (tenant_id, invoice_id, paid_at);

COMMENT ON COLUMN tailoring_invoice_payments.voucher_id IS
  'سند القبض — «تم استلام دفعة من عملية رقم {code}» (`AddNewSizes` L683)؛ يُترك فارغاً إن سُجّلت الدفعة بلا صندوق';
