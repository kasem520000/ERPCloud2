# Optics pack (Phase 22 + Phase 09 part five)

Feature flag: `pack.optics`. Stores party prescriptions with typed JSON for the right and
left eye (`sph/cyl/axis/add/ipd`), the legacy `Other_Column` R/L grid, and — since Phase 09
part five — the ten captions of the boxes in the tenant's own words.

## Where it comes from

`Form_WPF/frmGlasses.xaml` («👓 بيانات النظارات») is one window with two tabs:

- **«👓  القياسات»** — two columns, «🔴 العين اليمنى (RE)» and «🟢 العين اليسرى (LE)», five
  boxes each. `bindClass` writes **two** rows — `orientation` `"R"` then `"L"` — into
  `Glasses(InvGlobalID, ItemId, orientation, SPH, CYL, AX, [ADD], IPD)`
  (`Class/InvoiceOper.cs` L1662), `glassOtions` (L3904) reads them back per invoice line,
  and `Class/Print.cs` L710 prints them as `ReSPH … ReIPD` / `LeSPH … LeIPD`. Nothing
  parses them: every value is a `VarChar`, so «PL» و«+1.25» و«-0.50 × 90» are all legitimate,
  and this module stores them as text for the same reason.
- **«⚙  أسماء الحقول»** — «حقل 1» … «حقل 5» under «R (Right)» and «حقل 6» … «حقل 10» under
  «L (Left)». The boxes of «👓  القياسات» are **not** named in the markup: `loadNameLbl`
  reads them at runtime —
  `select isnull(L1,'LE-SPH') … isnull(R5,'RE-IPD') from Other_Column` — and «💾 حفظ
  الأسماء» is `delete from Other_Column` followed by
  `insert into Other_Column (R1,R2,R3,R4,R5,L1,L2,L3,L4,L5)`, then «تم الحفظ بنجاح».
  `optics_field_labels` (migration `0056`) keeps that shape — ten named columns, one row
  per tenant, replaced rather than patched — and its column defaults are the code-behind's
  own fallbacks.

The window is opened from a sale invoice (`frmInvSale.glassesOptions` L2505, Alt+G), which
is why the desktop has no list of prescriptions: a وصفة is a child of an invoice line. The
cloud keeps `invoice_line_id` (قسم الطباعة reads it) but anchors the وصفة on a عميل, so
`GET /optics/prescriptions` is the door to the card.

## Endpoints

| Method | Path | Permission | What it is |
|---|---|---|---|
| GET | `/optics/prescriptions` | `optics.view` | the list; `?search=` picks a عميل (`mobile LIKE … OR name LIKE …`), `?partyId=` filters, `meta.total` و`meta.customer` come back with it |
| GET | `/optics/prescriptions/{id}` | `optics.view` | one وصفة |
| POST | `/optics/prescriptions` | `optics.manage` | «✔ إدراج» — refuses with «الرجاء اختيار عميل» |
| PATCH | `/optics/prescriptions/{id}` | `optics.manage` | «✏️ تعديل»; a stale `version` is a 409 `VERSION_CONFLICT` |
| DELETE | `/optics/prescriptions/{id}` | `optics.manage` | «🗑️ حذف» — hides the row, as `InvoiceOper` deletes a line's glasses with its invoice |
| GET | `/optics/field-labels` | `optics.view` | «⚙️ أسماء الحقول» — «حقل 1» … «حقل 10» with the tenant's names (or the defaults) |
| PUT | `/optics/field-labels` | `optics.manage` | «💾 حفظ الأسماء» — replaces the row; a blank box reads as its default |
| GET | `/optics/invoice-lines/{lineId}/print-section` | `optics.view` | قسم الطباعة — `title` و`rows` as before, plus `labels` و`right` و`left` |

## Tests

- `apps/api/test/optics-prescriptions.spec.ts` — 11 tests: the ten defaults, «💾 حفظ
  الأسماء» replacing the row, the ten text values, the refusals, the version conflict,
  «🔍 بحث», the list, the delete, قسم الطباعة, the permission split and tenant isolation.
- `scripts/verify-optics.mjs` — 33–34 live checks against a running stack; re-runnable and
  non-destructive (it deletes the وصفات it creates and restores «⚙️ أسماء الحقول»).

## Staff screens

`/optics/prescriptions` (the card, «🔄 جديد · ✔ إدراج · ✖ خروج») and `/optics/field-labels`
(«⚙️ أسماء الحقول», «💾 حفظ الأسماء · ✖ خروج»), both under the «👓 النظارات» module.
