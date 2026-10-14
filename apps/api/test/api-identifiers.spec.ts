import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🔑 R6 — «معالج UUID عام (500 → 400)» (`INCOMPLETE_INVENTORY.md` §5 و§7-1).
 *
 * كان معرّفٌ لا صيغة له في الرابط يبلغ قاعدة البيانات (`where id = 'not-a-uuid'`) فيردّ
 * Postgres `invalid input syntax for type uuid` ويخرج للمستخدم **500 INTERNAL** مع تتبّعٍ
 * في السجلّ وكأنّ العطل عطلُنا؛ وهو في الحقيقة طلبٌ معطوب. وهذا السبيك يثبّت الطبقتين:
 *
 *   1. `UuidParamPipe` على **معاملات المسار** ذات الأسماء التي تعني معرّف صفّ ⇒
 *      `INVALID_ID` **400** مع اسم المعامل في `errors[0].field`، قبل قاعدة البيانات.
 *   2. مرشّح الاستثناءات يترجم `22P02` القادم من **جسم** الطلب أو **مرشّح** الاستعلام ⇒
 *      `INVALID_ID` 400 كذلك.
 *
 * ولا يُوسَّع الحارس على ما ليس معرّفاً: مفاتيح الإعدادات، ورموز التقارير، وأكواد
 * الباركود، وعنوان الصفحة (`slug`)، ومعرّفات الطرف الخارجي (`remoteId` في سلة) — كلها
 * تمضي كما كانت.
 */
describe('API identifiers — معالج UUID العام', () => {
  let ctx: TestApp;
  let actor: Actor;

  let partyId = '';
  let categoryId = '';
  let baseUnitId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const problems = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
    (body.errors as Array<Record<string, unknown>>) ?? [];
  const bad = 'not-a-uuid';

  /** مسارات بمعرّفٍ في الرابط — تختبر كل الأفعال وفي وحداتٍ مختلفة. */
  const routes: Array<[string, string, string]> = [
    ['get', `/api/v1/sales/invoices/${bad}`, 'id'],
    ['post', `/api/v1/sales/invoices/${bad}/post`, 'id'],
    ['patch', `/api/v1/sales/invoices/${bad}`, 'id'],
    ['post', `/api/v1/sales/invoices/${bad}/void`, 'id'],
    ['get', `/api/v1/purchase-invoices/${bad}`, 'id'],
    ['get', `/api/v1/parties/${bad}`, 'id'],
    ['put', `/api/v1/parties/${bad}`, 'id'],
    ['get', `/api/v1/parties/${bad}/statement`, 'id'],
    ['get', `/api/v1/inventory/vouchers/${bad}`, 'id'],
    ['post', `/api/v1/inventory/vouchers/${bad}/post`, 'id'],
    ['get', `/api/v1/inventory/adjustments/${bad}`, 'id'],
    ['post', `/api/v1/inventory/transfers/${bad}/send`, 'id'],
    ['delete', `/api/v1/organization/catalog/items/${bad}`, 'id'],
    ['get', `/api/v1/organization/catalog/items/${bad}/units`, 'id'],
    ['patch', `/api/v1/organization/catalog/items/${bad}`, 'id'],
    ['get', `/api/v1/journal-entries/${bad}`, 'id'],
    ['get', `/api/v1/cash-locations/${bad}/balance`, 'id'],
    ['post', `/api/v1/pos/holds/${bad}/recall`, 'id'],
    ['get', `/api/v1/hrm/employees/${bad}`, 'id'],
    ['post', `/api/v1/fiscal-periods/${bad}/close`, 'id'],
  ];

  beforeAll(async () => {
    ctx = await createTestApp('api-ids');
    actor = await createActor(ctx, {
      tenantCode: 'api-ids',
      email: 'owner@api-ids.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'sales.invoice.void',
        'purchase.view',
        'purchase.invoice.post',
        'parties.view',
        'parties.manage',
        'inventory.view',
        'inventory.adjust',
        'inventory.transfer',
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'accounting.journal.create',
        'accounting.journal.post',
        'accounting.reports.view',
        'accounting.period.close',
        'accounting.account.view',
        'hrm.view',
        'treasury.view',
        'pos.operate',
        'pos.view',
      ],
    });

    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', {
      token: actor.token,
      body: { code: 'GEN', nameAr: 'عام' },
    });
    categoryId = data(category.body).id as string;
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PCS', nameAr: 'حبة' },
    });
    baseUnitId = data(unit.body).id as string;
    const party = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { code: 'C-1', name: 'عميل نقدي', kind: 'customer' },
    });
    partyId = data(party.body).id as string;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. معرّفٌ معطوب في المسار ⇒ 400 `INVALID_ID` يسمّي المعامل — لا 500', async () => {
    for (const [method, path, field] of routes) {
      const response = await api(ctx.server, method as 'get', path, { token: actor.token });
      const body = response.body as Record<string, unknown>;
      expect(`${method} ${path} → ${response.status}`, `${method} ${path}`).toBe(`${method} ${path} → 400`);
      expect(body.code, path).toBe('INVALID_ID');
      expect(body.title, path).toBe('Identifier is not a valid UUID');
      expect(problems(body)[0]?.field, path).toBe(field);
      // الردّ لا يحمل استعلاماً ولا صيغةً داخلية.
      expect(JSON.stringify(body), path).not.toContain('select');
      expect(JSON.stringify(body), path).not.toContain('22P02');
    }
  });

  it('2. المسار المتعدّد المعرّفات يسمّي **كل** معرّفٍ معطوب على حدة', async () => {
    const first = await api(ctx.server, 'delete', `/api/v1/parties/${bad}/contacts/${bad}`, {
      token: actor.token,
    });
    expect(first.status).toBe(400);
    // مسارٌ بمعرّفَين: الردّ يسمّي أحد المعرّفين المعطوبين (واسم الدالة نفسه لا يُختبَر).
    expect(['partyId', 'contactId']).toContain(problems(first.body as Record<string, unknown>)[0]?.field);

    // المعرّف الأول سليم والثاني معطوب: الردّ يسمّي الثاني لا الأول.
    const secondParam = await api(ctx.server, 'delete', `/api/v1/parties/${partyId}/contacts/${bad}`, {
      token: actor.token,
    });
    expect(secondParam.status).toBe(400);
    expect(problems(secondParam.body as Record<string, unknown>)[0]?.field).toBe('contactId');

    const table = await api(ctx.server, 'post', `/api/v1/pos/tables/${bad}/items`, {
      token: actor.token,
    });
    expect(table.status).toBe(400);
    expect((table.body as Record<string, unknown>).code).toBe('INVALID_ID');
  });

  it('3. معرّفٌ صالح لكنه مجهول ⇒ 404 مُعلَن — لا 500 ولا 200 بجسمٍ فارغ', async () => {
    const unknown = '0199aaaa-1111-7000-8000-000000000abc';

    const missing = await api(ctx.server, 'get', `/api/v1/sales/invoices/${unknown}`, {
      token: actor.token,
    });
    expect([404, 422]).toContain(missing.status);
    expect((missing.body as Record<string, unknown>).code).not.toBe('INTERNAL');

    // 🔑 عيبان أصلحهما R6: بطاقة حساب كانت **500**، وبطاقة عميل كانت **200 بجسمٍ فارغ**.
    const party = await api(ctx.server, 'get', `/api/v1/parties/${unknown}`, { token: actor.token });
    expect(party.status).toBe(404);
    const partyBody = party.body as Record<string, unknown>;
    expect(partyBody.code).toBe('PARTY_NOT_FOUND');
    expect(JSON.stringify(partyBody).length).toBeGreaterThan(0);

    const account = await api(ctx.server, 'get', `/api/v1/accounts/${unknown}`, {
      token: actor.token,
    });
    expect(account.status).toBe(404);
    expect((account.body as Record<string, unknown>).code).toBe('ACCOUNT_NOT_FOUND');

    // والكتابة على عميلٍ غير موجود تُعلن الغياب بدل أن تكتب صفرَ صفوف وتقول «تمّ».
    const update = await api(ctx.server, 'put', `/api/v1/parties/${unknown}`, {
      token: actor.token,
      body: { name: 'اسم جديد' },
    });
    expect(update.status).toBe(404);
    const remove = await api(ctx.server, 'delete', `/api/v1/parties/${unknown}`, {
      token: actor.token,
    });
    expect(remove.status).toBe(404);
    const contacts = await api(ctx.server, 'get', `/api/v1/parties/${unknown}/contacts`, {
      token: actor.token,
    });
    expect(contacts.status).toBe(404);
    const ledger = await api(ctx.server, 'get', `/api/v1/parties/${unknown}/statement`, {
      token: actor.token,
    });
    expect(ledger.status).toBe(404);
  });

  it('4. معرّفٌ معطوب في **جسم** الطلب ⇒ 400 لا 500 (خطأ Postgres `22P02` مُترجَم)', async () => {
    const branch = await api(ctx.server, 'get', '/api/v1/branches', { token: actor.token });
    const rows = ((branch.body as { data?: unknown }).data ?? branch.body) as Array<Record<string, unknown>>;
    const warehouseId = rows[0]?.id as string;

    const voucher = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId: bad,
        warehouseId,
        kind: 'stock_in',
        reason: 'وارد',
        lines: [{ itemId: bad, qty: '1' }],
      },
    });
    expect(voucher.status).toBe(400);
    const voucherBody = voucher.body as Record<string, unknown>;
    expect(voucherBody.code).toBe('INVALID_ID');
    expect(voucherBody.title).toBe('Identifier is not a valid UUID');
    expect(JSON.stringify(voucherBody)).not.toContain('invalid input syntax');
  });

  it('5. معرّفٌ معطوب في **مرشّح** الاستعلام ⇒ 400 لا 500', async () => {
    const levels = await api(ctx.server, 'get', `/api/v1/inventory/levels?warehouse_id=${bad}`, {
      token: actor.token,
    });
    expect(levels.status).toBe(400);
    expect((levels.body as Record<string, unknown>).code).toBe('INVALID_ID');

    const movements = await api(ctx.server, 'get', `/api/v1/inventory/movements?item_id=${bad}`, {
      token: actor.token,
    });
    expect(movements.status).toBe(400);
    expect((movements.body as Record<string, unknown>).code).toBe('INVALID_ID');
  });

  it('6. ما ليس معرّف صفٍّ لم يُمسّ: المفاتيح والرموز والباركود والعنوان', async () => {
    // مفتاح إعداد لا معرّف: يردّ 404 على مفتاحٍ غير مُسجَّل، لا 400 معرّف.
    const setting = await api(ctx.server, 'get', '/api/v1/settings/inventory.defaultWarehouseId', {
      token: actor.token,
    });
    expect([200, 404]).toContain(setting.status);
    expect((setting.body as Record<string, unknown>).code).not.toBe('INVALID_ID');

    // رمز تقرير مكتوب بحروف: العقد يتوقّع `reporting.view` ثم بحثاً في الفهرس.
    const report = await api(ctx.server, 'get', '/api/v1/reports/inventory-turnover', {
      token: actor.token,
    });
    expect(report.status).not.toBe(400);

    // باركود: نصّ حرّ بالتصميم.
    const barcode = await api(ctx.server, 'get', '/api/v1/inventory/barcode/BOX-123', {
      token: actor.token,
    });
    expect(barcode.status).not.toBe(400);

    // كود صنفٍ في جسم الطلب نصٌّ حرّ أيضاً (sku).
    const item = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: { sku: 'SKU-XYZ-1', nameAr: 'صنف', categoryId, baseUnitId },
    });
    expect(item.status).toBe(201);
    expect((data(item.body) as Record<string, unknown>).sku).toBe('SKU-XYZ-1');
  });

  it('7. المعرّفات الصحيحة تعمل كما كانت: مسارٌ حقيقي بمعرّفٍ حقيقي', async () => {
    const party = await api(ctx.server, 'get', `/api/v1/parties/${partyId}`, {
      token: actor.token,
    });
    expect(party.status).toBe(200);
    expect((data(party.body) as Record<string, unknown>).id).toBe(partyId);
  });
});
