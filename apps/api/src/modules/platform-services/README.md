# modules/platform-services — Audit, Files, Notifications, Jobs, Sequences, Idempotency (PHASE_04)

Cross-cutting infrastructure that every business module consumes and that owns no
business rules of its own. Later phases import **only** from
`modules/platform-services/index.ts`; reaching into `jobs/…` or `files/…` directly is a
defect (`AI_DEVELOPMENT_PROTOCOL §4`).

The module is `@Global()`: `modules/platform` (settings) needs `AuditService` while this
module's controllers need the guards exported by `modules/platform`, and a plain
`imports:` edge in either direction would be a module cycle.

## What it provides

| Export | Use in a later phase |
| --- | --- |
| `AuditService.recordInTx(tx, entry)` | write an audit row with a real `before`/`after` inside your own transaction |
| `AuditInterceptor` | already global — every successful mutating request is audited without any code in your controller |
| `SequencesService.next(scope, tx)` | allocate a document number **in the document's transaction** |
| `OutboxService.enqueueInTx(tx, job)` | queue work transactionally; never publish to Redis from a business transaction |
| `FilesService` + `FileAttachmentRegistry.register(entity, validator)` | let your entity receive attachments |
| `NotificationsService.createInTx(tx, …)` | in-app notification addressed to a membership |
| `IdempotencyStore` | backing store of the `Idempotency-Key` interceptor; you should not need it directly |
| `MAILER`, `VIRUS_SCANNER`, `OBJECT_STORAGE`, `QUEUE_PORT` | ports to override in a deployment or a test |

## Allocating a document number

```ts
await withTenantTx(this.database.db, tenantId, async (tx) => {
  const number = await this.sequences.next({ tenantId, docType: 'sales_invoice', branchId }, tx);
  await tx.insert(salesInvoices).values({ /* … */ number: number.display });
});
```

Pass the caller's `tx`. The allocation must share the fate of the document it numbers —
otherwise a rolled-back invoice burns a number, and gaps in a numbering series are the
first thing an auditor asks about. The single `INSERT … ON CONFLICT DO UPDATE` takes a row
lock, so 64 concurrent callers get 64 distinct values (`test/sequences.spec.ts`).

## Queuing work

```ts
await withTenantTx(this.database.db, tenantId, async (tx) => {
  await tx.update(invoices).set({ status: 'posted' }).where(eq(invoices.id, id));
  await this.outbox.enqueueInTx(tx, {
    tenantId,
    queue: 'einvoice',
    type: 'einvoice.submit',
    payload: { invoiceId: id },        // never a secret — the guard throws
  });
});
```

If the transaction rolls back the job disappears with it; if it commits the job is
delivered at least once. Handlers must therefore be **idempotent**. Register one from your
module bootstrap:

```ts
registry.register('einvoice', 'einvoice.submit', async ({ tenantId, payload }) => { /* … */ });
```

## Attaching files to your entity

`POST /files/presign` with `entity`/`entityId` is rejected with 422 unless the entity has a
registered validator, so a file can never be attached to a row that does not exist (or to
one in another tenant):

```ts
attachments.register('sales_invoice', async (tx, tenantId, entityId) => {
  const [row] = await tx.select({ id: salesInvoices.id }).from(salesInvoices)
    .where(and(eq(salesInvoices.id, entityId), eq(salesInvoices.tenantId, tenantId))).limit(1);
  return Boolean(row);
});
```

Phase 04 registers none: no business entity exists yet, which is why the isolation and
files suites assert the 422.

## Running the worker

`WORKER=1` boots the same image as an application context with no HTTP listener: BullMQ
consumers for the five queues, the outbox drain loop, the maintenance jobs (orphan-file
collection, idempotency-key expiry) and a periodic health log. Without `REDIS_URL` the
queue driver is inert — the process still starts, the outbox simply keeps its rows
`pending` — so a laptop and CI behave like production minus the last hop.

## What is deliberately not here

Real SMTP/SES and antivirus adapters (ports only — `PHASE_04_PROMPT §14`), report export
infrastructure, and any business entity.
