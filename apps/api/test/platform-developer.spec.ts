import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  permissionRegistry,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOK_TEST_EVENT,
  apiKeyScopes,
  developerAuditActions,
  webhookEvents,
  type ApiKeyCreated,
  type ApiKeyIdentity,
  type ApiKeyInvoiceSample,
  type ApiKeyRow,
  type DeveloperCatalogue,
  type WebhookAttempt,
  type WebhookDeliveryRow,
  type WebhookEndpointCreated,
  type WebhookEndpointRow,
} from '@erp/contracts';

import { hashApiKey, verifyWebhookSignature } from '../src/modules/developer/api-key.js';
import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { createActor,
  type Actor,
  type ActorOptions,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-C11 — «بوابة المطوّر» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * أربع دعاوى تُقاس هنا، وكلّها تُقاس من البايتات لا من الحالة المعروضة:
 *
 * 1. **المفتاح يُصادق فعلاً.** يُنشأ من اللوحة، ثم يُستعمل على `/integration/v1/me` فيُقبل،
 *    ثم يُبطَل فيُرفض، ثم يُدوَّر فيعمل الجديد ويسقط القديم. ولا يُخزَّن نصّاً: الصفّ في
 *    القاعدة يحمل البادئة والبصمة، والبصمة تُقارن بـ`sha256` للنصّ الذي أُعيد مرّةً واحدة.
 * 2. **النطاق سقفٌ لا زينة.** مفتاحٌ بنطاق `reporting:read` يُرفض على مسار الفواتير 403،
 *    ولا يفتح إلا ما اشتراه.
 * 3. **العزل يُقاس بالمعرّفات.** مفتاح منشأةٍ يقرأ فواتير منشأته وحدها — تُنشأ فاتورة في كل
 *    منشأة، ثم يُقاس أن عيّنة مفتاح الأولى لا تحمل معرّفات الثانية.
 * 4. **التوقيع يُتحقَّق به الخادمُ الحقيقي.** خادم HTTP محلّي يستقبل التسليم، والاختبار يتحقّق
 *    من الترويسة بـ`verifyWebhookSignature` (نفس دالة المستلم)، ثم يُقاس الفشل وإعادة
 *    الإرسال، ثم **مُنتِجٌ حقيقي**: فاتورة تُصدَّر في المبيعات فيصل حدثها `invoice.posted`.
 */
type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('developer platform (P-C11)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let operations: Actor;
  let auditor: Actor;
  let customer: Actor;
  let other: Actor;
  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let partyId = '';
  let otherBranchId = '';
  let otherWarehouseId = '';
  let otherItemId = '';
  let otherPartyId = '';

  /** خادمٌ محلّي يستقبل التسليم — هو «عنوان العميل» في هذه السويت. */
  let receiver: Server;
  let receiverPort = 0;
  const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  /** سلوك العنوان: يُبدَّل في اختبار الفشل ثم إعادة الإرسال. */
  let receiverStatus = 200;

  const base = '/api/v1';
  const body = <T>(response: { body: Record<string, unknown> }): T => (response.body.data ?? response.body) as T;
  const hookUrl = () => `http://localhost:${receiverPort}/hook`;

  /** كل خطأ تهيئة يُطبع بجسمه: فشلٌ صامت في التهيئة يظهر لاحقاً كخطأٍ مضلِّل في الاختبار. */
  async function checked(call: Promise<{ status: number; body: Record<string, unknown> }>, label: string) {
    const response = await call;
    expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBeLessThan(300);
    return body<{ id: string }>(response);
  }

  const platform = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    options: { body?: unknown; actor?: Actor } = {},
  ) => api(ctx.server, method, `${base}${path}`, { token: (options.actor ?? owner).token, body: options.body });

  const createKey = async (
    tenantId: string,
    input: { name: string; scopes: string[]; expiresInDays?: number | null } = {
      name: 'تكامل المستودع',
      scopes: ['invoices:read'],
    },
    actor: Actor = owner,
  ): Promise<{ status: number; key: ApiKeyCreated }> => {
    const response = await platform('post', `/platform/tenants/${tenantId}/api-keys`, { body: input, actor });
    return { status: response.status, key: body<ApiKeyCreated>(response) };
  };

  const integration = (path: string, key?: string, method: 'get' | 'post' = 'get') =>
    api(ctx.server, method, `${base}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });

  async function provisionTenant(
    actor: Actor,
    codes: { branch: string; warehouse: string; item: string; party: string; docId: string },
  ) {
    const branch = (
      await checked(
        api(ctx.server, 'post', `${base}/branches`, {
          token: actor.token,
          body: { code: `BR-${codes.branch}`, nameAr: `فرع ${codes.branch}` },
        }),
        'branch',
      )
    ).id;
    await checked(
      api(ctx.server, 'post', `${base}/fiscal-years`, {
        token: actor.token,
        body: { name: `FY-${codes.branch}`, startDate: '2026-01-01', endDate: '2026-12-31' },
      }),
      'fiscal year',
    );
    const warehouse = (
      await checked(
        api(ctx.server, 'post', `${base}/warehouses`, {
          token: actor.token,
          body: { branchId: branch, code: `WH-${codes.warehouse}`, name: `مستودع ${codes.warehouse}` },
        }),
        'warehouse',
      )
    ).id;
    const unitId = (
      await checked(
        api(ctx.server, 'post', `${base}/organization/catalog/units`, {
          token: actor.token,
          body: { code: `PCE-${codes.item}`, nameAr: 'حبة' },
        }),
        'unit',
      )
    ).id;
    const categoryId = (
      await checked(
        api(ctx.server, 'post', `${base}/organization/catalog/categories`, {
          token: actor.token,
          body: { code: `GEN-${codes.item}`, nameAr: 'عام' },
        }),
        'category',
      )
    ).id;
    const item = (
      await checked(
        api(ctx.server, 'post', `${base}/organization/catalog/items`, {
          token: actor.token,
          body: { sku: `SKU-${codes.item}`, nameAr: `صنف ${codes.item}`, categoryId, baseUnitId: unitId, kind: 'stock', salePrice: '10' },
        }),
        'item',
      )
    ).id;
    const party = (
      await checked(
        api(ctx.server, 'post', `${base}/parties`, {
          token: actor.token,
          body: { kind: 'customer', name: `عميل ${codes.party}` },
        }),
        'party',
      )
    ).id;
    await api(ctx.server, 'post', `${base}/inventory/ledger/record`, {
      token: actor.token,
      body: {
        lines: [
          { itemId: item, warehouseId: warehouse, qty: '500', unitCost: '5', direction: 'in', docType: 'opening', docId: codes.docId },
        ],
      },
    });
    return { branch, warehouse, item, party };
  }

  async function postInvoice(actor: Actor, refs: { branch: string; warehouse: string; item: string; party: string }) {
    const draft = await api(ctx.server, 'post', `${base}/sales/invoices`, {
      token: actor.token,
      body: {
        branchId: refs.branch,
        warehouseId: refs.warehouse,
        partyId: refs.party,
        lines: [{ itemId: refs.item, quantity: '1', unitPrice: '10', taxRate: '15' }],
      },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBeLessThan(300);
    const created = body<{ id: string }>(draft);
    const posted = await api(ctx.server, 'post', `${base}/sales/invoices/${created.id}/post`, { token: actor.token, body: {} });
    // التشخيص جزءٌ من الاختبار: إن سقط الترحيل، يُطبع رمز الخطأ لا رقم الحالة وحده.
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    return created.id;
  }

  /** ينتظر ظهور تسليمٍ لحدثٍ ما — الإعلان `void` بقصد (لا يوقف مسار العميل). */
  async function waitForDelivery(endpointId: string, event: string, timeoutMs = 8_000): Promise<WebhookDeliveryRow> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await platform('get', `/platform/webhooks/${endpointId}/deliveries?filter[event]=${event}`);
      const rows = body<WebhookDeliveryRow[]>(response);
      const found = rows.find((row) => row.event === event);
      if (found && found.status !== 'pending') return found;
      if (Date.now() > deadline) throw new Error(`no ${event} delivery within ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  beforeAll(async () => {
    ctx = await createTestApp('platform-developer');

    // خادم الاستقبال: يسجّل كل طلب ثم يردّ بالحالة المطلوبة في اللحظة.
    receiver = createServer((request: IncomingMessage, response: ServerResponse) => {
      let raw = '';
      request.on('data', (chunk) => (raw += String(chunk)));
      request.on('end', () => {
        received.push({ headers: request.headers, body: raw });
        response.writeHead(receiverStatus, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: receiverStatus < 300 }));
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverPort = (receiver.address() as AddressInfo).port;

    // المستأجر يأخذ **كل** رموز السجلّ: تهيئةٌ ناقصة تظهر لاحقاً كخطأٍ مضلِّل في موضعٍ
    // لا علاقة له بالسبب (جرّبناها: `catalog.unit.manage` أوقف فاتورةً لا علاقة لها بالفئات).
    const everyTenantPermission = permissionRegistry.map((entry) => entry.code);

    owner = await createOperator(ctx, {
      tenantCode: 'p-c11-console',
      email: 'owner@p-c11-console.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    operations = await createOperator(ctx, {
      tenantCode: 'p-c11-console',
      email: 'ops@p-c11-console.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_operations'],
    });
    auditor = await createOperator(ctx, {
      tenantCode: 'p-c11-console',
      email: 'auditor@p-c11-console.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_auditor'],
    });

    customer = await createActor(ctx, {
      tenantCode: 'p-c11-customer-a',
      tenantName: 'منشأة التكامل',
      email: 'owner@p-c11-customer-a.test',
      permissions: everyTenantPermission,
      roleNames: ['Admin'],
      isOwner: true,
    });
    other = await createActor(ctx, {
      tenantCode: 'p-c11-customer-b',
      tenantName: 'منشأة الجار',
      email: 'owner@p-c11-customer-b.test',
      permissions: everyTenantPermission,
      roleNames: ['Admin'],
      isOwner: true,
    });

    // دليل الحسابات وملامح الترحيل: بلاها يُرفض ترحيل الفاتورة (`ACCOUNT_PROFILE_MISSING`)
    // — وهذا شرطٌ حقيقي في المنتج لا في التهيئة، فيُبنى هنا كما يبنيه العميل أول مرة.
    const provisioning = ctx.app.get(OrgProvisioningService);
    await provisioning.provisionOrgDefaults(customer.tenantId);
    await provisioning.provisionOrgDefaults(other.tenantId);

    const a = await provisionTenant(customer, {
      branch: 'A',
      warehouse: 'A',
      item: 'A',
      party: 'A',
      docId: '00000000-0000-4000-8000-0000000000a1',
    });
    branchId = a.branch;
    warehouseId = a.warehouse;
    itemId = a.item;
    partyId = a.party;
    const b = await provisionTenant(other, {
      branch: 'B',
      warehouse: 'B',
      item: 'B',
      party: 'B',
      docId: '00000000-0000-4000-8000-0000000000b1',
    });
    otherBranchId = b.branch;
    otherWarehouseId = b.warehouse;
    otherItemId = b.item;
    otherPartyId = b.party;
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await ctx?.close();
  });

  // ─────────────────────────────────────────────────────── الصلاحيات والكتالوج

  it('leaves the console codes to the operator ranks and denies everyone else', async () => {
    const asOwner = await platform('get', `/platform/tenants/${customer.tenantId}/api-keys`);
    expect(asOwner.status).toBe(200);

    const asAuditor = await platform('get', `/platform/tenants/${customer.tenantId}/api-keys`, { actor: auditor });
    expect(asAuditor.status).toBe(403);

    const asTenantStaff = await api(ctx.server, 'get', `${base}/platform/tenants/${customer.tenantId}/api-keys`, {
      token: customer.token,
    });
    expect(asTenantStaff.status).toBe(403);

    const noKey = await platform('post', `/platform/tenants/${customer.tenantId}/webhooks`, {
      body: { url: hookUrl(), events: ['invoice.posted'] },
      actor: auditor,
    });
    expect(noKey.status).toBe(403);

    // وتشغيل المنصة يحمل رمزي P-C11: مفتاحُ عميلٍ وأحداثُه عملٌ تشغيليّ يوميّ — فلا يُترك
    // للدعم ولا للمدقّق، ولا يُغلق على المالك وحده حتى لا يتوقّف تكاملُ عميلٍ يوم إجازته.
    const asOperations = await platform('get', `/platform/tenants/${customer.tenantId}/api-keys`, {
      actor: operations,
    });
    expect(asOperations.status).toBe(200);
    expect(
      (await platform('get', '/platform/developer/catalogue', { actor: operations })).status,
    ).toBe(200);
  });

  it('declares the catalogue the console and the docs both read', async () => {
    const response = await platform('get', '/platform/developer/catalogue');
    expect(response.status).toBe(200);
    const catalogue = body<DeveloperCatalogue>(response);
    expect(catalogue.scopes).toEqual([...apiKeyScopes]);
    expect(catalogue.events).toEqual([...webhookEvents]);
    expect(catalogue.events).toContain('invoice.posted');
    expect(catalogue.testEvent).toBe(WEBHOOK_TEST_EVENT);
    expect(catalogue.signature.header).toBe(WEBHOOK_SIGNATURE_HEADER);
    expect(catalogue.signature.toleranceSeconds).toBe(WEBHOOK_SIGNATURE_TOLERANCE_SECONDS);
    expect(catalogue.retryBackoffSeconds).toEqual([60, 300, 1800]);
  });

  it('rejects an unknown tenant instead of writing a key nobody owns', async () => {
    const missing = await platform('post', '/platform/tenants/00000000-0000-4000-8000-0000000009ff/api-keys', {
      body: { name: 'تكامل', scopes: ['invoices:read'] },
    });
    expect(missing.status).toBe(404);
    const bogusScope = await createKey(customer.tenantId, { name: 'تكامل', scopes: ['invoices:destroy'] });
    expect(bogusScope.status).toBe(400);
  });

  // ─────────────────────────────────────────────────────── المفتاح: إنشاء وتخزين

  it('returns the secret once and stores only a prefix and a hash', async () => {
    const created = await createKey(customer.tenantId, { name: 'تكامل المتجر', scopes: ['invoices:read', 'parties:read'] });
    expect(created.status).toBe(201);
    const key = created.key;
    expect(key.secret.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key.prefix).toBe(key.secret.slice(0, API_KEY_PREFIX.length + 8));
    expect(key.status).toBe('active');
    expect(key.scopes).toEqual(['invoices:read', 'parties:read']);

    // الصفّ كما هو في القاعدة: بادئة وبصمة، ولا عمود يحمل النصّ الصريح.
    const rows = await platform('get', `/platform/tenants/${customer.tenantId}/api-keys`);
    const listed = body<ApiKeyRow[]>(rows).find((row) => row.id === key.id)!;
    expect(listed.prefix).toBe(key.prefix);
    expect(JSON.stringify(listed)).not.toContain(key.secret);
    expect(JSON.stringify(listed)).not.toContain(hashApiKey(key.secret));
    expect(listed.uses).toBe(0);
    expect(listed.lastUsedAt).toBeNull();
  });

  it('authenticates the integration surface and records the use', async () => {
    const created = await createKey(customer.tenantId, {
      name: 'تكامل القراءة',
      scopes: ['invoices:read'],
    });
    const secret = created.key.secret;

    const me = await integration('/integration/v1/me', secret);
    expect(me.status).toBe(200);
    const identity = body<ApiKeyIdentity>(me);
    expect(identity.keyId).toBe(created.key.id);
    expect(identity.tenantId).toBe(customer.tenantId);
    expect(identity.tenantCode).toBe('p-c11-customer-a');
    expect(identity.scopes).toEqual(['invoices:read']);
    expect(identity.permissions).toContain('sales.view');

    const anonymous = await integration('/integration/v1/me');
    expect(anonymous.status).toBe(401);
    const wrong = await integration('/integration/v1/me', `${API_KEY_PREFIX}not-a-real-key`);
    expect(wrong.status).toBe(401);

    const rows = await platform('get', `/platform/tenants/${customer.tenantId}/api-keys`);
    const used = body<ApiKeyRow[]>(rows).find((row) => row.id === created.key.id)!;
    expect(used.uses).toBeGreaterThanOrEqual(1);
    expect(used.lastUsedAt).not.toBeNull();
  });

  it('limits the key to the scopes it was issued with', async () => {
    const reporting = await createKey(customer.tenantId, { name: 'تكامل التقارير', scopes: ['reporting:read'] });
    const denied = await integration('/integration/v1/invoices', reporting.key.secret);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');

    const reading = await createKey(customer.tenantId, { name: 'تكامل الفواتير', scopes: ['invoices:read'] });
    const allowed = await integration('/integration/v1/invoices', reading.key.secret);
    expect(allowed.status).toBe(200);
    expect(Array.isArray(body<ApiKeyInvoiceSample[]>(allowed))).toBe(true);
  });

  it('keeps one tenant’s key out of another tenant’s invoices (isolation)', async () => {
    const mine = await postInvoice(customer, { branch: branchId, warehouse: warehouseId, item: itemId, party: partyId });
    const theirs = await postInvoice(other, {
      branch: otherBranchId,
      warehouse: otherWarehouseId,
      item: otherItemId,
      party: otherPartyId,
    });

    const key = await createKey(customer.tenantId, { name: 'تكامل العزل', scopes: ['invoices:read'] });
    const sample = body<ApiKeyInvoiceSample[]>(await integration('/integration/v1/invoices', key.key.secret));
    const ids = sample.map((row) => row.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('revokes a key with a reason, refuses it afterwards and keeps the row', async () => {
    const created = await createKey(customer.tenantId, { name: 'تكامل مؤقّت', scopes: ['invoices:read'] });
    expect((await integration('/integration/v1/me', created.key.secret)).status).toBe(200);

    const revoked = await platform('delete', `/platform/tenants/${customer.tenantId}/api-keys/${created.key.id}`, {
      body: { reason: 'تسرّب المفتاح في سجلّ المحادثة' },
    });
    expect(revoked.status).toBe(200);
    const row = body<ApiKeyRow>(revoked);
    expect(row.status).toBe('revoked');
    expect(row.revokedReason).toContain('تسرّب');
    expect(row.revokedAt).not.toBeNull();

    expect((await integration('/integration/v1/me', created.key.secret)).status).toBe(401);
    const again = await platform('delete', `/platform/tenants/${customer.tenantId}/api-keys/${created.key.id}`, {
      body: { reason: 'محاولة إبطال ثانية' },
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATE');

    const rows = await platform('get', `/platform/tenants/${customer.tenantId}/api-keys`);
    expect(body<ApiKeyRow[]>(rows).some((entry) => entry.id === created.key.id && entry.status === 'revoked')).toBe(true);
  });

  it('rotates a key: the new one works, the old one is revoked and points at its origin', async () => {
    const created = await createKey(customer.tenantId, { name: 'تكامل يُدوَّر', scopes: ['invoices:read'] });
    const rotated = await platform('post', `/platform/tenants/${customer.tenantId}/api-keys/${created.key.id}/rotate`, {
      body: { reason: 'تدوير دوري كل ٩٠ يوماً' },
    });
    expect(rotated.status).toBe(201);
    const replacement = body<ApiKeyCreated>(rotated);
    expect(replacement.secret).not.toBe(created.key.secret);
    expect(replacement.scopes).toEqual(created.key.scopes);
    expect(replacement.name).toBe(created.key.name);

    expect((await integration('/integration/v1/me', created.key.secret)).status).toBe(401);
    expect((await integration('/integration/v1/me', replacement.secret)).status).toBe(200);

    const rows = await platform('get', `/platform/tenants/${customer.tenantId}/api-keys`);
    const old = body<ApiKeyRow[]>(rows).find((row) => row.id === created.key.id)!;
    expect(old.status).toBe('revoked');
    expect(old.revokedReason).toContain('تدوير');

    const rotateRevoked = await platform('post', `/platform/tenants/${customer.tenantId}/api-keys/${created.key.id}/rotate`, {
      body: {},
    });
    expect(rotateRevoked.status).toBe(409);
  });

  // ─────────────────────────────────────────────────────── الويب هوك: عنوان وسرّ

  it('accepts https (or localhost) only, and hands the signing secret over once', async () => {
    const insecure = await platform('post', `/platform/tenants/${customer.tenantId}/webhooks`, {
      body: { url: 'http://hooks.example.com/erp', events: ['invoice.posted'] },
    });
    expect(insecure.status).toBe(400);

    const created = await platform('post', `/platform/tenants/${customer.tenantId}/webhooks`, {
      body: { url: hookUrl(), events: ['invoice.posted', 'invoice.paid'], description: 'بوت المحاسبة' },
    });
    expect(created.status).toBe(201);
    const endpoint = body<WebhookEndpointCreated>(created);
    expect(endpoint.secret.startsWith('whsec_')).toBe(true);
    expect(endpoint.secretPrefix).toBe(endpoint.secret.slice(0, 14));
    expect(endpoint.events).toEqual(['invoice.posted', 'invoice.paid']);

    const rows = await platform('get', `/platform/tenants/${customer.tenantId}/webhooks`);
    const listed = body<WebhookEndpointRow[]>(rows).find((row) => row.id === endpoint.id)!;
    expect(JSON.stringify(listed)).not.toContain(endpoint.secret);
    expect(listed.secretPrefix).toBe(endpoint.secretPrefix);
    expect(listed.stats).toEqual({
      delivered: 0,
      failed: 0,
      pending: 0,
      lastDeliveryAt: null,
      lastResponseCode: null,
      lastError: null,
    });

    const unknown = await platform('patch', `/platform/tenants/${customer.tenantId}/webhooks/00000000-0000-4000-8000-0000000009ff`, {
      body: { status: 'paused' },
    });
    expect(unknown.status).toBe(404);
  });

  it('sends a real test event, signed the way the receiver verifies it', async () => {
    const created = await platform('post', `/platform/tenants/${customer.tenantId}/webhooks`, {
      body: { url: hookUrl(), events: ['invoice.posted'] },
    });
    const endpoint = body<WebhookEndpointCreated>(created);
    const before = received.length;

    const test = await platform('post', `/platform/webhooks/${endpoint.id}/test`);
    expect(test.status).toBe(201);
    const attempt = body<WebhookAttempt>(test);
    expect(attempt.status).toBe('delivered');
    expect(attempt.responseCode).toBe(200);
    expect(attempt.durationMs).toBeGreaterThanOrEqual(0);

    // الخادم استقبل الطلب فعلاً، والترويسة تُحقَّق بالسرّ الذي أُعيد مرّةً واحدة.
    expect(received.length).toBe(before + 1);
    const captured = received[received.length - 1]!;
    const header = String(captured.headers[WEBHOOK_SIGNATURE_HEADER]);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        header,
        body: captured.body,
        toleranceSeconds: WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      }),
    ).toBe(true);
    // ونافذةٌ ضيّقة تكشف إعادة الإرسال: نفس الحمولة بعد 6 دقائق تُرفض.
    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        header,
        body: captured.body,
        now: Math.floor(Date.now() / 1000) + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 60,
        toleranceSeconds: WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      }),
    ).toBe(false);
    // والسرّ الخطأ لا يوقّع: تعديل بايت في الجسم يُفشل التحقّق.
    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        header,
        body: `${captured.body} `,
        toleranceSeconds: WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      }),
    ).toBe(false);

    const payload = JSON.parse(captured.body) as { event: string; via: string };
    expect(payload.event).toBe(WEBHOOK_TEST_EVENT);
    expect(payload.via).toBe('console');

    const deliveries = await platform('get', `/platform/webhooks/${endpoint.id}/deliveries`);
    const rows = body<WebhookDeliveryRow[]>(deliveries);
    expect(rows[0]!.payloadKeys).toContain('event');
    expect(JSON.stringify(rows[0])).not.toContain('console');
  });

  it('records a failed delivery with its status code, then retries it successfully', async () => {
    const created = await platform('post', `/platform/tenants/${customer.tenantId}/webhooks`, {
      body: { url: hookUrl(), events: ['invoice.paid'] },
    });
    const endpoint = body<WebhookEndpointCreated>(created);

    receiverStatus = 500;
    const failed = body<WebhookAttempt>(await platform('post', `/platform/webhooks/${endpoint.id}/test`));
    expect(failed.status).toBe('failed');
    expect(failed.responseCode).toBe(500);
    expect(failed.error).toContain('500');

    const rows = body<WebhookDeliveryRow[]>(
      await platform('get', `/platform/webhooks/${endpoint.id}/deliveries?filter[status]=failed`),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(1);

    receiverStatus = 200;
    const retried = await platform('post', `/platform/webhooks/${endpoint.id}/deliveries/${rows[0]!.id}/retry`);
    expect(retried.status).toBe(201);
    const attempt = body<WebhookAttempt>(retried);
    expect(attempt.status).toBe('delivered');
    expect(attempt.responseCode).toBe(200);

    // وإعادة إرسال تسليمٍ ناجح تُرفض: لم يبق ما يُعاد.
    const again = await platform('post', `/platform/webhooks/${endpoint.id}/deliveries/${rows[0]!.id}/retry`);
    expect(again.status).toBe(409);

    const stats = body<WebhookEndpointRow[]>(await platform('get', `/platform/tenants/${customer.tenantId}/webhooks`)).find(
      (row) => row.id === endpoint.id,
    )!;
    expect(stats.stats.delivered).toBe(1);
    expect(stats.stats.failed).toBe(0);
    expect(stats.stats.lastResponseCode).toBe(200);
  });

  it('does not send to a paused endpoint, and resumes when it is switched back on', async () => {
    const created = await platform('post', `/platform/tenants/${customer.tenantId}/webhooks`, {
      body: { url: hookUrl(), events: ['invoice.voided'] },
    });
    const endpoint = body<WebhookEndpointCreated>(created);

    const paused = await platform('patch', `/platform/tenants/${customer.tenantId}/webhooks/${endpoint.id}`, {
      body: { status: 'paused' },
    });
    expect(paused.status).toBe(200);
    expect(body<WebhookEndpointRow>(paused).status).toBe('paused');

    const voided = await postInvoice(customer, { branch: branchId, warehouse: warehouseId, item: itemId, party: partyId });
    const voidResponse = await api(ctx.server, 'post', `${base}/sales/invoices/${voided}/void`, {
      token: customer.token,
      body: { reason: 'فاتورة تجريبية أُلغيت' },
    });
    expect(voidResponse.status).toBeLessThan(300);
    await new Promise((resolve) => setTimeout(resolve, 500));
    // العنوان الموقوف لا يُنشأ له تسليم أصلاً — لا أنه فشل: لا صفّ في السجلّ.
    const whilePaused = body<WebhookDeliveryRow[]>(
      await platform('get', `/platform/webhooks/${endpoint.id}/deliveries`),
    );
    expect(whilePaused).toHaveLength(0);

    const resumed = await platform('patch', `/platform/tenants/${customer.tenantId}/webhooks/${endpoint.id}`, {
      body: { status: 'active' },
    });
    expect(body<WebhookEndpointRow>(resumed).status).toBe('active');
  });

  // ─────────────────────────────────────────────────────── المُنتِجون الحقيقيون

  it('announces invoice.posted from the sales engine, payload keys only', async () => {
    const created = await platform('post', `/platform/tenants/${customer.tenantId}/webhooks`, {
      body: { url: hookUrl(), events: ['invoice.posted'] },
    });
    const endpoint = body<WebhookEndpointCreated>(created);
    const invoiceId = await postInvoice(customer, { branch: branchId, warehouse: warehouseId, item: itemId, party: partyId });

    const delivery = await waitForDelivery(endpoint.id, 'invoice.posted');
    expect(delivery.status).toBe('delivered');
    expect(delivery.responseCode).toBe(200);
    expect(delivery.payloadKeys).toContain('invoiceId');
    expect(delivery.payloadKeys).toContain('total');
    // القيمة نفسها تُقرأ من الطلب المُستقبَل — الإعلان يحمل فاتورةً حقيقية لا هيكلاً فارغاً.
    const captured = received.filter((entry) => entry.body.includes(invoiceId));
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(captured[captured.length - 1]!.body) as { event: string; invoiceId: string };
    expect(payload.event).toBe('invoice.posted');
    expect(payload.invoiceId).toBe(invoiceId);
  });

  it('announces invoice.voided when the same invoice is voided', async () => {
    const created = await platform('post', `/platform/tenants/${customer.tenantId}/webhooks`, {
      body: { url: hookUrl(), events: ['invoice.voided'] },
    });
    const endpoint = body<WebhookEndpointCreated>(created);
    const invoiceId = await postInvoice(customer, { branch: branchId, warehouse: warehouseId, item: itemId, party: partyId });

    const voided = await api(ctx.server, 'post', `${base}/sales/invoices/${invoiceId}/void`, {
      token: customer.token,
      body: { reason: 'إلغاء بعد إصدار بالخطأ' },
    });
    expect(voided.status).toBeLessThan(300);

    const delivery = await waitForDelivery(endpoint.id, 'invoice.voided');
    expect(delivery.status).toBe('delivered');
    expect(delivery.payloadKeys).toContain('reason');

    const hits = received.filter((entry) => entry.body.includes(invoiceId) && entry.body.includes('invoice.voided'));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(hits[hits.length - 1]!.body) as { invoiceId: string; reason: string };
    expect(payload.invoiceId).toBe(invoiceId);
    expect(payload.reason).toBe('إلغاء بعد إصدار بالخطأ');
  });

  it('writes every key and endpoint action to the audit trail', async () => {
    const audit = await platform('get', '/platform/audit?filter[entity]=api_keys&limit=50');
    expect(audit.status).toBe(200);
    const rows = body<{ items: Array<{ action: string; entity: string }> }>(audit).items;
    const actions = new Set(rows.map((row) => row.action));
    expect(actions.has(developerAuditActions.apiKeyCreate)).toBe(true);
    expect(actions.has(developerAuditActions.apiKeyRevoke)).toBe(true);
    expect(actions.has(developerAuditActions.apiKeyRotate)).toBe(true);

    const endpoints = body<{ items: Array<{ action: string }> }>(
      await platform('get', '/platform/audit?filter[entity]=webhook_endpoints&limit=50'),
    ).items;
    expect(endpoints.some((row) => row.action === developerAuditActions.webhookCreate)).toBe(true);
    expect(endpoints.some((row) => row.action === developerAuditActions.webhookUpdate)).toBe(true);
  });
});
