-- Phase 07 part five — 🗂️ إدارة الفترات المحاسبية: the two fields the desktop's period
-- card carries and the cloud's fiscal period does not.
--
-- `Form_WPF/FrmAccountingPeriods.xaml` («إدارة الفترات المحاسبية») lays out, above its
-- grid: `رقم الفترة:` (read-only) · `اسم الفترة:` · `تاريخ من:` · `تاريخ إلى:` ·
-- `✔️ فترة نشطة حالياً` · `ملاحظات:`, and the grid itself is
-- `الرقم · اسم الفترة · تاريخ البداية · تاريخ النهاية · نشطة · مغلقة · أغلقت بواسطة ·
-- تاريخ الإغلاق · ملاحظات`.
--
-- `Class/AccountingPeriod.cs` is the row behind it: `PeriodID · PeriodName · StartDate ·
-- EndDate · IsActive · IsClosed · ClosedBy · ClosedDate · Notes · CreatedDate`, and
-- `Class/AccountingPeriodManager.cs` is every SQL statement the window runs:
--
--   • `AddPeriod`  — refuses an overlap («يوجد تداخل في التواريخ مع فترة محاسبية أخرى»)
--                    and deactivates every other period when the new one is active.
--   • `ClosePeriod`— `IsClosed = 1, ClosedBy = @User, ClosedDate = @Date, IsActive = 0`.
--   • `ReopenPeriod` / `ActivatePeriod` — the latter refuses a closed period
--                    («لا يمكن تفعيل فترة محاسبية مغلقة»).
--   • `GetAllPeriods` — `ORDER BY StartDate DESC`.
--
-- Of those ten columns the cloud already stores the id, the name, both dates, the
-- `open`/`closed` status and `closed_by` / `closed_at`. What is missing is `Notes` and
-- `IsActive` — the two the window writes and nothing in the cloud can hold.
--
-- Both are additive: `notes` is nullable and `is_active` defaults to false, so every
-- period already on the books keeps its meaning (no period is active until an accountant
-- activates one), and a caller that sends neither is unaffected.
--
-- `الرقم` needs no column: the desktop's `PeriodID` is an identity the operator cannot
-- edit, and the cloud's ordinal within the fiscal year is the same thing — read-only and
-- derived by `listPeriods` from the period's date order.

ALTER TABLE fiscal_periods
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN fiscal_periods.notes IS
  'ملاحظات — `FrmAccountingPeriods.xaml` TxtNotes; NULL when the accountant wrote none';
COMMENT ON COLUMN fiscal_periods.is_active IS
  '✔️ فترة نشطة حالياً — `FrmAccountingPeriods.xaml` ChkIsActive; at most one per tenant, and never a closed one';

-- ⚡ تفعيل is a single choice: activating one period deactivates every other. The
-- desktop does it with `UPDATE AccountingPeriods SET IsActive = 0`; this is the same
-- promise enforced where it cannot be forgotten.
CREATE UNIQUE INDEX IF NOT EXISTS fiscal_periods_one_active_idx
  ON fiscal_periods (tenant_id)
  WHERE is_active;
