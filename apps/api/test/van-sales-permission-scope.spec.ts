import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🚐 نطاق صلاحيات التوزيع (§5) + الترحيل `0126` الذي يكتب ما كان ضميناً.
 *
 * القاعدة القديمة في `permissionGrants` كانت تمنح كل كود `van_sales.*` — ومنها
 * `van_sales.closing.approve` (اعتماد إغلاق العهدة وتسوية العجز) و`van_sales.override.approve`
 * (تجاوز الأسعار المثبّتة وسقوف البونص) — لأي دور يملك `sales.invoice.create` ولا يملك كود
 * توزيع صريحاً. كاتب الفواتير يصير معتمِداً للتسويات بلا قرار مدير وبلا صفّ يُرى في شاشة
 * الأدوار. الكود صار يستنتج القراءة والتشغيل وحدهما، والترحيل `0126` يكتب للأدوار القائمة
 * ما كانت تملكه ضمناً حتى لا يُحرم مستخدم من صلاحية كان يستعملها، وحتى تصير الصلاحية مرئية
 * وقابلة للسحب.
 *
 * يُختبر على قاعدة اختبار معزولة، عبر HTTP الحقيقي (الحارس نفسه، لا دالة نقية):
 *   1. كاتب الفواتير يقرأ ويصدر ويحصّل ويقدّم إغلاقه؛
 *   2. ويرفضه الخادم 403 على الأكواد الخمسة التي لا تُستنتَج؛
 *   3. دورٌ ضُبط للتوزيع صراحةً يحكم نفسه: إعدادُه الصريح يُنهي استنتاج المبيعات؛
 *   4. الترحيل يكتب الأكواد الخمسة ⇒ **نفس الرمز** صار يمرّ على الاعتماد (403 ⇒ 404/409)؛
 *   5. ولا يمسّ دوراً مضبوطاً صراحةً، وهو قابل للتكرار؛
 *   6. ملف التراجع يحذفها فيعود المنع، وملف الصعود يعيدها؛
 *   7. `0123`–`0126` مطابقة لبصمتها المسجَّلة — لم يُعدَّل ترحيل تاريخي.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../packages/database/migrations', import.meta.url));
const UP_NAME = '0126_explicit_van_sales_permissions.sql';
const DOWN_NAME = 'down/0126_explicit_van_sales_permissions.down.sql';
const PREVIOUS_NAMES = [
  '0123_van_sales_rep_workspace_and_receipt_workflow.sql',
  '0124_van_sales_stock_and_custody_settlement.sql',
  '0125_journal_reversal_convention.sql',
];

/** الأكواد التي لا تمنحها صلاحيات المبيعات أبداً — نفس القائمة المعتمدة في العقود. */
const NEVER_IMPLIED = [
  'van_sales.production.manage',
  'van_sales.pricing.manage',
  'van_sales.load.manage',
  'van_sales.closing.approve',
  'van_sales.override.approve',
] as const;

const readSql = (relative: string): Promise<string> => fs.readFile(`${MIGRATIONS}/${relative}`, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('van-sales permission scope and migration 0126', () => {
  let ctx: TestApp;
  let pool: Pool;
  /** كاتب فواتير: صلاحيات مبيعات فقط، بلا أي كود توزيع صريح. */
  let clerk: Actor;
  /** دور ضُبط للتوزيع صراحةً (إنتاج فقط) — إعدادُه الصريح هو الحاكم. */
  let productionOnly: Actor;

  const clerkRoleId = (): string => clerk.roleIds[0] ?? '';

  const codesOf = async (roleId: string): Promise<string[]> => {
    const rows = await pool.query(
      `SELECT permission_code FROM role_permissions WHERE role_id = $1 ORDER BY permission_code`,
      [roleId],
    );
    return rows.rows.map((row) => (row as { permission_code: string }).permission_code);
  };

  const post = (actor: Actor, path: string, body: Record<string, unknown> = {}) =>
    api(ctx.server, 'post', path, { token: actor.token, body });

  beforeAll(async () => {
    ctx = await createTestApp('van-sales-permission-scope');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });

    clerk = await createActor(ctx, {
      tenantCode: 'perm-scope',
      tenantName: 'مخابز نطاق الصلاحيات',
      email: 'clerk@perm-scope.test',
      permissions: ['tenant.view', 'sales.view', 'sales.invoice.create'],
      roleNames: ['Clerk'],
      isOwner: false,
    });
    productionOnly = await createActor(ctx, {
      tenantId: clerk.tenantId,
      tenantCode: 'perm-scope',
      email: 'production@perm-scope.test',
      permissions: ['tenant.view', 'sales.view', 'sales.invoice.create', 'van_sales.production.manage'],
      roleNames: ['ProductionOnly'],
      isOwner: false,
    });

    // فرع ومستودع افتراضيان حتى لا تفشل القراءة لسبب تنظيمي لا علاقة له بالصلاحيات.
    await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(clerk.tenantId);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  it('lets an invoice clerk read and operate the distribution surface', async () => {
    const dashboard = await api(ctx.server, 'get', '/api/v1/van-sales/dashboard', {
      token: clerk.token,
    });
    expect(dashboard.status, JSON.stringify(dashboard.body)).not.toBe(403);

    // التشغيل: إصدار فاتورة توزيع، تحصيل مديونية، وتقديم إغلاق الوردية للتفتيش.
    for (const [path, body] of [
      ['/api/v1/van-sales/documents', { lines: [] }],
      ['/api/v1/van-sales/collections', { documentId: randomUUID(), collectedAmount: '10' }],
      [`/api/v1/van-sales/load-orders/${randomUUID()}/submit-closing`, { collectedCash: '0' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const response = await post(clerk, path, body);
      // قد يفشل المستند نفسه (404/409/422) — المهم أنه لم يُرفض من الحارس.
      expect(response.status, `${path} must not be refused by the guard`).not.toBe(403);
    }
  });

  it('refuses approval, override, loading, pricing and production without an explicit grant', async () => {
    expect((await codesOf(clerkRoleId())).filter((code) => code.startsWith('van_sales.'))).toEqual([]);

    const probes: Array<[string, Record<string, unknown>, string]> = [
      [
        `/api/v1/van-sales/load-orders/${randomUUID()}/approve-closing`,
        { actualRemainingQty: '0', remainingAction: 'return_to_main' },
        'van_sales.closing.approve',
      ],
      ['/api/v1/van-sales/legacy-reconciliation', { mode: 'dry_run' }, 'van_sales.override.approve'],
      [
        '/api/v1/van-sales/load-orders',
        { salesmanId: randomUUID(), lines: [{ itemId: randomUUID(), qty: '1' }] },
        'van_sales.load.manage',
      ],
      [
        '/api/v1/van-sales/customer-prices',
        { partyId: randomUUID(), unitPrice: '10' },
        'van_sales.pricing.manage',
      ],
      [
        '/api/v1/van-sales/production-batches',
        { itemId: randomUUID(), producedQty: '1' },
        'van_sales.production.manage',
      ],
    ];

    for (const [path, body, code] of probes) {
      const response = await post(clerk, path, body);
      expect(response.status, `${code} must be refused for ${path}`).toBe(403);
    }
  });

  it('lets an explicitly configured distribution role govern itself', async () => {
    // الإنتاج مُنح صراحةً ⇒ يمرّ.
    const production = await post(productionOnly, '/api/v1/van-sales/production-batches', {
      itemId: randomUUID(),
      producedQty: '1',
    });
    expect(production.status, JSON.stringify(production.body)).not.toBe(403);

    // والإصدار لم يُمنح صراحةً، ووجود إعداد صريح للتوزيع يُنهي استنتاج المبيعات ⇒ 403.
    const invoice = await post(productionOnly, '/api/v1/van-sales/documents', { lines: [] });
    expect(invoice.status, 'an explicit distribution setup must end the sales inference').toBe(403);
  });

  it('migration 0126 writes the implicit privilege down, and the same token may then approve', async () => {
    const before = await codesOf(clerkRoleId());
    await pool.query(await readSql(UP_NAME));
    const after = await codesOf(clerkRoleId());

    // الأكواد الخمسة صارت صفوفًا حقيقية: تُرى في شاشة الأدوار وتُسحب منها.
    for (const code of NEVER_IMPLIED) {
      expect(after, `${code} must now be an explicit row`).toContain(code);
    }
    expect(after.filter((code) => before.includes(code))).toEqual(before);

    // ونفس الرمز الذي كان يُرفض صار يمرّ على الحارس (ويفشل على المستند نفسه لا على الصلاحية).
    const approve = await post(
      clerk,
      `/api/v1/van-sales/load-orders/${randomUUID()}/approve-closing`,
      { actualRemainingQty: '0', remainingAction: 'return_to_main' },
    );
    expect(approve.status, JSON.stringify(approve.body)).not.toBe(403);
    const reconcile = await post(clerk, '/api/v1/van-sales/legacy-reconciliation', { mode: 'dry_run' });
    expect(reconcile.status, JSON.stringify(reconcile.body)).not.toBe(403);
  });

  it('leaves an explicitly configured role alone and changes nothing when re-applied', async () => {
    const configuredBefore = await codesOf(productionOnly.roleIds[0] ?? '');
    expect(configuredBefore).toContain('van_sales.production.manage');
    const clerkBefore = await codesOf(clerkRoleId());

    await pool.query(await readSql(UP_NAME));

    // الدور المضبوط صراحةً لا يُمسّ، والتكرار لا يضيف ولا يحذف شيئًا لأي دور.
    expect(await codesOf(productionOnly.roleIds[0] ?? '')).toEqual(configuredBefore);
    expect(await codesOf(clerkRoleId())).toEqual(clerkBefore);
  });

  it('rolls back through the down file and comes back through the up file', async () => {
    await pool.query(await readSql(DOWN_NAME));
    const rolled = await codesOf(clerkRoleId());
    for (const code of NEVER_IMPLIED) {
      expect(rolled, `${code} must be gone after the down file`).not.toContain(code);
    }
    // والمنع يعود فورًا: الحارس يقرأ `role_permissions` في كل طلب.
    const refused = await post(
      clerk,
      `/api/v1/van-sales/load-orders/${randomUUID()}/approve-closing`,
      { actualRemainingQty: '0', remainingAction: 'return_to_main' },
    );
    expect(refused.status).toBe(403);

    await pool.query(await readSql(UP_NAME));
    const restored = await codesOf(clerkRoleId());
    for (const code of NEVER_IMPLIED) {
      expect(restored, `${code} must come back with the up file`).toContain(code);
    }
  });

  it('leaves the historical migrations exactly as they were recorded', async () => {
    const result = await pool.query(
      `SELECT name, checksum FROM erp_migrations WHERE name LIKE '012%' ORDER BY name`,
    );
    const recorded = new Map(
      (result.rows as Array<{ name: string; checksum: string }>).map((row) => [row.name, row.checksum]),
    );
    for (const name of [...PREVIOUS_NAMES, UP_NAME]) {
      const onDisk = await readSql(name);
      expect(recorded.get(name), `${name} must be recorded as applied`).toBeTruthy();
      expect(sha256(onDisk), `${name} must not be edited after it was applied`).toBe(recorded.get(name));
    }
  });
});
