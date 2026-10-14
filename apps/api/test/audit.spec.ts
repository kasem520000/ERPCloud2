import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { AuditService } from '../src/modules/platform-services/index.js';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Audit trail — PHASE_04 §5.2, SECURITY_ARCHITECTURE §9–§10.
 *
 * Proves the three properties the phase is graded on: a mutating request writes a row,
 * a service-written row carries a real before/after diff, and sensitive keys never reach
 * the table. The fourth — immutability — is proved at the privilege level, as `erp_api`.
 */
describe('audit log (PHASE_04 §5.2)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let other: Actor;

  beforeAll(async () => {
    ctx = await createTestApp('audit');
    admin = await createActor(ctx, {
      tenantCode: 'audit-a',
      email: 'owner@audit-a.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
    other = await createActor(ctx, {
      tenantCode: 'audit-b',
      email: 'owner@audit-b.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('records a settings change with the real before/after values', async () => {
    await api(ctx.server, 'put', '/api/v1/settings/invoice.number_prefix', {
      token: admin.token,
      body: { value: 'FIRST-' },
    });
    await api(ctx.server, 'put', '/api/v1/settings/invoice.number_prefix', {
      token: admin.token,
      body: { value: 'SECOND-' },
    });

    const response = await api(
      ctx.server,
      'get',
      '/api/v1/audit-log?filter[entity]=settings&filter[entityId]=invoice.number_prefix',
      { token: admin.token },
    );
    expect(response.status).toBe(200);

    const rows = response.body.data as Array<{
      action: string;
      entity: string;
      entityId: string;
      actorLabel: string | null;
      before: { value: unknown } | null;
      after: { value: unknown } | null;
    }>;
    expect(rows.length).toBe(2);

    const latest = rows[0]!;
    expect(latest.action).toBe('update');
    expect(latest.entity).toBe('settings');
    expect(latest.before?.value).toBe('FIRST-');
    expect(latest.after?.value).toBe('SECOND-');
    // The actor is resolved to a human label, not just a uuid.
    expect(latest.actorLabel).toBeTypeOf('string');
  });

  it('writes exactly one row per mutating request (interceptor + service do not double up)', async () => {
    const before = await api(ctx.server, 'get', '/api/v1/audit-log?limit=100', { token: admin.token });
    const beforeTotal = (before.body.meta as { total: number }).total;

    await api(ctx.server, 'put', '/api/v1/settings/locale.code', {
      token: admin.token,
      body: { value: 'en' },
    });

    const after = await api(ctx.server, 'get', '/api/v1/audit-log?limit=100', { token: admin.token });
    expect((after.body.meta as { total: number }).total).toBe(beforeTotal + 1);
  });

  it('audits a mutation that has no service-level hook, via the interceptor', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/roles', {
      token: admin.token,
      body: { name: 'Auditor', description: 'reads the trail', permissionCodes: ['platform.audit.view'] },
    });
    expect(created.status).toBe(201);
    const roleId = (created.body.data as { id: string }).id;

    const response = await api(ctx.server, 'get', `/api/v1/audit-log?filter[entity]=roles`, {
      token: admin.token,
    });
    const rows = response.body.data as Array<{ action: string; entityId: string | null; meta: Record<string, unknown> }>;
    const row = rows.find((entry) => entry.entityId === roleId);
    expect(row).toBeDefined();
    expect(row?.action).toBe('create');
    expect(row?.meta.method).toBe('POST');
    expect(row?.meta.status).toBe(201);
    expect(row?.meta.traceId).toBeTypeOf('string');
  });

  it('redacts sensitive keys before they reach the table', async () => {
    const audit = ctx.app.get(AuditService);
    await audit.record({
      tenantId: admin.tenantId,
      actorUserId: admin.userId,
      membershipId: admin.membershipId,
      action: 'update',
      entity: 'integration_credentials',
      entityId: 'stub',
      before: { password: 'old-secret', apiKey: 'k-1', label: 'visible' },
      after: {
        password: 'new-secret',
        nested: { refreshToken: 'r-1', authorization: 'Bearer x', keep: 42 },
      },
      meta: { clientSecret: 'shhh', method: 'PUT' },
    });

    const response = await api(
      ctx.server,
      'get',
      '/api/v1/audit-log?filter[entity]=integration_credentials',
      { token: admin.token },
    );
    const rows = response.body.data as Array<{
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      meta: Record<string, unknown>;
    }>;
    const row = rows[0]!;

    expect(row.before.password).toBe('[redacted]');
    expect(row.before.apiKey).toBe('[redacted]');
    expect(row.before.label).toBe('visible');
    expect(row.after.password).toBe('[redacted]');
    expect((row.after.nested as Record<string, unknown>).refreshToken).toBe('[redacted]');
    expect((row.after.nested as Record<string, unknown>).authorization).toBe('[redacted]');
    expect((row.after.nested as Record<string, unknown>).keep).toBe(42);
    expect(row.meta.clientSecret).toBe('[redacted]');
    expect(row.meta.method).toBe('PUT');
  });

  it('is append-only for the application role (UPDATE and DELETE are revoked)', async () => {
    const client = new Client({ connectionString: ctx.db.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [admin.tenantId]);

      await expect(client.query(`UPDATE audit_log SET action = 'tampered'`)).rejects.toMatchObject({
        code: '42501',
      });
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [admin.tenantId]);
      await expect(client.query('DELETE FROM audit_log')).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('never shows another tenant trail', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/audit-log?limit=100', { token: other.token });
    const rows = response.body.data as Array<{ entity: string }>;
    expect(rows.every((row) => row.entity !== 'settings')).toBe(true);
  });

  it('rejects an unknown filter', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/audit-log?filter[secret]=1', {
      token: admin.token,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('FILTER_NOT_ALLOWED');
  });
});
