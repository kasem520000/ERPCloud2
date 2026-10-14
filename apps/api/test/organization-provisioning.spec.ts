import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { OrgProvisioningService } from '../src/modules/organization/index.js';

import { ALL_ORGANIZATION_PERMISSIONS, createActor, createTenantFixture, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Tenant provisioning and the single-default invariant — PHASE_05 §5.7, §11.
 *
 * `provisionOrgDefaults` is the seam PHASE_03's tenant factory and PHASE_15's migrator
 * both call, so it has to be safe to call twice; and "exactly one default" has to hold
 * under a burst of concurrent writers, not just in a quiet test.
 */
describe('organization provisioning and default flags (PHASE_05 §5.7, §11)', () => {
  let ctx: TestApp;
  let admin: Actor;

  beforeAll(async () => {
    ctx = await createTestApp('org-provisioning');
    admin = await createActor(ctx, {
      tenantCode: 'org-prov',
      email: 'admin@org-prov.test',
      permissions: ALL_ORGANIZATION_PERMISSIONS,
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  const provisioning = () => ctx.app.get(OrgProvisioningService);

  async function withClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: ctx.db.ownerUrl });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  it('gives a bare tenant everything it needs to record a document', async () => {
    const defaults = await provisioning().provisionOrgDefaults(admin.tenantId);

    expect(defaults.created).toBe(true);
    expect(defaults.currencyCode).toBe('SAR');
    expect(defaults.tenantId).toBe(admin.tenantId);

    const rows = await withClient(async (client) => {
      const branch = await client.query<{ code: string; is_default: boolean }>(
        'SELECT code, is_default FROM branches WHERE id = $1',
        [defaults.branchId],
      );
      const warehouse = await client.query<{ branch_id: string; is_default: boolean }>(
        'SELECT branch_id, is_default FROM warehouses WHERE id = $1',
        [defaults.warehouseId],
      );
      const cash = await client.query<{ kind: string; is_default: boolean; account_id: string | null }>(
        'SELECT kind, is_default, account_id FROM cash_locations WHERE id = $1',
        [defaults.cashLocationId],
      );
      const chart = await client.query<{ total: string; roots: string; cashbox: string | null }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE parent_id IS NULL) AS roots,
                max(code) FILTER (WHERE code = '1211001') AS cashbox
         FROM accounts WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [admin.tenantId],
      );
      const balances = await client.query<{ currency_code: string; balance: string }>(
        'SELECT currency_code, balance FROM cash_location_balances WHERE cash_location_id = $1',
        [defaults.cashLocationId],
      );
      const priceList = await client.query<{ currency_code: string; is_default: boolean }>(
        'SELECT currency_code, is_default FROM price_lists WHERE id = $1',
        [defaults.priceListId],
      );
      const currency = await client.query<{ code: string; is_base: boolean }>(
        'SELECT code, is_base FROM currencies WHERE tenant_id = $1',
        [admin.tenantId],
      );
      return { branch, warehouse, cash, balances, priceList, currency, chart };
    });

    expect(rows.branch.rows[0]).toMatchObject({ code: 'MAIN', is_default: true });
    expect(rows.warehouse.rows[0]).toMatchObject({ is_default: true });
    expect(rows.cash.rows[0]).toMatchObject({ kind: 'safe', is_default: true });
    // The desktop chart is seeded in the same transaction, so the safe posts to
    // 1211001 (الصندوق الرئيسي) from day one — CR-006 is closed. The count is the
    // desktop chart (113) plus the two leaves Phase 05 added to it: 1270003
    // (بضاعة تحت التحويل) and 3121004 (تسويات المخزون), plus the one Phase 13 added:
    // 1211003 (نقد تحت التحويل) for the cash-transfer journal.
    expect(rows.chart.rows[0]).toMatchObject({ total: '116', roots: '4', cashbox: '1211001' });
    const linked = await withClient(async (client) => {
      const byId = await client.query<{ code: string }>('SELECT code FROM accounts WHERE id = $1', [
        rows.cash.rows[0]?.account_id,
      ]);
      return byId.rows[0]?.code;
    });
    expect(linked).toBe('1211001');
    expect(rows.balances.rows).toHaveLength(1);
    expect(rows.balances.rows[0]?.currency_code.trim()).toBe('SAR');
    expect(Number(rows.balances.rows[0]?.balance)).toBe(0);
    expect(rows.priceList.rows[0]).toMatchObject({ is_default: true });
    expect(rows.priceList.rows[0]?.currency_code.trim()).toBe('SAR');
    expect(rows.currency.rows[0]).toMatchObject({ is_base: true });
  });

  it('is idempotent: a second call changes nothing and returns the same ids', async () => {
    const first = await provisioning().provisionOrgDefaults(admin.tenantId);
    const second = await provisioning().provisionOrgDefaults(admin.tenantId);

    expect(second.created).toBe(false);
    expect(second).toEqual({ ...first, created: false });

    const counts = await withClient(async (client) => {
      const { rows } = await client.query<{ branches: string; warehouses: string; cash: string }>(
        `SELECT
           (SELECT count(*) FROM branches WHERE tenant_id = $1)::text AS branches,
           (SELECT count(*) FROM warehouses WHERE tenant_id = $1)::text AS warehouses,
           (SELECT count(*) FROM cash_locations WHERE tenant_id = $1)::text AS cash`,
        [admin.tenantId],
      );
      return rows[0];
    });

    expect(counts).toEqual({ branches: '1', warehouses: '1', cash: '1' });
  });

  it('honours the migrator’s branch code and the tenant’s own base currency', async () => {
    const tenant = await createTenantFixture(ctx.db.ownerUrl, { code: 'org-prov-kw', name: 'Kuwait tenant' });
    await withClient(async (client) => {
      await client.query('UPDATE tenants SET base_currency = $2 WHERE id = $1', [tenant.id, 'KWD']);
    });

    const defaults = await provisioning().provisionOrgDefaults(tenant.id, {
      code: 'hq',
      nameAr: 'المركز الرئيسي',
      nameEn: 'Head office',
    });

    expect(defaults.currencyCode).toBe('KWD');

    const rows = await withClient(async (client) => {
      const branch = await client.query<{ code: string; name_en: string }>(
        'SELECT code, name_en FROM branches WHERE id = $1',
        [defaults.branchId],
      );
      const currency = await client.query<{ minor_units: number }>(
        'SELECT minor_units FROM currencies WHERE tenant_id = $1 AND code = $2',
        [tenant.id, 'KWD'],
      );
      return { branch: branch.rows[0], currency: currency.rows[0] };
    });

    expect(rows.branch).toMatchObject({ code: 'HQ', name_en: 'Head office' });
    // A dinar has three minor units — rounding money at two would be wrong here.
    expect(rows.currency?.minor_units).toBe(3);
  });

  it('keeps exactly one default branch under a burst of concurrent promotions', async () => {
    const ids: string[] = [];
    for (const code of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']) {
      const created = await api(ctx.server, 'post', '/api/v1/branches', {
        token: admin.token,
        body: { code, nameAr: `فرع ${code}` },
      });
      expect(created.status).toBe(201);
      ids.push((created.body.data as { id: string }).id);
    }

    // Every one of them tries to become the default at the same moment. The advisory
    // lock turns the race into a queue, so none of them fails and the partial unique
    // index is never violated.
    const responses = await Promise.all(
      ids.map((id) =>
        api(ctx.server, 'patch', `/api/v1/branches/${id}`, {
          token: admin.token,
          body: { isDefault: true },
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(ids.map(() => 200));

    const defaults = await withClient(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM branches WHERE tenant_id = $1 AND is_default AND deleted_at IS NULL',
        [admin.tenantId],
      );
      return rows;
    });
    expect(defaults).toHaveLength(1);
    expect(ids).toContain(defaults[0]?.id);
  });

  it('keeps exactly one default per kind when cash locations are created concurrently', async () => {
    const branchId = await withClient(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM branches WHERE tenant_id = $1 AND is_default LIMIT 1',
        [admin.tenantId],
      );
      return rows[0]?.id ?? '';
    });

    const responses = await Promise.all(
      ['S1', 'S2', 'S3', 'S4', 'B1', 'B2', 'B3', 'B4'].map((name) =>
        api(ctx.server, 'post', '/api/v1/cash-locations', {
          token: admin.token,
          body: {
            branchId,
            kind: name.startsWith('S') ? 'safe' : 'bank',
            name,
            isDefault: true,
            ...(name.startsWith('B') ? { bank: { bankName: `Bank ${name}` } } : {}),
          },
        }),
      ),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);

    const defaults = await withClient(async (client) => {
      const { rows } = await client.query<{ kind: string; count: string }>(
        `SELECT kind, count(*)::text AS count FROM cash_locations
          WHERE tenant_id = $1 AND is_default AND deleted_at IS NULL GROUP BY kind ORDER BY kind`,
        [admin.tenantId],
      );
      return rows;
    });

    expect(defaults).toEqual([
      { kind: 'bank', count: '1' },
      { kind: 'safe', count: '1' },
    ]);
  });
});
