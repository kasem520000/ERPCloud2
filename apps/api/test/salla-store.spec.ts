import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetMockStores } from '../src/modules/integrations/salla/salla-client.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 09 part eight — 🛒 متجر سلة.
 *
 * `Form_WPF/FrmSallah.xaml` («تكامل Salla API») is four buttons:
 *
 *   «📦 جلب المنتجات»    → `ProductsManager.GetProducts()`  → «تم جلب {n} منتج.»
 *   «📋 جلب الطلبات»     → `OrdersManager.GetOrders()`      → «تم جلب {n} طلب.»
 *   «➕ إضافة منتج»      → `ProductsManager.CreateProduct()` → «تم إضافة المنتج بنجاح.»
 *   «📥 جلب الطلبات (2)» → `await Task.Run(() => { })` + a message box — not migrated
 *
 * and the three items of «متجر سلة» in `Home.xaml` L394 (المنتجات · إدارة الطلبات · ربط
 * المستودعات) have empty handlers: the desktop counts what it pulls and keeps nothing.
 *
 * The store behind these tests is the in-memory Salla (`SALLA_TRANSPORT` / a `MOCK-` store
 * id), because the desktop builds its client from a token written into the XAML's
 * code-behind and cannot be exercised any other way.
 */
describe('متجر سلة — FrmSallah · ProductsManager · OrdersManager · CustomersManager', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let stranger: Actor;

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const put = (path: string, body: Record<string, unknown>) => api(ctx.server, 'put', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });
  const del = (path: string) => api(ctx.server, 'delete', `/api/v1${path}`, { token: actor.token });
  const asViewer = (method: 'get' | 'post' | 'put' | 'delete', path: string, body?: Record<string, unknown>) =>
    api(ctx.server, method, `/api/v1${path}`, { token: viewer.token, body });
  const asStranger = (method: 'get' | 'post' | 'put' | 'delete', path: string, body?: Record<string, unknown>) =>
    api(ctx.server, method, `/api/v1${path}`, { token: stranger.token, body });

  let connectionId = '';
  let itemId = '';
  let branchId = '';

  beforeAll(async () => {
    resetMockStores();
    ctx = await createTestApp('salla-store');
    actor = await createActor(ctx, {
      tenantCode: 'salla-store',
      email: 'owner@salla-store.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'salla.integration.view',
        'salla.integration.manage',
        'sales.invoice.create',
        'catalog.category.manage',
        'catalog.unit.manage',
        'catalog.item.manage',
        'sales.view',
      ],
    });
    viewer = await createActor(ctx, {
      tenantCode: 'salla-store',
      email: 'viewer@salla-store.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'salla.integration.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'salla-store-2',
      email: 'owner@salla-store-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'salla.integration.view', 'salla.integration.manage'],
    });

    const branch = await post('/branches', { code: 'MAIN', nameAr: 'الفرع الرئيسي' });
    branchId = data(branch.body).id as string;

    const category = await post('/organization/catalog/categories', { code: 'GEN', nameAr: 'عام' });
    const unit = await post('/organization/catalog/units', { code: 'PCS', nameAr: 'حبة' });
    const item = await post('/organization/catalog/items', {
      sku: 'SKU-SALLA',
      nameAr: 'قميص قطني',
      categoryId: data(category.body).id as string,
      baseUnitId: data(unit.body).id as string,
      salePrice: '120.0000',
    });
    itemId = data(item.body).id as string;

    // A `MOCK-` store is served by the in-memory Salla — no credential, no network.
    const connection = await post('/integrations/salla/connections', {
      storeId: `MOCK-STORE-${Date.now()}`,
      accessToken: 'mock-token',
      webhookSecret: 'mock-secret',
    });
    expect(connection.status).toBe(201);
    connectionId = data(connection.body).id as string;

    await post('/integrations/salla/branch-mappings', { connectionId, branchId, remoteBranchId: 'MAIN' });
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('«📦 جلب المنتجات» — ما في المتجر يُجلب ويُحفظ، ويُقال بعدده', async () => {
    const pulled = await post('/integrations/salla/products/pull', { connectionId });
    expect(pulled.status).toBe(201);
    expect(pulled.body).toMatchObject({ count: 2, message: 'تم جلب 2 منتج.' });

    const catalog = await get(`/integrations/salla/catalog?connectionId=${connectionId}`);
    expect(catalog.status).toBe(200);
    const rows = rowsOf(catalog.body);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ remoteId: 'MOCK-P-1', name: 'قميص قطني', price: '120.0000' });
  });

  it('«➕ إضافة منتج» — صنفٌ حقيقي يُرسل بأربعة مفاتيح، ثم يظهر في الجلب', async () => {
    const pushed = await post('/integrations/salla/products/push', { connectionId, itemId });
    expect(pushed.status).toBe(201);
    expect(pushed.body).toMatchObject({ message: 'تم إضافة المنتج بنجاح.' });
    const remoteId = ((pushed.body.data as Record<string, unknown>)?.remoteId ?? '') as string;
    expect(remoteId).toBeTruthy();

    // «📦 جلب المنتجات» again: the product this run pushed is now in the store.
    const pulled = await post('/integrations/salla/products/pull', { connectionId });
    expect(pulled.body.count).toBe(3);
    const catalog = rowsOf((await get(`/integrations/salla/catalog?connectionId=${connectionId}`)).body);
    expect(catalog.map((row) => row.remoteId)).toContain(remoteId);

    // ✏️ تحديث — `PUT products/{id}` من حالة الصنف نفسها.
    const updated = await put(`/integrations/salla/products/${remoteId}`, { connectionId, itemId });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ message: 'تم تحديث المنتج بنجاح.' });

    // 🗑️ حذف — `DELETE products/{id}`.
    const removed = await del(`/integrations/salla/products/${remoteId}?connectionId=${connectionId}&itemId=${itemId}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ message: 'تم حذف المنتج من المتجر.' });
  });

  it('«👥 العملاء» — `CustomersManager` يُقرأ ولا يُخزَّن', async () => {
    const customers = await get(`/integrations/salla/customers?connectionId=${connectionId}`);
    expect(customers.status).toBe(200);
    expect(customers.body).toMatchObject({ count: 2 });
    expect(rowsOf(customers.body.data as unknown)[0]).toMatchObject({ remoteId: 'MOCK-C-1', mobile: '0551000001' });
  });

  it('«📋 جلب الطلبات» — كل طلبٍ فاتورة، والجلب الثاني لا يكرّرها', async () => {
    const first = await post('/integrations/salla/orders/pull', { connectionId });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ count: 2, created: 2, message: 'تم جلب 2 طلب.' });

    const created = rowsOf(first.body.data as unknown) as Array<Record<string, unknown>>;
    expect(created.map((row) => row.remoteId)).toEqual(['MOCK-O-1', 'MOCK-O-2']);
    expect(created[0]).toMatchObject({ remoteStatus: 'pending', customerName: 'محمد الأحمد', total: '240.0000', branchId });
    expect(created[0]?.salesInvoiceId).toBeTruthy();

    // الطلب رقمه البعيد: الجلب الثاني لا ينشئ شيئاً.
    const second = await post('/integrations/salla/orders/pull', { connectionId });
    expect(second.body).toMatchObject({ count: 2, created: 0 });
    expect(second.body.skipped).toEqual(['MOCK-O-1', 'MOCK-O-2']);

    const orders = rowsOf((await get('/integrations/salla/orders')).body);
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({ remoteStatus: 'pending', status: 'draft', paymentStatus: 'unpaid' });
  });

  it('تحديث حالة الطلب — `PUT orders/{id}/status` بـ`{ status }`', async () => {
    const orders = rowsOf((await get('/integrations/salla/orders')).body);
    const orderId = orders[0]?.orderId as string;

    const missingStatus = await put(`/integrations/salla/orders/${orderId}/status`, { status: '  ' });
    expect(missingStatus.status).toBe(422);
    expect(missingStatus.body).toMatchObject({ code: 'SALLA_ORDER_STATUS_REQUIRED', detail: 'يجب تحديد حالة الطلب' });

    const updated = await put(`/integrations/salla/orders/${orderId}/status`, { status: 'delivered' });
    expect(updated.status).toBe(200);
    expect(((updated.body.data as Record<string, unknown>)?.remoteStatus ?? '') as string).toBe('delivered');
  });

  it('🗑️ حذف الطلب — المسوّدة تُمحى مع فاتورتها', async () => {
    const orders = rowsOf((await get('/integrations/salla/orders')).body);
    const orderId = orders[0]?.orderId as string;
    const invoiceId = orders[0]?.salesInvoiceId as string;

    const removed = await del(`/integrations/salla/orders/${orderId}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ deleted: true, id: orderId });

    const gone = await get(`/sales/invoices/${invoiceId}`);
    expect(gone.status).toBe(404);
    const left = rowsOf((await get('/integrations/salla/orders')).body);
    expect(left).toHaveLength(1);
  });

  it('الرفوض — «المتجر غير موجود» · «الطلب غير موجود» · «الصنف غير موجود»', async () => {
    const noStore = await post('/integrations/salla/products/pull', { connectionId: '00000000-0000-0000-0000-000000000000' });
    expect(noStore.status).toBe(404);
    expect(noStore.body).toMatchObject({ code: 'SALLA_CONNECTION_NOT_FOUND', detail: 'المتجر غير موجود' });

    const noOrder = await put('/integrations/salla/orders/00000000-0000-0000-0000-000000000000/status', { status: 'done' });
    expect(noOrder.status).toBe(404);
    expect(noOrder.body).toMatchObject({ code: 'SALLA_ORDER_NOT_FOUND', detail: 'الطلب غير موجود' });

    const noItem = await post('/integrations/salla/products/push', { connectionId, itemId: '00000000-0000-0000-0000-000000000000' });
    expect(noItem.status).toBe(404);
    expect(noItem.body).toMatchObject({ code: 'ITEM_NOT_FOUND' });

    // A صنف whose remote product is gone from the store: `SallaAPI`'s own sentence.
    const unlinked = await put('/integrations/salla/products/MOCK-P-1', { connectionId, itemId });
    expect(unlinked.status).toBe(502);
    expect(unlinked.body).toMatchObject({ code: 'SALLA_REQUEST_FAILED' });
    expect(String(unlinked.body.detail).startsWith('خطأ في الطلب: 404')).toBe(true);
  });

  it('الصلاحيات — القراءة بـ salla.integration.view والكتابة بـ salla.integration.manage', async () => {
    expect((await asViewer('get', '/integrations/salla/catalog')).status).toBe(200);
    expect((await asViewer('get', '/integrations/salla/orders')).status).toBe(200);
    expect((await asViewer('get', `/integrations/salla/customers?connectionId=${connectionId}`)).status).toBe(200);

    expect((await asViewer('post', '/integrations/salla/products/pull', { connectionId })).status).toBe(403);
    expect((await asViewer('post', '/integrations/salla/orders/pull', { connectionId })).status).toBe(403);
    expect((await asViewer('post', '/integrations/salla/products/push', { connectionId, itemId })).status).toBe(403);
  });

  it('عزل المستأجرين — طلبات هذا المتجر ليست عند جاره', async () => {
    expect((await asStranger('get', '/integrations/salla/orders')).status).toBe(200);
    expect(rowsOf((await asStranger('get', '/integrations/salla/orders')).body)).toEqual([]);
    expect(rowsOf((await asStranger('get', '/integrations/salla/catalog')).body)).toEqual([]);
    expect((await asStranger('post', '/integrations/salla/products/pull', { connectionId })).status).toBe(404);
    const orders = rowsOf((await get('/integrations/salla/orders')).body);
    if (orders[0]?.orderId) {
      expect((await asStranger('delete', `/integrations/salla/orders/${orders[0].orderId as string}`)).status).toBe(404);
    }
  });

  it('قطع المتجر — وكل ما جُلب تحته يذهب معه', async () => {
    const left = rowsOf((await get('/integrations/salla/orders')).body);
    for (const row of left) if (row.orderId) await del(`/integrations/salla/orders/${row.orderId as string}`);

    const disconnected = await del(`/integrations/salla/connections/${connectionId}`);
    expect(disconnected.status).toBe(200);
    expect(disconnected.body).toMatchObject({ deleted: true, id: connectionId });

    expect(rowsOf((await get('/integrations/salla/catalog')).body)).toEqual([]);
    expect((await post('/integrations/salla/products/pull', { connectionId })).status).toBe(404);
  });
});
