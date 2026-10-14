import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import {
  usageMetricKeys,
  usageMetricRegistry,
  type PlatformUsageGridResponse,
  type UsageSnapshot,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, withTenantTx } from '@erp/database';

import { OBJECT_STORAGE } from '../src/modules/platform-services/index.js';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_TENANT_PERMISSIONS,
  createActor,
  type Actor,
  type ActorOptions,
} from './fixtures.js';
import { FakeObjectStorage } from './fakes.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/** صلاحيات عميلٍ كامل: ما يحتاجه السطح لكتابة فرعٍ وصنفٍ ورسالة. */
const CUSTOMER_PERMISSIONS = [
  ...ALL_TENANT_PERMISSIONS,
  ...ALL_ORGANIZATION_PERMISSIONS,
  'catalog.item.view',
  'catalog.item.manage',
  'sales.view',
  'sales.invoice.create',
];

/**
 * P-C5 — «الاستخدام والحصص» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * الخطة تطلب ثمانية اختبارات على الأقل؛ هذا الملف يقيس ما يمكن أن يفسد في القياس نفسه:
 *
 * 1. **الرقم يخالف دليله** — المقاييس الستة المشتقّة تُقرأ من الجداول، والعدّادان من
 *    `usage_counters`: يُثبته أن كل رقم يتحرّك حين يتحرّك مصدره وحده.
 * 2. **الحدّ يُطبَّق في المكان الخطأ** — الحدّ الذي وضعه مشغّل يمنع الكتابة في سطح العميل
 *    برمز `USAGE_LIMIT_REACHED`، والمغلّف الافتراضي في الفهرس يُبلَّغ عنه ولا يمنع.
 * 3. **الإشعار لا يُترك** — العبور إلى 80٪ يكتب `usage.soft_limit` مرة واحدة للفترة، والرفض
 *    يكتب `usage.limit_reached`.
 * 4. **العميل يرى غيره** — لقطة العميل لا تحمل إلا أرقامه، وشبكة المنصة هي التي ترى الكل،
 *    وصفوف `usage_counters` في القاعدة معزولة بين منشأتين.
 */

/** `ActorOptions` لا يعرف `platformRoles` بعد — نفس تضييق أسر P-C2. */
type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('platform usage & quotas (P-C5)', () => {
  let ctx: TestApp;
  // `import('…')` في موضع النوع + استيرادٌ ديناميكي وقت التشغيل: يُجنّبنا استيراداً نسبياً
  // من `../src` في أعلى ملف الاختبار (ترتيب الاستيراد لا يعرف له مجموعةً تُرضيه).
  let usage: import('../src/modules/usage/usage.service.js').UsageService;
  let owner: Actor;
  let operations: Actor;
  let auditor: Actor;
  let billing: Actor;
  let customerA: Actor;
  let customerB: Actor;

  const OPERATOR_TENANT = 'usage-ops';

  const snapshot = (actor: Actor, tenantId: string) =>
    api(ctx.server, 'get', `/api/v1/platform/usage?tenantId=${tenantId}`, { token: actor.token });

  const grid = (actor: Actor) => api(ctx.server, 'get', '/api/v1/platform/usage', { token: actor.token });

  const metric = (body: UsageSnapshot | PlatformUsageGridResponse, key: string) => {
    const metrics = 'metrics' in body ? body.metrics : body.tenants[0]?.metrics;
    return metrics?.find((entry) => entry.key === key);
  };

  /** كتابة حدٍّ للعميل كما تفعل بطاقة العميل (`PUT …/settings/:key`). */
  const setLimit = (key: string, value: number) =>
    api(ctx.server, 'put', `/api/v1/platform/tenants/${customerA.tenantId}/settings/${key}`, {
      token: owner.token,
      body: { value },
    });

  const clearLimit = (key: string) =>
    api(ctx.server, 'put', `/api/v1/platform/tenants/${customerA.tenantId}/settings/${key}`, {
      token: owner.token,
      body: { value: null },
    });

  const auditRows = (tenantId: string, action: string) =>
    withTenantTx(ctx.handle.db, tenantId, (tx) =>
      tx.execute(
        sql`SELECT action, meta, after FROM audit_log WHERE tenant_id = ${tenantId} AND action = ${action} ORDER BY created_at ASC`,
      ),
    );

  beforeAll(async () => {
    const storage = new FakeObjectStorage();
    ctx = await createTestApp('platform-usage', (builder) =>
      builder.overrideProvider(OBJECT_STORAGE).useValue(storage),
    );
    const { UsageService } = await import('../src/modules/usage/usage.service.js');
    usage = ctx.app.get(UsageService);

    customerA = await createActor(ctx, {
      tenantCode: 'usage-a',
      tenantName: 'شركة الاستخدام',
      email: 'owner@usage-a.test',
      permissions: CUSTOMER_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    customerB = await createActor(ctx, {
      tenantCode: 'usage-b',
      tenantName: 'شركة أخرى',
      email: 'owner@usage-b.test',
      permissions: CUSTOMER_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    owner = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'owner@usage-ops.test',
      permissions: [],
      roleNames: ['Console'],
      isOwner: false,
      platformRoles: ['platform_owner'],
    });
    operations = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'operations@usage-ops.test',
      permissions: [],
      roleNames: ['Console'],
      isOwner: false,
      platformRoles: ['platform_operations'],
    });
    auditor = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'auditor@usage-ops.test',
      permissions: [],
      roleNames: ['Console'],
      isOwner: false,
      platformRoles: ['platform_auditor'],
    });
    billing = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'billing@usage-ops.test',
      permissions: [],
      roleNames: ['Console'],
      isOwner: false,
      platformRoles: ['platform_billing'],
    });
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  // ─────────────────────────────────────────────── 1. الفهرس والقياس

  it('الفهرس ثمانية، والعقد يحملها كلها في اللقطة', async () => {
    const response = await snapshot(owner, customerA.tenantId);
    expect(response.status).toBe(200);
    const body = response.body.data as UsageSnapshot;
    expect(body.metrics.map((entry) => entry.key)).toEqual([...usageMetricKeys]);
    expect(body.metrics).toHaveLength(8);
    for (const entry of body.metrics) {
      expect(entry.unitAr.length).toBeGreaterThan(0);
      expect(['ok', 'soft', 'hard', 'unlimited']).toContain(entry.state);
      // بلا حدٍّ مضبوط: كل مقياس يعرض المغلّف الافتراضي ولا يطبّقه.
      expect(entry.enforced).toBe(false);
      expect(entry.limitSource).toBe('default');
    }
  });

  it('عدّاد استدعاءات الـAPI يزيد بالطلبات المسنَدة إلى منشأة وحدها', async () => {
    const before = (await snapshot(owner, customerA.tenantId)).body.data as UsageSnapshot;
    const beforeCount = metric(before, 'api_calls_per_day')?.used ?? 0;

    // ثلاثة طلبات من سطح العميل: كل واحد منها يُحتسب.
    for (let index = 0; index < 3; index += 1) {
      await api(ctx.server, 'get', '/api/v1/usage', { token: customerA.token });
    }
    // وطلبان في اللوحة: لا منشأة في السياق، فلا يُحتسبان على عميل.
    await grid(owner);
    await grid(owner);

    const after = (await snapshot(owner, customerA.tenantId)).body.data as UsageSnapshot;
    const afterCount = metric(after, 'api_calls_per_day')?.used ?? 0;
    expect(afterCount).toBe(beforeCount + 3);
    expect(after.apiCallsPerDay).toHaveLength(30);
    expect(after.apiCallsPerDay.at(-1)?.count).toBe(afterCount);
    expect(after.apiCallsPerDay.slice(0, 29).every((day) => day.count === 0)).toBe(true);
  });

  it('المقاييس المشتقّة تُقرأ من جداولها: فرع وصنف ومستخدم ورسالة', async () => {
    const before = (await snapshot(owner, customerA.tenantId)).body.data as UsageSnapshot;
    await api(ctx.server, 'post', '/api/v1/branches', {
      token: customerA.token,
      body: { code: 'U2', nameAr: 'فرع القياس' },
    });

    // صفوف حقيقة في القاعدة حيث لا مسار كتابةٍ سريع (صنف · رسالة · ملف جاهز).
    await withTenantTx(ctx.handle.db, customerA.tenantId, async (tx) => {
      const category = await tx.execute(sql`
        INSERT INTO item_categories (id, tenant_id, code, name_ar, created_at)
        VALUES (${newId()}, ${customerA.tenantId}, 'CAT-U2', 'تصنيف القياس', now())
        ON CONFLICT DO NOTHING RETURNING id
      `);
      const categoryId =
        category.rows[0]?.id ??
        (
          await tx.execute(sql`SELECT id FROM item_categories WHERE tenant_id = ${customerA.tenantId} LIMIT 1`)
        ).rows[0]?.id;
      const unit = await tx.execute(sql`
        INSERT INTO units_of_measure (id, tenant_id, code, name_ar, created_at)
        VALUES (${newId()}, ${customerA.tenantId}, 'UNT-U2', 'وحدة القياس', now())
        ON CONFLICT DO NOTHING RETURNING id
      `);
      const unitId =
        unit.rows[0]?.id ??
        (await tx.execute(sql`SELECT id FROM units_of_measure WHERE tenant_id = ${customerA.tenantId} LIMIT 1`))
          .rows[0]?.id;
      await tx.execute(sql`
        INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, created_at)
        VALUES (${newId()}, ${customerA.tenantId}, 'SKU-U2', 'صنف القياس', ${categoryId}, ${unitId}, now())
      `);
      await tx.execute(sql`
        INSERT INTO whatsapp_messages (id, tenant_id, phone, message, status, created_at)
        VALUES (${newId()}, ${customerA.tenantId}, '966500000000', 'قياس P-C5', 'sent', now())
      `);
      await tx.execute(sql`
        INSERT INTO files (id, tenant_id, bucket, object_key, name, mime, size_bytes, status, created_at)
        VALUES (${newId()}, ${customerA.tenantId}, 'erp', ${`usage/${newId()}`}, 'قياس.pdf', 'application/pdf', 3145728, 'ready', now())
      `);
    });

    const body = (await snapshot(owner, customerA.tenantId)).body.data as UsageSnapshot;
    const grew = (key: string, by: number) =>
      expect(metric(body, key)?.used).toBe((metric(before, key)?.used ?? 0) + by);
    grew('branches', 1);
    grew('items', 1);
    grew('whatsapp_per_month', 1);
    grew('storage_mb', 3);
    expect(metric(body, 'users')?.used).toBe(before.metrics.find((entry) => entry.key === 'users')?.used);
    expect(metric(body, 'email_sends_per_month')?.used).toBe(0);
  });

  // ─────────────────────────────────────────────── 2. الحدّ يمنع

  it('الحدّ الذي وضعه مشغّل يمنع عند 100٪ برمز USAGE_LIMIT_REACHED', async () => {
    expect((await setLimit('limits.max_items', 1)).status).toBe(200);
    const categories = await withTenantTx(ctx.handle.db, customerA.tenantId, (tx) =>
      tx.execute(sql`SELECT id FROM item_categories WHERE tenant_id = ${customerA.tenantId} LIMIT 1`),
    );
    const units = await withTenantTx(ctx.handle.db, customerA.tenantId, (tx) =>
      tx.execute(sql`SELECT id FROM units_of_measure WHERE tenant_id = ${customerA.tenantId} LIMIT 1`),
    );

    const createItem = () =>
      api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
        token: customerA.token,
        body: {
          sku: `SKU-${newId().slice(0, 8)}`,
          nameAr: 'صنف بعد الحدّ',
          categoryId: String(categories.rows[0]?.id),
          baseUnitId: String(units.rows[0]?.id),
        },
      });

    const refused = await createItem();
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('USAGE_LIMIT_REACHED');
    expect(refused.body.detail).toContain('الأصناف');
    expect((refused.body.errors as Array<Record<string, unknown>>)[0]).toMatchObject({ metric: 'items', limit: 1 });

    const rows = await auditRows(customerA.tenantId, 'usage.limit_reached');
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]?.meta).toMatchObject({ metric: 'items', scope: 'platform_console' });

    // ولا يتضاعف السطر مع كل محاولة: الفعل نفسه مرة واحدة للفترة.
    await createItem();
    expect((await auditRows(customerA.tenantId, 'usage.limit_reached')).rows.length).toBe(1);
  });

  it('العبور إلى 80٪ يُسجَّل «ناعماً» مرة واحدة، ويُعلَن في اللقطة', async () => {
    expect((await setLimit('limits.max_items', 4)).status).toBe(200);
    // المستهلك الآن 1 من 4 (25٪)؛ استهلاكٌ آخر يبلغ 50٪، فلا إشعار.
    const units = await withTenantTx(ctx.handle.db, customerA.tenantId, (tx) =>
      tx.execute(sql`SELECT id FROM units_of_measure WHERE tenant_id = ${customerA.tenantId} LIMIT 1`),
    );
    const categories = await withTenantTx(ctx.handle.db, customerA.tenantId, (tx) =>
      tx.execute(sql`SELECT id FROM item_categories WHERE tenant_id = ${customerA.tenantId} LIMIT 1`),
    );
    const addItem = (sku: string) =>
      api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
        token: customerA.token,
        body: { sku, nameAr: 'قياس الناعم', categoryId: String(categories.rows[0]?.id), baseUnitId: String(units.rows[0]?.id) },
      });

    expect((await setLimit('limits.max_items', 5)).status).toBe(200);
    expect((await addItem('SKU-SOFT-1')).status).toBe(201); // 2 من 5
    expect((await addItem('SKU-SOFT-2')).status).toBe(201); // 3 من 5
    expect((await auditRows(customerA.tenantId, 'usage.soft_limit')).rows.length).toBe(0);
    expect((await addItem('SKU-SOFT-3')).status).toBe(201); // 4 من 5 = 80٪
    const soft = await auditRows(customerA.tenantId, 'usage.soft_limit');
    expect(soft.rows.length).toBe(1);
    expect(soft.rows[0]?.meta).toMatchObject({ metric: 'items', scope: 'platform_console' });
    expect(soft.rows[0]?.after).toMatchObject({ metric: 'items', percent: 80, limit: 5 });

    const body = (await snapshot(owner, customerA.tenantId)).body.data as UsageSnapshot;
    const items = metric(body, 'items');
    expect(items?.state).toBe('soft');
    expect(items?.enforced).toBe(true);
    expect(items?.limitSource).toBe('tenant');
    expect(items?.percentUsed).toBe(80);
    expect(items?.noticeAr).toContain('اقترب');

    // وتكرار الكتابة لا يكرّر السطر (5 من 5 = 100٪، والحالة تصير صلبة).
    expect((await addItem('SKU-SOFT-4')).status).toBe(201);
    expect((await auditRows(customerA.tenantId, 'usage.soft_limit')).rows.length).toBe(1);

    expect((await clearLimit('limits.max_items')).status).toBe(200);
  });

  it('المغلّف الافتراضي في الفهرس يُبلَّغ عنه ولا يمنع', async () => {
    // customerB بلا أي تجاوز: حدّه هو افتراض الفهرس (`limits.max_branches = 1`).
    const before = (await snapshot(owner, customerB.tenantId)).body.data as UsageSnapshot;
    const branches = metric(before, 'branches');
    expect(branches?.limitSource).toBe('default');
    expect(branches?.limit).toBe(1);
    expect(branches?.enforced).toBe(false);

    const first = await api(ctx.server, 'post', '/api/v1/branches', {
      token: customerB.token,
      body: { code: 'B2', nameAr: 'فرع على الافتراضي' },
    });
    expect(first.status).toBe(201);
    const atLimit = (await snapshot(owner, customerB.tenantId)).body.data as UsageSnapshot;
    expect(metric(atLimit, 'branches')?.state).toBe('hard');
    expect(metric(atLimit, 'branches')?.noticeAr).toContain('لا رفض');

    // والفرع التالي يمرّ: المغلّف الافتراضي يُبلَّغ عنه ولا يمنع.
    const second = await api(ctx.server, 'post', '/api/v1/branches', {
      token: customerB.token,
      body: { code: 'B3', nameAr: 'فرع فوق الافتراضي' },
    });
    expect(second.status).toBe(201);
    const after = (await snapshot(owner, customerB.tenantId)).body.data as UsageSnapshot;
    expect(metric(after, 'branches')?.used).toBe(2);
  });

  it('التخزين مقياسٌ محدود: الرفض يقع قبل توقيع الرفع', async () => {
    expect((await setLimit('limits.max_storage_mb', 4)).status).toBe(200);
    const refused = await api(ctx.server, 'post', '/api/v1/files/presign', {
      token: customerA.token,
      body: { name: 'كبير.pdf', mime: 'application/pdf', sizeBytes: 4 * 1024 * 1024 },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('USAGE_LIMIT_REACHED');
    expect((refused.body.errors as Array<Record<string, unknown>>)[0]).toMatchObject({ metric: 'storage_mb' });

    // ملفٌّ في حدود المتاح يمرّ إلى التوقيع.
    const allowed = await api(ctx.server, 'post', '/api/v1/files/presign', {
      token: customerA.token,
      body: { name: 'صغير.pdf', mime: 'application/pdf', sizeBytes: 1024 * 1024 },
    });
    expect(allowed.status).toBe(201);
    expect((await clearLimit('limits.max_storage_mb')).status).toBe(200);
  });

  it('واتساب مقياسٌ محدود: الحدّ أولاً ثم إعدادات البوابة', async () => {
    expect((await setLimit('limits.max_whatsapp_per_month', 1)).status).toBe(200);
    const refused = await api(ctx.server, 'post', '/api/v1/whatsapp/send', {
      token: customerA.token,
      body: { invoiceId: newId(), phone: '966500000000' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('USAGE_LIMIT_REACHED');
    expect((refused.body.errors as Array<Record<string, unknown>>)[0]).toMatchObject({ metric: 'whatsapp_per_month' });
    expect((await clearLimit('limits.max_whatsapp_per_month')).status).toBe(200);
  });

  it('مقياس الجدول لا يُعدّ بعدّاد: العدّاد للاستدعاءات والبريد وحدهما', async () => {
    await expect(usage.record(customerA.tenantId, 'users')).rejects.toThrow(/يُقاس من الجدول/);
    const value = await usage.record(customerA.tenantId, 'email_sends_per_month', 2);
    expect(value).toBeGreaterThanOrEqual(2);
    const body = (await snapshot(owner, customerA.tenantId)).body.data as UsageSnapshot;
    expect(metric(body, 'email_sends_per_month')?.used).toBe(value);
  });

  // ─────────────────────────────────────────────── 3. الشبكة والتصدير والأبواب

  it('الشبكة تجمع كل العملاء والتصدير بيانٌ بالرمز المالي', async () => {
    const body = (await grid(owner)).body.data as PlatformUsageGridResponse;
    expect(body.period).toBe(new Date().toISOString().slice(0, 7));
    expect(body.tenants.length).toBeGreaterThanOrEqual(2);
    expect(body.tenants.map((row) => row.tenantCode)).toContain('usage-a');
    expect(body.tenants.every((row) => row.metrics.length === 8)).toBe(true);
    expect(body.totals.tenants).toBe(body.tenants.length);
    expect(body.totals.apiCallsToday).toBeGreaterThan(0);
    const codes = usageMetricRegistry.map((entry) => entry.labelAr);
    expect(codes.every((label) => body.tenants[0]?.metrics.some((entry) => entry.labelAr === label))).toBe(true);

    const csv = await request(ctx.server)
      .get('/api/v1/platform/usage/export.csv')
      .set('Authorization', `Bearer ${billing.token}`);
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(String(csv.headers['content-disposition'])).toContain('platform-usage.csv');
    const text = csv.text;
    expect(text.startsWith('\uFEFF')).toBe(true);
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'period,tenantCode,tenantName,metric,labelAr,used,limit,limitSource,percentUsed,state,enforced',
    );
    expect(lines.length).toBe(1 + body.tenants.length * 8);
    expect(lines.some((line) => line.includes('usage-a'))).toBe(true);
    expect(lines.some((line) => line.includes('الأصناف'))).toBe(true);
  });

  it('الأبواب: الدعم يقرأ الشبكة ولا يصدّر، والمدقّق كذلك، وجلسة المستأجر ممنوعة', async () => {
    expect((await grid(operations)).status).toBe(200);
    expect((await grid(auditor)).status).toBe(200);
    for (const operator of [operations, auditor]) {
      const denied = await api(ctx.server, 'get', '/api/v1/platform/usage/export.csv', { token: operator.token });
      expect(denied.status).toBe(403);
      expect(denied.body.detail).toBe('platform permission console.billing.manage required');
    }
    expect((await snapshot(billing, customerA.tenantId)).status).toBe(200);

    const tenantCall = await api(ctx.server, 'get', '/api/v1/platform/usage', { token: customerA.token });
    expect(tenantCall.status).toBe(403);
    const anonymous = await api(ctx.server, 'get', '/api/v1/platform/usage', { token: '' });
    expect(anonymous.status).toBe(401);
  });

  it('سطح العميل يقرأ أرقامه وحدها', async () => {
    const own = await api(ctx.server, 'get', '/api/v1/usage', { token: customerA.token });
    expect(own.status).toBe(200);
    const body = own.body.data as UsageSnapshot;
    expect(body.tenantId).toBe(customerA.tenantId);
    expect(body.tenantCode).toBe('usage-a');
    expect(body.metrics).toHaveLength(8);
    expect(metric(body, 'items')?.used).toBeGreaterThanOrEqual(1);

    const other = (await api(ctx.server, 'get', '/api/v1/usage', { token: customerB.token })).body
      .data as UsageSnapshot;
    expect(other.tenantId).toBe(customerB.tenantId);
    expect(other.tenantCode).toBe('usage-b');
    // لا أثر لعمل عميلٍ آخر في لقطة هذا العميل.
    expect(other.metrics.map((entry) => entry.used)).not.toEqual(body.metrics.map((entry) => entry.used));
  });

  // ─────────────────────────────────────────────── 4. العزل في القاعدة

  it('صفوف العدّاد معزولة: المعاملة الأخرى لا تراها، والطائرة الإدارية تراها', async () => {
    const rowsA = await withTenantTx(ctx.handle.db, customerA.tenantId, (tx) =>
      tx.execute(sql`SELECT tenant_id FROM usage_counters WHERE metric = 'api_calls_per_day'`),
    );
    expect(rowsA.rows.length).toBeGreaterThan(0);
    expect(rowsA.rows.every((row) => String(row.tenant_id) === customerA.tenantId)).toBe(true);

    const rowsB = await withTenantTx(ctx.handle.db, customerB.tenantId, (tx) =>
      tx.execute(sql`SELECT tenant_id FROM usage_counters`),
    );
    expect(rowsB.rows.every((row) => String(row.tenant_id) === customerB.tenantId)).toBe(true);
    expect(rowsB.rows.some((row) => String(row.tenant_id) === customerA.tenantId)).toBe(false);

    const adminRows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM usage_counters`),
    );
    expect(Number(adminRows.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(rowsA.rows.length);
  });
});
