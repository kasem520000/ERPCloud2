-- Phase 06 — 🔢 الرقم: one numbering series for the whole tenant.
--
-- `0042` put a `number` on `shift_closes` and made it unique per **tenant**
-- (`shift_closes_number_key`), but the sequence that allocates it was scoped per
-- **branch**. Two branches therefore both issued `CS-000001`, and the second close of
-- the pair failed with a duplicate-key 500 — a cashier in branch 2 could not close her
-- drawer because a cashier in branch 1 had closed his.
--
-- The number is now allocated tenant-wide (`sequences.next({ tenantId, docType })` with
-- no branch), which is also what the desktop's global `CasherClosed.ClosedID` is. This
-- migration seeds that tenant-wide counter from the highest number each tenant has
-- already issued, so moving the scope can never re-issue a number that exists on a
-- printed close.

INSERT INTO document_sequences (
  id, tenant_id, branch_id, doc_type, fiscal_year_id, prefix, padding, current_value, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  closes.tenant_id,
  NULL,
  'shift_close',
  NULL,
  'CS-',
  6,
  COALESCE(MAX(NULLIF(regexp_replace(closes.number, '\D', '', 'g'), '')::bigint), 0),
  now(),
  now()
FROM shift_closes closes
WHERE closes.number IS NOT NULL
GROUP BY closes.tenant_id
ON CONFLICT (
  tenant_id,
  coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
  doc_type,
  coalesce(fiscal_year_id, '00000000-0000-0000-0000-000000000000'::uuid)
)
DO UPDATE
SET current_value = GREATEST(document_sequences.current_value, EXCLUDED.current_value),
    updated_at = now();
