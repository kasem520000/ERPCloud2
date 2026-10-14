-- Phase 09 part five — 👓 النظارات (`Form_WPF/frmGlasses.xaml` + `Class/InvoiceOper.cs`).
--
-- `Form_WPF/frmGlasses.xaml` («👓 بيانات النظارات») is two tabs behind one header:
--
--   • «👓  القياسات» — two columns, «🔴 العين اليمنى (RE)» and «🟢 العين اليسرى (LE)»,
--     five boxes each. The boxes are **not** named in the markup: `loadNameLbl` reads
--     them at runtime —
--     `select isnull(L1,'LE-SPH'), isnull(L2,'LE-CYL'), isnull(L3,'LE-AX'),
--      isnull(L4,'LE-ADD'), isnull(L5,'LE-IPD'), isnull(R1,'RE-SPH'),
--      isnull(R2,'RE-CYL'), isnull(R3,'RE-AX'), isnull(R4,'RE-ADD'),
--      isnull(R5,'RE-IPD') from Other_Column` — and writes them into the labels. So the
--     ten defaults in this migration are the code-behind's own words, and the tenant may
--     rename every one of them.
--   • «⚙  أسماء الحقول» — ten boxes, «حقل 1»…«حقل 5» under «R (Right)» and
--     «حقل 6»…«حقل 10» under «L (Left)», saved by «💾 حفظ الأسماء»:
--     `delete from Other_Column` then
--     `insert into Other_Column (R1,R2,R3,R4,R5,L1,L2,L3,L4,L5) VALUES(...)`, then
--     «تم الحفظ بنجاح». Note the mapping: حقل 6…10 are the **left** eye (L1…L5).
--   • The two tabs are not both visible: `frmGlasses_Load` shows «⚙ أسماء الحقول» and
--     «💾 حفظ الأسماء» only when the window is opened from the definitions entry
--     (`code != 1`); opened from a sale invoice (`code = 1`) it is the قياسات alone, with
--     «🔄 جديد» (CLR) · «✔ إدراج» (bindClass then Close) · «✖ خروج».
--
-- Where the numbers live: `InvoiceOper` writes the two rows of
-- `Glasses(InvGlobalID, ItemId, orientation, SPH, CYL, AX, [ADD], IPD)` — one with
-- `orientation = 'R'` and one with `'L'` (L1656–L1672), reads them back per line in
-- `glassOtions` L3904, deletes them with the invoice (L1517), and prints them as
-- `ReSPH · ReCYL · ReAX · ReADD · ReIPD` / `LeSPH · …` (`Class/Print.cs` L710). The
-- entry point is `frmInvSale.glassesOptions` L2505 (Alt+G), which refuses with
-- «الرجاء إضافة صنف للفاتورة» and «الرجاء وضع المؤشر على الصنف».
--
-- Two decisions, because the cloud's prescription is one row, not two:
--
--   1. `optical_prescriptions` already carries **both** eyes (`rightEye` · `leftEye`), so
--      this migration adds nothing to it. Its `orientation` is the prescription's kind
--      (بعيد/قريب), which is a different thing from the desktop's `orientation` column —
--      that one is *which eye* the row belongs to. Both meanings are kept, and the API
--      names them apart: `rightEye` / `leftEye` for the eyes, `orientation` for the kind.
--   2. `optics_field_labels` keeps `Other_Column`'s shape — ten named columns and one
--      row per tenant — because «💾 حفظ الأسماء» replaces the row, it does not edit a
--      field of it. The defaults live in the column defaults themselves, exactly as
--      `isnull(...)` supplies them; nothing is seeded, and a tenant that never opens the
--      window still reads «RE-SPH» … «LE-IPD».

-- ⚙️ أسماء الحقول — `Other_Column(R1,R2,R3,R4,R5,L1,L2,L3,L4,L5)`
CREATE TABLE IF NOT EXISTS optics_field_labels (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE cascade,
  r1 text NOT NULL DEFAULT 'RE-SPH',
  r2 text NOT NULL DEFAULT 'RE-CYL',
  r3 text NOT NULL DEFAULT 'RE-AX',
  r4 text NOT NULL DEFAULT 'RE-ADD',
  r5 text NOT NULL DEFAULT 'RE-IPD',
  l1 text NOT NULL DEFAULT 'LE-SPH',
  l2 text NOT NULL DEFAULT 'LE-CYL',
  l3 text NOT NULL DEFAULT 'LE-AX',
  l4 text NOT NULL DEFAULT 'LE-ADD',
  l5 text NOT NULL DEFAULT 'LE-IPD',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid
);

-- «💾 حفظ الأسماء» replaces the row — `delete from Other_Column` then insert — so there
-- is one row per tenant, never two.
CREATE UNIQUE INDEX IF NOT EXISTS optics_field_labels_tenant_key
  ON optics_field_labels (tenant_id)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE optics_field_labels IS
  '⚙️ أسماء الحقول (`Other_Column`) — عناوين الصناديق العشرة في «👓 القياسات»؛ حقل 6…10 هي العين اليسرى (L1…L5)';
