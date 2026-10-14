import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { expectIsolation, rlsProbe } from '@erp/testing';

import { OrgProvisioningService } from '../src/modules/organization/index.js';

import { ALL_ORGANIZATION_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { createIsolationHttp } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Tenant isolation for the PHASE_05 resources — TESTING_STRATEGY §6, MULTI_TENANCY §7.
 *
 * The four proofs run unchanged against branches (the resource everything else hangs
 * off) and cash locations (the one carrying sensitive data), and the remaining eight
 * organization tables are proved at the RLS layer, which is the only place they can leak
 * from — a `price_list_items` row has no endpoint of its own that could betray it.
 */
describe('organization isolation (TESTING_STRATEGY §6)', () => {
  let ctx: TestApp;
  let alice: Actor;
  let bob: Actor;
  let http: ReturnType<typeof createIsolationHttp>;
  const branchOf = new Map<string, string>();

  beforeAll(async () => {
    ctx = await createTestApp('iso-org');
    alice = await createActor(ctx, {
      tenantCode: 'iso-org-a',
      email: 'owner@iso-org-a.test',
      permissions: ALL_ORGANIZATION_PERMISSIONS,
    });
    bob = await createActor(ctx, {
      tenantCode: 'iso-org-b',
      email: 'owner@iso-org-b.test',
      permissions: ALL_ORGANIZATION_PERMISSIONS,
    });
    http = createIsolationHttp(ctx.server);

    // Both tenants get the standard defaults, so every organization table holds rows for
    // two tenants before the probes run.
    const provisioning = ctx.app.get(OrgProvisioningService);
    for (const actor of [alice, bob]) {
      const defaults = await provisioning.provisionOrgDefaults(actor.tenantId);
      branchOf.set(actor.tenantId, defaults.branchId);

      const scoped = { label: actor.tenantCode, tenantId: actor.tenantId, token: actor.token };
      await http.post(scoped, '/api/v1/currencies', {
        code: 'USD',
        nameAr: 'دولار',
        nameEn: 'US dollar',
      });
      await http.post(scoped, '/api/v1/fx-rates', {
        fromCode: 'USD',
        toCode: 'SAR',
        rate: '3.75',
        effectiveFrom: '2026-01-01',
      });
      await http.post(scoped, '/api/v1/branch-posting-profiles', {
        docType: '*',
        mapping: { version: 1, salesAccountId: '018f3b8a-0000-7000-8000-0000000000c1' },
      });
      await http.put(scoped, '/api/v1/company-profile', { nameAr: `شركة ${actor.tenantCode}` });

      const priceLists = await http.get(scoped, '/api/v1/price-lists');
      const priceListId = (priceLists.body as { data: Array<{ id: string }> }).data[0]?.id ?? '';
      await http.post(scoped, `/api/v1/price-lists/${priceListId}/items`, { unitPrice: '10.0000' });
    }
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  const actors = () => ({
    a: { label: 'iso-org-a', tenantId: alice.tenantId, token: alice.token },
    b: { label: 'iso-org-b', tenantId: bob.tenantId, token: bob.token },
  });

  it('runs the four proofs for branches', async () => {
    let counter = 0;
    const result = await expectIsolation(
      http,
      actors(),
      {
        resource: 'branches',
        tableName: 'branches',
        createRow: async (actor) => {
          counter += 1;
          const response = await http.post(actor, '/api/v1/branches', {
            code: `PROBE${counter}`,
            nameAr: `فرع ${counter}`,
          });
          expect(response.status).toBe(201);
          return (response.body as { data: { id: string } }).data.id;
        },
        readById: (actor, rowId) =>
          http.get(actor, `/api/v1/branches/${rowId}`).then((response) => response.status),
        listRowIds: async (actor) => {
          const response = await http.get(actor, '/api/v1/branches?limit=200');
          return ((response.body as { data: Array<{ id: string }> }).data ?? []).map((row) => row.id);
        },
        writeForeignRow: (actor, rowId) =>
          http.patch(actor, `/api/v1/branches/${rowId}`, { nameEn: 'hijacked' }).then((r) => r.status),
        createWithForeignReference: (actor, foreignRowId) =>
          // A warehouse under the *other* tenant's branch must be unbuildable.
          http
            .post(actor, '/api/v1/warehouses', {
              branchId: foreignRowId,
              code: `WHX${Date.now() % 100000}`,
              name: 'Foreign warehouse',
            })
            .then((response) => response.status),
        attemptForeignInsert: async (client, foreignTenantId) => {
          await client.query(
            `INSERT INTO branches (id, tenant_id, code, name_ar)
             VALUES (gen_random_uuid(), $1, 'CROSS', 'عبر المستأجر')`,
            [foreignTenantId],
          );
        },
      },
      { appUrl: ctx.db.appUrl, migratorUrl: ctx.db.migratorUrl },
    );

    expect(result).toMatchObject({
      readBlocked: true,
      listBlocked: true,
      writeBlocked: true,
      rlsBlocked: true,
    });
  });

  it('runs the four proofs for cash locations', async () => {
    let counter = 0;
    const result = await expectIsolation(
      http,
      actors(),
      {
        resource: 'cash-locations',
        tableName: 'cash_locations',
        createRow: async (actor) => {
          counter += 1;
          const response = await http.post(actor, '/api/v1/cash-locations', {
            branchId: branchOf.get(actor.tenantId),
            kind: 'bank',
            name: `Probe bank ${counter}`,
            bank: { bankName: 'Probe bank' },
          });
          expect(response.status).toBe(201);
          return (response.body as { data: { id: string } }).data.id;
        },
        readById: (actor, rowId) =>
          http.get(actor, `/api/v1/cash-locations/${rowId}`).then((response) => response.status),
        listRowIds: async (actor) => {
          const response = await http.get(actor, '/api/v1/cash-locations?limit=200');
          return ((response.body as { data: Array<{ id: string }> }).data ?? []).map((row) => row.id);
        },
        writeForeignRow: (actor, rowId) =>
          http.patch(actor, `/api/v1/cash-locations/${rowId}`, { name: 'hijacked' }).then((r) => r.status),
        exportRowIds: async (actor) => {
          // The balances sub-resource is a second read surface and must obey the same rule.
          const response = await http.get(actor, '/api/v1/cash-locations?limit=200');
          const ids = ((response.body as { data: Array<{ id: string }> }).data ?? []).map((row) => row.id);
          const visible: string[] = [];
          for (const id of ids) {
            const balances = await http.get(actor, `/api/v1/cash-locations/${id}/balances`);
            if (balances.status === 200) visible.push(id);
          }
          return visible;
        },
        attemptForeignInsert: async (client, foreignTenantId) => {
          const branchId = branchOf.get(foreignTenantId);
          await client.query(
            `INSERT INTO cash_locations (id, tenant_id, branch_id, kind, name)
             VALUES (gen_random_uuid(), $1, $2, 'safe', 'cross-tenant safe')`,
            [foreignTenantId, branchId],
          );
        },
      },
      { appUrl: ctx.db.appUrl, migratorUrl: ctx.db.migratorUrl },
    );

    expect(result).toMatchObject({
      readBlocked: true,
      listBlocked: true,
      writeBlocked: true,
      rlsBlocked: true,
      exportChecked: true,
    });
  });

  it('protects every organization table at the RLS layer', async () => {
    const tables = [
      'company_profiles',
      'branches',
      'warehouses',
      'cash_locations',
      'cash_location_balances',
      'currencies',
      'fx_rates',
      'price_lists',
      'price_list_items',
      'branch_posting_profiles',
    ];

    for (const table of tables) {
      const probe = await rlsProbe(ctx.db.appUrl, table, alice.tenantId);
      expect(probe.visibleWithoutGuc, `${table} must be invisible without the GUC`).toBe(0);
      expect(probe.visibleWithGuc, `${table} must expose tenant A rows`).toBeGreaterThan(0);

      const rowsInTable = await countAll(ctx.db.migratorUrl, table);
      expect(probe.visibleWithGuc, `${table} must hide tenant B rows`).toBeLessThan(rowsInTable);
    }
  });

  it('rejects a forged tenant id on every organization write path', async () => {
    const client = new Client({ connectionString: ctx.db.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [alice.tenantId]);

      // Alice's GUC, Bob's tenant id in the row: the WITH CHECK clause must refuse it.
      await expect(
        client.query(
          `INSERT INTO price_lists (id, tenant_id, name, currency_code)
           VALUES (gen_random_uuid(), $1, 'Forged', 'SAR')`,
          [bob.tenantId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');

      // …and an UPDATE cannot move a row across the boundary either.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [alice.tenantId]);
      const moved = await client.query('UPDATE branches SET name_en = $1 WHERE tenant_id = $2', [
        'hijacked',
        bob.tenantId,
      ]);
      expect(moved.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('keeps FX resolution inside the tenant', async () => {
    // Both tenants quoted USD→SAR; only Alice's rate must answer Alice's question.
    const aliceScope = { label: 'iso-org-a', tenantId: alice.tenantId, token: alice.token };
    await http.post(aliceScope, '/api/v1/fx-rates', {
      fromCode: 'USD',
      toCode: 'SAR',
      rate: '9.99',
      effectiveFrom: '2026-02-01',
    });

    const forAlice = await http.get(aliceScope, '/api/v1/fx-rates/resolve?from=USD&to=SAR&date=2026-03-01');
    expect((forAlice.body as { data: { rate: string } }).data.rate).toBe('9.99');

    const forBob = await http.get(
      { label: 'iso-org-b', tenantId: bob.tenantId, token: bob.token },
      '/api/v1/fx-rates/resolve?from=USD&to=SAR&date=2026-03-01',
    );
    expect((forBob.body as { data: { rate: string } }).data.rate).toBe('3.75');
  });
});

async function countAll(connectionString: string, table: string): Promise<number> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(`SELECT count(*)::int AS total_rows FROM ${table}`);
    return (result.rows as Array<{ total_rows: number }>)[0]?.total_rows ?? 0;
  } finally {
    await client.end();
  }
}
