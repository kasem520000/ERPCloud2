import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { expectIsolation, rlsProbe } from '@erp/testing';

import { OBJECT_STORAGE, SequencesService } from '../src/modules/platform-services/index.js';

import { FakeObjectStorage } from './fakes.js';
import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { createIsolationHttp } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Tenant isolation for the PHASE_04 resources — TESTING_STRATEGY §6, MULTI_TENANCY §7.
 *
 * The harness is applied unchanged to files and notifications (the two new HTTP
 * resources with an id), and the tables that have no CRUD surface — `audit_log`,
 * `outbox_jobs`, `idempotency_keys`, `document_sequences` — are proved at the RLS layer,
 * which is the only layer that can leak them.
 */
describe('platform-services isolation (TESTING_STRATEGY §6)', () => {
  let ctx: TestApp;
  let alice: Actor;
  let bob: Actor;
  let http: ReturnType<typeof createIsolationHttp>;
  const storage = new FakeObjectStorage();

  beforeAll(async () => {
    ctx = await createTestApp('iso-services', (builder) =>
      builder.overrideProvider(OBJECT_STORAGE).useValue(storage),
    );
    alice = await createActor(ctx, {
      tenantCode: 'iso-a',
      email: 'owner@iso-a.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
    bob = await createActor(ctx, {
      tenantCode: 'iso-b',
      email: 'owner@iso-b.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
    http = createIsolationHttp(ctx.server);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  const actors = () => ({
    a: { label: 'iso-a', tenantId: alice.tenantId, token: alice.token },
    b: { label: 'iso-b', tenantId: bob.tenantId, token: bob.token },
  });

  it('runs the four proofs for files', async () => {
    let counter = 0;
    const result = await expectIsolation(
      http,
      actors(),
      {
        resource: 'files',
        tableName: 'files',
        createRow: async (actor) => {
          counter += 1;
          const response = await http.post(actor, '/api/v1/files/presign', {
            name: `probe-${counter}.pdf`,
            mime: 'application/pdf',
            sizeBytes: 1024,
          });
          expect(response.status).toBe(201);
          return (response.body as { data: { fileId: string } }).data.fileId;
        },
        readById: (actor, rowId) =>
          http.get(actor, `/api/v1/files/${rowId}`).then((response) => response.status),
        listRowIds: async (actor) => {
          const response = await http.get(actor, '/api/v1/files?limit=200');
          return ((response.body as { data: Array<{ id: string }> }).data ?? []).map((row) => row.id);
        },
        writeForeignRow: (actor, rowId) =>
          http.post(actor, `/api/v1/files/${rowId}/finalize`, {}).then((response) => response.status),
        attemptForeignInsert: async (client, foreignTenantId) => {
          await client.query(
            `INSERT INTO files (id, tenant_id, bucket, object_key, name, mime, size_bytes, status)
             VALUES (gen_random_uuid(), $1, 'erp-test', 'cross/tenant/key', 'x.pdf', 'application/pdf', 1, 'pending')`,
            [foreignTenantId],
          );
        },
      },
      { appUrl: ctx.db.appUrl, migratorUrl: ctx.db.migratorUrl },
    );

    expect(result).toMatchObject({ readBlocked: true, listBlocked: true, writeBlocked: true, rlsBlocked: true });
  });

  it('runs the four proofs for notifications', async () => {
    let counter = 0;
    const result = await expectIsolation(
      http,
      actors(),
      {
        resource: 'notifications',
        tableName: 'notifications',
        createRow: async (actor) => {
          counter += 1;
          const response = await http.post(actor, '/api/v1/notifications', {
            type: `probe.${counter}`,
            payload: { counter },
          });
          expect(response.status).toBe(201);
          return (response.body as { data: { id: string } }).data.id;
        },
        readById: (actor, rowId) =>
          http.get(actor, `/api/v1/notifications/${rowId}`).then((response) => response.status),
        listRowIds: async (actor) => {
          const response = await http.get(actor, '/api/v1/notifications?limit=200');
          return ((response.body as { data: Array<{ id: string }> }).data ?? []).map((row) => row.id);
        },
        writeForeignRow: (actor, rowId) =>
          http.post(actor, `/api/v1/notifications/${rowId}/read`, {}).then((response) => response.status),
        createWithForeignReference: (actor, foreignRowId) =>
          http
            .post(actor, '/api/v1/notifications', {
              // A membership id from the other tenant must not be addressable.
              membershipId: actor.label === 'iso-a' ? bob.membershipId : alice.membershipId,
              type: 'probe.foreign',
              payload: { foreignRowId },
            })
            .then((response) => response.status),
        attemptForeignInsert: async (client, foreignTenantId) => {
          await client.query(
            `INSERT INTO notifications (id, tenant_id, membership_id, type, payload)
             VALUES (gen_random_uuid(), $1, $2, 'cross.tenant', '{}'::jsonb)`,
            [foreignTenantId, bob.membershipId],
          );
        },
      },
      { appUrl: ctx.db.appUrl, migratorUrl: ctx.db.migratorUrl },
    );

    expect(result).toMatchObject({ readBlocked: true, listBlocked: true, writeBlocked: true, rlsBlocked: true });
  });

  it('protects the tables that have no CRUD surface at the RLS layer', async () => {
    // Give both tenants a row in each table.
    const sequences = ctx.app.get(SequencesService);
    for (const actor of [alice, bob]) {
      await sequences.next({ tenantId: actor.tenantId, docType: 'iso_probe' });
      await http.put(
        { label: actor.tenantCode, tenantId: actor.tenantId, token: actor.token },
        '/api/v1/settings/locale.code',
        { value: actor === alice ? 'en' : 'ar' },
      );
    }

    for (const table of ['audit_log', 'notifications', 'document_sequences', 'outbox_jobs']) {
      const probe = await rlsProbe(ctx.db.appUrl, table, alice.tenantId);
      expect(probe.visibleWithoutGuc, `${table} must be invisible without the GUC`).toBe(0);
      expect(probe.visibleWithGuc, `${table} must expose tenant A rows`).toBeGreaterThan(0);

      const rowCount = await countAll(ctx.db.migratorUrl, table);
      expect(probe.visibleWithGuc, `${table} must hide tenant B rows`).toBeLessThan(rowCount);
    }
  });

  it('rejects a cross-tenant INSERT into audit_log even with the caller GUC set', async () => {
    const client = new Client({ connectionString: ctx.db.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [alice.tenantId]);
      await expect(
        client.query(
          `INSERT INTO audit_log (id, tenant_id, action, entity) VALUES (gen_random_uuid(), $1, 'forge', 'x')`,
          [bob.tenantId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
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
