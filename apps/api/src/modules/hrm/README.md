# HRM & Payroll Pack

Phase 20 is gated by tenant setting `pack.hrm`. The pack manages departments, jobs,
employees, raw attendance logs, salary adjustments, payroll runs and payslips.

Computation order:

1. Sum configured employee salary components (`basic`, `housing`, `food`, `travel`,
   `medical`, or tenant-specific keys).
2. Optionally apply the unpaid-days factor: `(daysInMonth - unpaidDays) / daysInMonth`.
3. Add approved additions valid for the run month.
4. Subtract approved deductions valid for the run month.
5. Clamp net pay at zero and persist the preview into immutable run lines.

Attendance import accepts CSV columns `machine,enroll,datetime,inout`. The first version
stores raw punches and offers a naïve in/out pairing summary only; no RC-10 biometric
rules engine or live device communication is included.

Posted payroll runs are immutable. Corrections must reverse the run, fix source data, and
create a new run. Pay actions create a normal treasury voucher with subtype `salary`.
