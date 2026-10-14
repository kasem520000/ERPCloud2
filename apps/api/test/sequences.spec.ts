import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { formatSequenceNumber } from '@erp/contracts';

import { SequencesService } from '../src/modules/platform-services/index.js';

import { createActor, type Actor } from './fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Document numbering — DATABASE_DESIGN §3, PHASE_04 §5.6 and §12:
 * "64 parallel `Sequences.next` calls yield no duplicates".
 *
 * The concurrency case is the whole point of the table: `INSERT … ON CONFLICT DO UPDATE`
 * serialises the contenders on one row lock, so the allocation is atomic even with 64
 * connections racing. A `SELECT max()+1` implementation passes every single-threaded
 * test and fails this one.
 */
describe('document sequences (PHASE_04 §5.6)', () => {
  let ctx: TestApp;
  let alpha: Actor;
  let beta: Actor;
  let sequences: SequencesService;

  beforeAll(async () => {
    ctx = await createTestApp('sequences');
    alpha = await createActor(ctx, { tenantCode: 'seq-a', email: 'owner@seq-a.test' });
    beta = await createActor(ctx, { tenantCode: 'seq-b', email: 'owner@seq-b.test' });
    sequences = ctx.app.get(SequencesService);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('allocates monotonically and formats the display number', async () => {
    const first = await sequences.next(
      { tenantId: alpha.tenantId, docType: 'sales_invoice' },
      undefined,
      { prefix: 'INV-', padding: 6 },
    );
    expect(first.value).toBe(1);
    expect(first.display).toBe('INV-000001');

    const second = await sequences.next({ tenantId: alpha.tenantId, docType: 'sales_invoice' });
    expect(second.value).toBe(2);
    // Prefix/padding come from the stored row, not from the second caller.
    expect(second.display).toBe('INV-000002');

    const peeked = await sequences.peek({ tenantId: alpha.tenantId, docType: 'sales_invoice' });
    expect(peeked?.value).toBe(2);
  });

  it('yields no duplicates under 64 parallel allocations', async () => {
    const allocations = await Promise.all(
      Array.from({ length: 64 }, () =>
        sequences.next({ tenantId: alpha.tenantId, docType: 'concurrency_probe' }, undefined, {
          prefix: 'CP-',
          padding: 4,
        }),
      ),
    );

    const values = allocations.map((allocation) => allocation.value).sort((a, b) => a - b);
    expect(new Set(values).size).toBe(64);
    expect(values[0]).toBe(1);
    expect(values.at(-1)).toBe(64);

    const displays = new Set(allocations.map((allocation) => allocation.display));
    expect(displays.size).toBe(64);
    expect(displays.has('CP-0064')).toBe(true);
  });

  it('keeps a separate counter per branch, per fiscal year and per tenant', async () => {
    // PHASE_05 added the deferred FK `document_sequences.branch_id → branches.id`, so the
    // scopes have to be real branches now — a numbering row for a branch that does not
    // exist was exactly the orphan that FK was added to prevent.
    const [branchA, branchB] = await createBranches(ctx.db.ownerUrl, alpha.tenantId, ['SEQA', 'SEQB']);
    const yearA = '33333333-3333-4333-8333-333333333333';

    const scoped = { tenantId: alpha.tenantId, docType: 'receipt' };
    expect((await sequences.next({ ...scoped, branchId: branchA })).value).toBe(1);
    expect((await sequences.next({ ...scoped, branchId: branchA })).value).toBe(2);
    expect((await sequences.next({ ...scoped, branchId: branchB })).value).toBe(1);
    expect((await sequences.next({ ...scoped, branchId: branchA, fiscalYearId: yearA })).value).toBe(1);
    // Tenant-wide (branch NULL) is yet another scope.
    expect((await sequences.next(scoped)).value).toBe(1);

    // A different tenant starts from scratch, even for the same doc type.
    expect((await sequences.next({ tenantId: beta.tenantId, docType: 'receipt' })).value).toBe(1);
  });

  it('configures prefix and padding without rewinding the counter', async () => {
    await sequences.next({ tenantId: alpha.tenantId, docType: 'quote' });
    await sequences.next({ tenantId: alpha.tenantId, docType: 'quote' });

    const configured = await sequences.configure(
      { tenantId: alpha.tenantId, docType: 'quote' },
      { prefix: 'QT-', padding: 8 },
    );
    expect(configured.value).toBe(2);
    expect(configured.display).toBe('QT-00000002');

    const next = await sequences.next({ tenantId: alpha.tenantId, docType: 'quote' });
    expect(next.display).toBe('QT-00000003');
  });

  it('formats numbers wider than the padding without truncating them', () => {
    expect(formatSequenceNumber(7, 'INV-', 4)).toBe('INV-0007');
    expect(formatSequenceNumber(123_456, 'INV-', 4)).toBe('INV-123456');
    expect(formatSequenceNumber(9, '', 3)).toBe('009');
  });
});

async function createBranches(
  connectionString: string,
  tenantId: string,
  codes: string[],
): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const ids: string[] = [];
    for (const code of codes) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO branches (id, tenant_id, code, name_ar)
         VALUES (gen_random_uuid(), $1, $2, $2) RETURNING id`,
        [tenantId, code],
      );
      ids.push(rows[0]?.id ?? '');
    }
    return ids;
  } finally {
    await client.end();
  }
}
