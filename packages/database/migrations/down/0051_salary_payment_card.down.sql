-- Down for 0051_salary_payment_card.sql — the إذن صرف راتب.
--
-- What is lost: the رقم الإذن, the صندوق/بنك the money left through, the الموظف
-- المسؤول who signed, the method, the notes, and the snapshot of what was paid. The
-- vouchers that moved the money stay — they are treasury documents with their own
-- entries, and their `source_id` no longer resolves to anything, which is why the
-- service refuses to delete a payment whose voucher is still posted.
--
-- Payroll runs and their lines are untouched: the accrual (`POST .../post`) and the bulk
-- payment path (`POST .../pay`) survive the document going away.

DROP INDEX IF EXISTS salary_payments_tenant_employee_idx;
DROP INDEX IF EXISTS salary_payments_tenant_date_idx;
DROP INDEX IF EXISTS salary_payments_employee_month_key;
DROP INDEX IF EXISTS salary_payments_tenant_number_key;
DROP TABLE IF EXISTS salary_payments;
