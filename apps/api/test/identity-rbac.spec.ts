import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * R1 — «مطابقة شاشتي المستخدمين والصلاحيات» (`docs/roadmap/AUDIT_PHASES_01_04.md` §6).
 *
 * يقابل نوافذ الديسكتوب: `Form_WPF/frmAddUsers.xaml(+.cs)` (بطاقة المستخدم ودعوته) و
 * `frmUsersPermissions.xaml(+.cs)` (مصفوفة النماذج × الأفعال الخمسة وحدود الخصم) و
 * `frmOperPermission.xaml(+.cs)` (صلاحيات العمليات) و`Class/User.cs` (الخصائص الثابتة
 * العمليات المسموحة) و`Class/FormPermission.cs` (الأعلام الخمسة).
 *
 * وما يُثبَت هنا، بترتيب عمل الشاشتين:
 *
 *   1. **دعوة مستخدم** — تُنشئ عضويةً بأدوارٍ ونطاق فرع، وتُرفض بأدوارٍ مجهولة أو مكرَّرة؛
 *   2. **نطاق الفرع** — يُحفظ ويُقرأ، و`null` تعني «كل الفروع»؛
 *   3. **مصفوفة الصلاحيات** — الدور يحمل رموزاً من السجل، و`/me` يعيد اتحاد الرموز؛
 *   4. **الرفض** — مَن لا رمز له لا يمرّ (`403`)، ولا يرى عضويّة مستأجرٍ آخر (`404`)؛
 *   5. **حدّ الخصم** — بديل `OperMaxDiscount`: نسبةٌ وقيمة على العضوية، يُفحصان في الخادم
 *      عند كتابة الخصم في فاتورة البيع وفي كاشير نقطة البيع، ويُرفضان بـ
 *      `DISCOUNT_LIMIT_EXCEEDED` (422) مع تفصيل الحدّ المُخترَق.
 */
describe('identity & rbac — مطابقة شاشتي المستخدمين والصلاحيات (R1)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let capped: Actor;
  let viewer: Actor;
  let outsider: Actor;
  let branchId = '';
  let secondBranchId = '';
  let warehouseId = '';
  let itemId = '';
  let partyId = '';

  const body = (response: { body: Record<string, unknown> }) =>
    (response.body.data ?? response.body) as Record<string, any>;
  const call = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    options: { token: string; body?: unknown },
  ) => api(ctx.server, method, `/api/v1${path}`, options);

  /** فاتورة بيع مسودّة بخصم رأس — أساس كل فحص حدّ. */
  const draftInvoice = (discount: string, token = owner.token) =>
    call('post', '/sales/invoices', {
      token,
      body: {
        branchId,
        warehouseId,
        cashCustomerName: 'عميل نقدي',
        invoiceDiscount: discount,
        lines: [{ itemId, quantity: '1', unitPrice: '1000', taxRate: '15' }],
      },
    });

  async function roleWithCodes(name: string, codes: string[]): Promise<string> {
    const created = await call('post', '/roles', {
      token: owner.token,
      body: { name, permissionCodes: codes },
    });
    if (created.status >= 300) throw new Error(`role: ${created.status} ${JSON.stringify(created.body)}`);
    return String(body(created).id);
  }

  beforeAll(async () => {
    ctx = await createTestApp('identity-rbac');
    const ownerPermissions = [
      ...ALL_TENANT_PERMISSIONS,
      ...ALL_ORGANIZATION_PERMISSIONS,
      'catalog.item.view',
      'catalog.item.manage',
      'catalog.unit.manage',
      'catalog.category.manage',
      'inventory.view',
      'inventory.adjust',
      'parties.view',
      'parties.manage',
      'sales.view',
      'sales.invoice.create',
      'sales.invoice.post',
      'pos.view',
      'pos.operate',
      'accounting.period.close',
      'tenant.membership.manage',
      'tenant.role.manage',
    ];

    owner = await createActor(ctx, {
      tenantCode: 'rbac',
      email: 'owner@rbac.test',
      permissions: ownerPermissions,
    });
    const org = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(owner.tenantId);
    branchId = org.branchId;
    warehouseId = org.warehouseId;

    const year = new Date().getUTCFullYear();
    await call('post', '/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });

    const secondBranch = await call('post', '/branches', {
      token: owner.token,
      body: { code: 'B2', nameAr: 'فرع ثانٍ', nameEn: 'Second branch' },
    });
    secondBranchId = String(body(secondBranch).id);

    const unit = body(
      await call('post', '/organization/catalog/units', {
        token: owner.token,
        body: { code: 'PCE', nameAr: 'حبة' },
      }),
    ).id;
    const category = body(
      await call('post', '/organization/catalog/categories', {
        token: owner.token,
        body: { code: 'GEN', nameAr: 'عام' },
      }),
    ).id;
    itemId = body(
      await call('post', '/organization/catalog/items', {
        token: owner.token,
        body: {
          sku: 'RBAC-1',
          nameAr: 'صنف الاختبار',
          categoryId: category,
          baseUnitId: unit,
          kind: 'stock',
          salePrice: '1000',
        },
      }),
    ).id;
    await call('post', '/inventory/ledger/record', {
      token: owner.token,
      body: {
        lines: [
          {
            itemId,
            warehouseId,
            qty: '100',
            unitCost: '700',
            direction: 'in',
            docType: 'opening',
            docId: randomUUID(),
          },
        ],
      },
    });
    partyId = String(
      body(
        await call('post', '/parties', {
          token: owner.token,
          body: { kind: 'customer', name: 'عميل الآجل' },
        }),
      ).id,
    );

    // فاعل بحدّ خصم: نسبة 5٪ وقيمة 10 — كلٌّ منهما يُختبَر وحده.
    capped = await createActor(ctx, {
      tenantCode: 'rbac',
      tenantId: owner.tenantId,
      email: 'capped@rbac.test',
      permissions: ['sales.view', 'sales.invoice.create', 'pos.operate', 'sales.invoice.post'],
      isOwner: false,
      maxDiscountPct: '5.0000',
      maxDiscountAmount: '10.0000',
    });

    // مَن لا يملك `tenant.membership.manage` (الديسكتوب: نافذةٌ تُفتح ولا تُحفظ).
    viewer = await createActor(ctx, {
      tenantCode: 'rbac',
      tenantId: owner.tenantId,
      email: 'viewer@rbac.test',
      permissions: ['tenant.view'],
      isOwner: false,
    });

    outsider = await createActor(ctx, {
      tenantCode: 'rbac-other',
      email: 'owner@rbac-other.test',
      permissions: ownerPermissions,
    });
  }, 300_000);

  afterAll(async () => ctx.close());

  // ── 1. دعوة مستخدم (frmAddUsers) ────────────────────────────────────────────────

  it('lists memberships with their roles, branch scope and discount limits', async () => {
    const response = await call('get', '/memberships', { token: owner.token });
    expect(response.status).toBe(200);
    // القائمة مغلّفةٌ بنفسها: `{ data, meta }` — لا `data` داخل `data`.
    const rows = response.body.data as Array<Record<string, unknown>>;
    // المالك + المحاسب المحدود + القارئ: ثلاث عضويات في هذا المستأجر حتى هذه اللحظة.
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const cappedRow = rows.find((row) => row.id === capped.membershipId);
    expect(cappedRow?.maxDiscountPct).toBe('5.0000');
    expect(cappedRow?.maxDiscountAmount).toBe('10.0000');

    const ownerRow = rows.find((row) => row.id === owner.membershipId);
    expect(ownerRow?.maxDiscountPct).toBeNull();
    expect(ownerRow?.maxDiscountAmount).toBeNull();
  });

  it('invites a user with a role and a branch scope, and reads it back', async () => {
    const email = `invited-${Date.now()}@rbac.test`;
    const created = await call('post', '/memberships', {
      token: owner.token,
      body: {
        email,
        fullName: 'موظف مدعو',
        roleIds: [await roleWithCodes(`Invitee-${Date.now()}`, ['sales.view'])],
        branchScope: [secondBranchId],
        maxDiscountPct: '7.5000',
      },
    });
    expect(created.status).toBeLessThan(300);
    const membership = body(created);
    expect(membership.displayName).toBe('موظف مدعو');
    expect(membership.status).toBe('invited');
    expect(membership.branchScope).toEqual([secondBranchId]);
    expect(membership.maxDiscountPct).toBe('7.5000');
    // «أعلى قيمة للخصم» لم تُرسل ⇒ بلا حدّ، لا صفراً.
    expect(membership.maxDiscountAmount).toBeNull();

    const read = await call('get', `/memberships/${membership.id}`, { token: owner.token });
    expect(body(read).branchScope).toEqual([secondBranchId]);
  });

  it('rejects an invite with an unknown role id (no silent partial grant)', async () => {
    const response = await call('post', '/memberships', {
      token: owner.token,
      body: { email: `ghost-${Date.now()}@rbac.test`, roleIds: [randomUUID()] },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a duplicate membership for the same user in one tenant', async () => {
    const first = await call('post', '/memberships', {
      token: owner.token,
      body: { email: owner.email, roleIds: [await roleWithCodes(`Dup-${Date.now()}`, ['sales.view'])] },
    });
    expect(first.status).toBeGreaterThanOrEqual(400);
  });

  // ── 2. حدّ الخصم (OperMaxDiscount) ─────────────────────────────────────────────

  it('refuses a percent above the limit with the limit named in the problem details', async () => {
    const membership = await call('patch', `/memberships/${capped.membershipId}`, {
      token: owner.token,
      body: { maxDiscountAmount: null },
    });
    expect(membership.status).toBeLessThan(300);
    expect(body(membership).maxDiscountAmount).toBeNull();

    const response = await draftInvoice('60', capped.token); // 6٪ > 5٪
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('DISCOUNT_LIMIT_EXCEEDED');
    const fault = (response.body.errors as Array<Record<string, unknown>>)[0];
    expect(fault?.limitKind).toBe('percent');
    expect(fault?.discountPct).toBe('6.0000');
  });

  it('refuses an amount above the limit even when the percentage is acceptable', async () => {
    const restored = await call('patch', `/memberships/${capped.membershipId}`, {
      token: owner.token,
      body: { maxDiscountAmount: '10.0000' },
    });
    expect(restored.status).toBeLessThan(300);

    const response = await draftInvoice('11', capped.token); // 1.1٪ ✓ لكن 11 > 10
    expect(response.status).toBe(422);
    const fault = (response.body.errors as Array<Record<string, unknown>>)[0];
    expect(fault?.limitKind).toBe('amount');
    expect(fault?.limit).toBe('10.0000');
  });

  it('accepts a discount inside both limits and leaves the invoice draft intact', async () => {
    const response = await draftInvoice('4', capped.token);
    expect(response.status).toBeLessThan(300);
    expect(body(response).invoiceDiscount).toBe('4.0000');
  });

  it('counts a line discount and a header discount together against the limit', async () => {
    const withFiveAndFive = await call('post', '/sales/invoices', {
      token: capped.token,
      body: {
        branchId,
        warehouseId,
        cashCustomerName: 'عميل نقدي',
        invoiceDiscount: '5',
        lines: [{ itemId, quantity: '1', unitPrice: '1000', taxRate: '15', discountAmount: '5' }],
      },
    });
    // 5 + 5 = 10 ⇒ على الحدّ تماماً: يمرّ. والعمود `invoice_discount` يحمل خصم الرأس وحده.
    expect(withFiveAndFive.status).toBeLessThan(300);
    expect(body(withFiveAndFive).invoiceDiscount).toBe('5.0000');

    const withFiveAndSix = await call('post', '/sales/invoices', {
      token: capped.token,
      body: {
        branchId,
        warehouseId,
        cashCustomerName: 'عميل نقدي',
        invoiceDiscount: '5',
        lines: [{ itemId, quantity: '1', unitPrice: '1000', taxRate: '15', discountAmount: '6' }],
      },
    });
    // 5 + 6 = 11 > 10 ⇒ يُرفض. ولو كان الفحص على خصم الرأس وحده (5) لمرّ الصفّان.
    expect(withFiveAndSix.status).toBe(422);
    expect(withFiveAndSix.body.code).toBe('DISCOUNT_LIMIT_EXCEEDED');
  });

  it('lets a holder of `sales.discount.override` exceed the cap on the same membership', async () => {
    // «تجاوز الخصم الافتراضي» (`frmUsersPermissions.xaml:262`) رمزٌ في الدور، والحدّ رقمٌ
    // على العضوية — فحامل الرمز يتجاوز رقمه، ومن لا يحمله يبقى داخله. نفس المقدار ونفس
    // العضوية: الفرق رمزٌ واحد.
    const override = await createActor(ctx, {
      tenantCode: 'rbac',
      tenantId: owner.tenantId,
      email: 'override@rbac.test',
      permissions: ['sales.view', 'sales.invoice.create', 'sales.discount.override'],
      isOwner: false,
      maxDiscountPct: '5.0000',
      maxDiscountAmount: '10.0000',
    });
    const allowed = await draftInvoice('60', override.token);
    expect(allowed.status).toBeLessThan(300);
    expect(body(allowed).invoiceDiscount).toBe('60.0000');
    // والعضوية نفسها بلا الرمز تُرفض (المقارنة عادلة: الحدّان واحد).
    const denied = await draftInvoice('60', capped.token);
    expect(denied.status).toBe(422);
  });

  it('lets an uncapped owner grant any discount (null means no limit)', async () => {
    const response = await draftInvoice('400', owner.token);
    expect(response.status).toBeLessThan(300);
    expect(body(response).invoiceDiscount).toBe('400.0000');
  });

  it('enforces the same limit at the till (pos.checkout → sales.createAndPost)', async () => {
    const response = await call('post', '/pos/checkout', {
      token: capped.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        invoiceDiscount: '80',
        lines: [{ itemId, quantity: '1', unitPrice: '1000', taxRate: '15' }],
        payment: { method: 'credit' },
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('DISCOUNT_LIMIT_EXCEEDED');
  });

  it('validates the limit fields themselves (percent ≤ 100, non-negative amount)', async () => {
    for (const patch of [
      { maxDiscountPct: '150' },
      { maxDiscountPct: '-1' },
      { maxDiscountPct: 'abc' },
      { maxDiscountAmount: '-5' },
      { maxDiscountAmount: '1e3' },
      { maxDiscountPct: 5 },
    ]) {
      const response = await call('patch', `/memberships/${capped.membershipId}`, {
        token: owner.token,
        body: patch,
      });
      expect(response.status, JSON.stringify(patch)).toBe(400);
    }
  });

  it('returns the discount limit on /me so the till screen can show it', async () => {
    const response = await call('get', '/me', { token: capped.token });
    expect(response.status).toBe(200);
    const membership = body(response).membership as Record<string, unknown>;
    expect(membership.maxDiscountPct).toBe('5.0000');
    expect(membership.maxDiscountAmount).toBe('10.0000');
  });

  // ── 3. مصفوفة الصلاحيات (frmUsersPermissions · frmOperPermission) ───────────────

  it('builds a role from registry codes and the actor sees exactly those codes', async () => {
    const roleId = await roleWithCodes(`Cashier-${Date.now()}`, ['sales.view', 'pos.operate']);
    const matrix = await call('get', `/roles/${roleId}`, { token: owner.token });
    expect(body(matrix).permissionCodes).toEqual(expect.arrayContaining(['sales.view', 'pos.operate']));

    const updated = await call('post', `/roles/${roleId}/permissions`, {
      token: owner.token,
      body: { permissionCodes: ['sales.view'] },
    });
    expect(updated.status).toBeLessThan(300);
    const after = await call('get', `/roles/${roleId}`, { token: owner.token });
    expect(body(after).permissionCodes).toEqual(['sales.view']);
  });

  it('rejects an unknown permission code (no silent no-op grant)', async () => {
    const response = await call(
      'post',
      `/roles/${await roleWithCodes(`Bad-${Date.now()}`, ['sales.view'])}/permissions`,
      {
        token: owner.token,
        body: { permissionCodes: ['not.a.real.code'] },
      },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('denies every membership write to an actor without tenant.membership.manage', async () => {
    const list = await call('get', '/memberships', { token: viewer.token });
    const create = await call('post', '/memberships', {
      token: viewer.token,
      body: { email: `nope-${Date.now()}@rbac.test`, roleIds: [capped.roleIds[0]] },
    });
    const patch = await call('patch', `/memberships/${capped.membershipId}`, {
      token: viewer.token,
      body: { displayName: 'اسم مسروق' },
    });
    const remove = await call('delete', `/memberships/${capped.membershipId}`, { token: viewer.token });
    const scopes = await call('post', `/memberships/${capped.membershipId}/scopes`, {
      token: viewer.token,
      body: { scopes: [] },
    });
    // كل كتابةٍ على العضويات محجوبة عن غير الحامل للرمز.
    for (const response of [create, patch, remove, scopes]) {
      expect(response.status).toBe(403);
    }
    // والقراءة كذلك هنا: `GET /memberships` محميّ بـ`tenant.membership.manage` نفسه.
    expect(list.status).toBe(403);
  });

  // ── 4. عزل المستأجر ────────────────────────────────────────────────────────────

  it('hides another tenant’s membership behind a 404, not a 403', async () => {
    const read = await call('get', `/memberships/${capped.membershipId}`, { token: outsider.token });
    const patch = await call('patch', `/memberships/${capped.membershipId}`, {
      token: outsider.token,
      body: { maxDiscountPct: '100' },
    });
    const remove = await call('delete', `/memberships/${capped.membershipId}`, { token: outsider.token });
    // 404 لا 403: وجود المعرّف نفسه معلومةٌ عن مستأجر آخر (MULTI_TENANCY §7.1).
    expect([read.status, patch.status, remove.status]).toEqual([404, 404, 404]);

    // ولم يتغيّر حدّ العضوية بعد محاولة الجار.
    const mine = await call('get', `/memberships/${capped.membershipId}`, { token: owner.token });
    expect(body(mine).maxDiscountPct).toBe('5.0000');
  });

  it('keeps the tenant’s own user list free of a neighbour’s memberships', async () => {
    const rows = (await call('get', '/memberships?limit=100', { token: outsider.token })).body.data as Array<
      Record<string, unknown>
    >;
    expect(rows.some((row) => row.id === capped.membershipId)).toBe(false);
    expect(rows.every((row) => row.tenantCode === 'rbac-other')).toBe(true);
  });
});
