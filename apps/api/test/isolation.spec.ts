import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  countRowsBypassingRls,
  expectForgedTenantClaimRejected,
  expectIsolation,
  expectSuspendedTenantRejected,
  rlsProbe,
  rlsProtectedTablesProbe,
  setTenantStatusFixture,
} from '@erp/testing';
import { setTenantSettingFixture } from '@erp/testing';

import { TokenService } from '../src/modules/platform/index.js';

import { createIsolationHttp } from './http.js';
import { createActor, createRoleFixture, createTenantFixture, createUserFixture, type Actor } from './fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Tenant isolation — TESTING_STRATEGY §6 harness applied to every tenant-scoped resource
 * created by PHASE_03, plus the negative JWT cases (forged `tid`, suspended tenant).
 */

let invitationCounter = 0;
function nextEmail(domain: string): string {
  invitationCounter += 1;
  return `invitee-${invitationCounter}@${domain}`;
}

describe('tenant isolation (TESTING_STRATEGY §6)', () => {
  let ctx: TestApp;
  let alice: Actor;
  let bob: Actor;
  let aliceStaffRoleId: string;
  let bobStaffRoleId: string;
  let http: ReturnType<typeof createIsolationHttp>;

  beforeAll(async () => {
    ctx = await createTestApp('isolation');
    alice = await createActor(ctx, { tenantCode: 'alpha', email: 'owner@alpha.test' });
    bob = await createActor(ctx, { tenantCode: 'beta', email: 'owner@beta.test' });
    aliceStaffRoleId = (
      await createRoleFixture(ctx.db.ownerUrl, { tenantId: alice.tenantId, name: 'Staff' })
    ).id;
    bobStaffRoleId = (
      await createRoleFixture(ctx.db.ownerUrl, { tenantId: bob.tenantId, name: 'Staff' })
    ).id;
    http = createIsolationHttp(ctx.server);

    // tenant_settings is only populated by the settings API, so give both tenants a row
    // before the RLS probe asserts on it.
    await setTenantSettingFixture(ctx.db.ownerUrl, alice.tenantId, 'invoice.number_prefix', 'A-');
    await setTenantSettingFixture(ctx.db.ownerUrl, bob.tenantId, 'invoice.number_prefix', 'B-');
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  const actors = () => ({
    a: { label: 'alpha', tenantId: alice.tenantId, token: alice.token },
    b: { label: 'beta', tenantId: bob.tenantId, token: bob.token },
  });

  it('runs all four proofs for memberships', async () => {
    const result = await expectIsolation(
      http,
      actors(),
      {
        resource: 'memberships',
        tableName: 'memberships',
        createRow: async (actor) => {
          const response = await http.post(actor, '/api/v1/memberships', {
            email: nextEmail(actor.label === 'alpha' ? 'alpha.test' : 'beta.test'),
            roleIds: [actor.label === 'alpha' ? aliceStaffRoleId : bobStaffRoleId],
          });
          expect(response.status).toBe(201);
          return (response.body as { data: { id: string } }).data.id;
        },
        readById: (actor, rowId) =>
          http.get(actor, `/api/v1/memberships/${rowId}`).then((response) => response.status),
        listRowIds: async (actor) => {
          const response = await http.get(actor, '/api/v1/memberships?limit=200');
          return ((response.body as { data: Array<{ id: string }> }).data ?? []).map((row) => row.id);
        },
        writeForeignRow: (actor, rowId) =>
          http
            .patch(actor, `/api/v1/memberships/${rowId}`, { displayName: 'hijacked' })
            .then((response) => response.status),
        createWithForeignReference: (actor, foreignRoleId) =>
          http
            .post(actor, '/api/v1/memberships', {
              email: nextEmail('attacker.test'),
              roleIds: [foreignRoleId],
            })
            .then((response) => response.status),
        attemptForeignInsert: async (client, foreignTenantId) => {
          await client.query(
            `INSERT INTO memberships (id, tenant_id, user_id, display_name, status)
             VALUES (gen_random_uuid(), $1, $2, 'cross-tenant', 'active')`,
            [foreignTenantId, alice.userId],
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
    // No export/report surface exists in PHASE_03; proof 4 applies from PHASE_14.
    expect(result.exportChecked).toBe(false);
  });

  it('runs all four proofs for roles', async () => {
    let roleCounter = 0;
    const result = await expectIsolation(
      http,
      actors(),
      {
        resource: 'roles',
        tableName: 'roles',
        createRow: async (actor) => {
          roleCounter += 1;
          const response = await http.post(actor, '/api/v1/roles', {
            name: `Probe ${actor.label} ${roleCounter}`,
            permissionCodes: ['platform.tenant.view'],
          });
          expect(response.status).toBe(201);
          return (response.body as { data: { id: string } }).data.id;
        },
        readById: (actor, rowId) =>
          http.get(actor, `/api/v1/roles/${rowId}`).then((response) => response.status),
        listRowIds: async (actor) => {
          const response = await http.get(actor, '/api/v1/roles?limit=200');
          return ((response.body as { data: Array<{ id: string }> }).data ?? []).map((row) => row.id);
        },
        writeForeignRow: (actor, rowId) =>
          http
            .put(actor, `/api/v1/roles/${rowId}`, { description: 'hijacked' })
            .then((response) => response.status),
      },
      { appUrl: ctx.db.appUrl, migratorUrl: ctx.db.migratorUrl },
    );

    expect(result).toMatchObject({ readBlocked: true, listBlocked: true, rlsBlocked: true });
  });

  it('hides every RLS-protected table from the API role when the GUC is unset', async () => {
    for (const table of ['memberships', 'roles', 'role_permissions', 'membership_roles', 'tenant_settings']) {
      const probe = await rlsProbe(ctx.db.appUrl, table, alice.tenantId);
      const visibleToMigrator = await countRowsBypassingRls(ctx.db.migratorUrl, table);

      expect(probe.visibleWithoutGuc, `${table}: RLS must hide everything without the GUC`).toBe(0);
      expect(visibleToMigrator, `${table}: rows must exist for the probe to mean anything`).toBeGreaterThan(
        0,
      );
      expect(probe.visibleWithGuc, `${table}: tenant A must not see tenant B's rows`).toBeLessThan(
        visibleToMigrator,
      );
    }
  });

  it('exposes the protected table list for later phases to extend', () => {
    expect(rlsProtectedTablesProbe()).toEqual([
      'memberships',
      'roles',
      'role_permissions',
      'membership_roles',
      'tenant_settings',
      // PHASE_04 — platform services.
      'audit_log',
      'files',
      'notifications',
      'outbox_jobs',
      'idempotency_keys',
      // Future enhancement 03 — e-commerce stores, orders and sync logs (migration 0099).
      'ecommerce_stores',
      'ecommerce_orders',
      'ecommerce_sync_logs',
      'document_sequences',
      // PHASE_05 — organization structure.
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
      // 2026-09 architecture/RBAC reorganisation (migration 0032).
      'devices',
      'membership_role_scopes',
      // Future enhancement 01 — bank feeds and reconciliation (migration 0096).
      'bank_accounts',
      'bank_statements',
      'bank_statement_lines',
      'bank_reconciliation_rules',
      // R17 — printer/report links.
      'printer_report_links',
      // Future enhancement 02 — purchase-invoice OCR jobs (migration 0097).
      'ocr_jobs',
      // Future enhancement 04 — approval workflows and their parent-scoped children.
      'approval_workflows',
      'approval_steps',
      'approval_requests',
      'approval_decisions',
      'custom_fields',
      'custom_field_values',
      'custom_reports',
      'offline_queue',
      'field_sync_queue',
      'payroll_compliance_settings',
      'payroll_wps_files',
      'payroll_gosi_files',
      'payment_provider_configs',
      'payment_links',
      'ai_settings',
      'ai_conversations',
      'ai_usage_logs',
      'ai_suggestions',
      'employee_geofences',
      'employee_attendance',
      'employee_requests',
      'employee_push_subscriptions',
      'employee_push_outbox',
      'warehouse_bins',
      'bin_balances',
      'bin_transfers',
      'boms',
      'bom_lines',
      'manufacturing_orders',
      'manufacturing_moves',
      'supplier_portal_users',
      'supplier_portal_sessions',
      'supplier_rfqs',
      'supplier_invoice_uploads',
      'esign_requests',
      'esign_events',
      'dashboards',
      'dashboard_widgets',
      'tenant_apps',
      'tenant_domains',
      'tenant_branding',
      'crm_pipelines',
      'crm_deals',
      'crm_activities',
      'crm_whatsapp_templates',
      'crm_settings',
      'comments',
      'comment_mentions',
      'project_tasks',
      'project_time_logs',
      'project_dependencies',
    ]);
  });

  it('rejects a cross-tenant UPDATE at the RLS layer even with the caller GUC set', async () => {
    const client = new Client({ connectionString: ctx.db.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [alice.tenantId]);
      const result = await client.query(`UPDATE roles SET description = 'hijacked' WHERE tenant_id = $1`, [
        bob.tenantId,
      ]);
      expect(result.rowCount, 'RLS must hide tenant B rows from an UPDATE').toBe(0);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('rejects a forged tid claim', async () => {
    const forged = await ctx.app
      .get(TokenService)
      .signAccessToken({ sub: alice.userId, tid: bob.tenantId, mid: alice.membershipId, scope: ['erp'] });

    const status = await expectForgedTenantClaimRejected(
      http,
      { label: 'forged', tenantId: bob.tenantId, token: forged.token },
      '/api/v1/me',
    );
    expect(status).toBe(403);
  });

  it('rejects a suspended tenant with TENANT_SUSPENDED', async () => {
    const carol = await createActor(ctx, { tenantCode: 'gamma', email: 'owner@gamma.test' });
    await setTenantStatusFixture(ctx.db.ownerUrl, carol.tenantId, 'suspended');

    const response = await expectSuspendedTenantRejected(
      http,
      { label: 'gamma', tenantId: carol.tenantId, token: carol.token },
      '/api/v1/tenant',
    );
    expect(response.status).toBe(423);
  });

  it('never lets a tenant read another tenant settings through the API role', async () => {
    const client = new Client({ connectionString: ctx.db.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [alice.tenantId]);
      const rows = await client.query(`SELECT tenant_id FROM tenant_settings`);
      const tenants = new Set(rows.rows.map((row: { tenant_id: string }) => row.tenant_id));
      await client.query('ROLLBACK');

      expect(tenants.size).toBeLessThanOrEqual(1);
      expect([...tenants][0] === alice.tenantId || tenants.size === 0).toBe(true);
    } finally {
      await client.end();
    }
  });

  it('keeps platform tables (users, tenants, permissions) reachable without a GUC', async () => {
    const tenant = await createTenantFixture(ctx.db.ownerUrl, { code: 'platform-check' });
    await createUserFixture(ctx.db.ownerUrl, { email: 'platform@check.test' });

    const client = new Client({ connectionString: ctx.db.appUrl });
    await client.connect();
    try {
      const tenants = await client.query(`SELECT count(*)::int AS n FROM tenants WHERE id = $1`, [tenant.id]);
      const users = await client.query(
        `SELECT count(*)::int AS n FROM users WHERE email = 'platform@check.test'`,
      );
      const permissions = await client.query(`SELECT count(*)::int AS n FROM permissions`);

      expect((tenants.rows[0] as { n: number }).n).toBe(1);
      expect((users.rows[0] as { n: number }).n).toBe(1);
      expect((permissions.rows[0] as { n: number }).n).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });
});
