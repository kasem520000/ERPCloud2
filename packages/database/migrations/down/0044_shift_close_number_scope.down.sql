-- Down for 0044_shift_close_number_scope.sql — drops the tenant-wide counter this
-- migration seeded. The per-branch counters it replaced are left untouched, so a tenant
-- that reverts the code with the migration keeps numbering from its own history rather
-- than from zero.

DELETE FROM document_sequences
WHERE doc_type = 'shift_close'
  AND branch_id IS NULL;
