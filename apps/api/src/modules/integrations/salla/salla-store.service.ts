import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  branches,
  items,
  salesInvoiceLines,
  salesInvoices,
  sallaBranchMappings,
  sallaConnections,
  sallaExportLog,
  sallaItemSync,
  sallaOrders,
  sallaProducts,
  tenantSettings,
  withTenantTx,
  type DatabaseHandle,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { SalesService } from '../../sales/sales.service.js';

import { SallaClient, SallaRequestError, defaultTransport, type SallaTransport } from './salla-client.js';
import { decryptSallaSecret } from './salla-utils.js';

/**
 * 🛒 متجر سلة — `Form_WPF/FrmSallah.xaml` («تكامل Salla API») and the clients behind its
 * four buttons.
 *
 * The window is thin by design — it counts what it pulls (`«تم جلب {n} منتج.»`) and keeps
 * nothing — and the three menu items of `Home.xaml` L394 («متجر سلة»: المنتجات · إدارة
 * الطلبات · ربط المستودعات) have empty handlers. This service is where the counts come
 * from and where what was pulled stays:
 *
 *   «📦 جلب المنتجات» → `GET products`      → `salla_products`
 *   «➕ إضافة منتج»   → `POST products`     → `salla_item_sync.remote_id` + سجل التصدير
 *   «📋 جلب الطلبات»  → `GET orders`        → فاتورة مبيعات (`orderType = 'salla'`) + `salla_orders`
 *   «تحديث الحالة»    → `PUT orders/{id}/status` بـ`{ status }`
 *   «👥 العملاء»      → `GET customers`     → no table: the desktop maps them to nothing
 *
 * A طلب is imported **once**: `salla_orders.remote_id` is the guard, so pulling the same
 * page twice creates one invoice, not two.
 *
 * «📥 جلب الطلبات (2)» is not migrated: it is `await Task.Run(() => { })` followed by a
 * message box («جلب الطلبات (2) — يمكن تخصيصه لاحقاً»).
 */

export type RemoteProductRow = {
  id: string;
  remoteId: string;
  sku: string;
  name: string;
  price: string;
  quantity: string;
  status: string;
  currency: string;
  syncedAt: string;
};

export type RemoteOrderRow = {
  id: string;
  remoteId: string;
  number: string | null;
  remoteStatus: string | null;
  customerName: string;
  customerMobile: string;
  total: string;
  currency: string;
  placedAt: string | null;
  branchId: string | null;
  salesInvoiceId: string | null;
};

export type StoreOrderRow = {
  /** فاتورة المبيعات — the document itself, and what the screen opens. */
  id: string;
  /** `salla_orders.id` — null for an order that arrived by webhook before this part. */
  orderId: string | null;
  number: string | null;
  remoteId: string | null;
  remoteStatus: string | null;
  status: string;
  customer: string | null;
  mobile: string | null;
  total: string;
  paymentStatus: string;
  createdAt: string;
  salesInvoiceId: string;
};

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const textOf = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/** Salla nests money under `amount`, and sometimes hands it over as a plain number. */
function moneyOf(value: unknown): string {
  if (typeof value === 'number') return value.toFixed(4);
  if (typeof value === 'string') return Number(value || 0).toFixed(4);
  const nested = recordOf(value).amount;
  return moneyOf(nested ?? 0);
}

/** `{ data: [...] }` — Salla's envelope; a bare array is tolerated. */
function listOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const data = recordOf(body).data;
  return Array.isArray(data) ? data : [];
}

function productOf(row: unknown) {
  const source = recordOf(row);
  const remoteId = textOf(source.id ?? source.remote_id);
  if (!remoteId) return null;
  return {
    remoteId,
    sku: textOf(source.sku ?? source.SKU),
    name: textOf(source.name),
    price: moneyOf(source.price ?? source.amount),
    quantity: moneyOf(source.quantity),
    status: textOf(source.status ?? (typeof source.status === 'object' ? recordOf(source.status).slug : '')),
    currency: textOf(source.currency ?? 'SAR'),
  };
}

function orderOf(row: unknown) {
  const source = recordOf(row);
  const remoteId = textOf(source.id ?? source.reference_id);
  if (!remoteId) return null;
  const customer = recordOf(source.customer);
  return {
    remoteId,
    number: textOf(source.reference_id ?? source.number) || null,
    remoteStatus: typeof source.status === 'object' ? textOf(recordOf(source.status).slug) : textOf(source.status) || null,
    statusName: typeof source.status === 'object' ? textOf(recordOf(source.status).name) : '',
    customerName: [customer.first_name, customer.last_name].map((part) => textOf(part)).filter(Boolean).join(' ') || textOf(source.customer_name),
    customerMobile: textOf(customer.mobile ?? source.customer_mobile),
    total: moneyOf(recordOf(source.totals).total ?? source.total),
    currency: textOf(source.currency ?? 'SAR'),
    placedAt: typeof source.date === 'object' ? textOf(recordOf(source.date).date) : textOf(source.date),
    items: listOf(source.items).map((line) => {
      const entry = recordOf(line);
      return { name: textOf(entry.name), quantity: moneyOf(entry.quantity ?? 1), unitPrice: moneyOf(entry.price ?? entry.amount) };
    }),
  };
}

/** «➕ إضافة منتج» عند الديسكتوب يرسل أربعة مفاتيح بعينها — `name · price · quantity · description`. */
const productPayloadOf = (item: { nameAr: string; nameEn?: string | null; sku: string | null; salePrice: string | null }) => ({
  name: item.nameAr,
  price: Number(item.salePrice ?? 0),
  quantity: 0,
  description: item.nameEn ?? item.nameAr,
});

@Injectable()
export class SallaStoreService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sales: SalesService,
  ) {}

  async ensureEnabled(tenantId: string) {
    const [flag] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'integration.salla'))).limit(1),
    );
    if (flag && flag.value !== true && flag.value !== 'true') throw new DomainError('NOT_FOUND', 'Salla integration is disabled', 404);
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private async rawConnection(tenantId: string, connectionId: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(sallaConnections)
        .where(and(eq(sallaConnections.tenantId, tenantId), eq(sallaConnections.id, connectionId), isNull(sallaConnections.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('SALLA_CONNECTION_NOT_FOUND', 'المتجر غير موجود', 404);
    return row;
  }

  private async clientFor(tenantId: string, connectionId: string, transport?: SallaTransport): Promise<{ client: SallaClient; storeId: string }> {
    const connection = await this.rawConnection(tenantId, connectionId);
    const token = decryptSallaSecret(connection.accessTokenEnc);
    return { client: new SallaClient(token, transport ?? defaultTransport(connection.storeId)), storeId: connection.storeId };
  }

  /** `SallaAPI` raises `خطأ في الطلب: …`; the API answers with it, at 502. */
  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof SallaRequestError) throw new DomainError('SALLA_REQUEST_FAILED', error.message, 502);
      throw error;
    }
  }

  private async log(
    tenantId: string,
    entry: { connectionId: string; itemId?: string | null; action: string; status: 'queued' | 'sent' | 'failed'; requestPayload?: unknown; responsePayload?: unknown; error?: string },
  ) {
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.insert(sallaExportLog).values({
        id: newId(),
        tenantId,
        connectionId: entry.connectionId,
        itemId: entry.itemId ?? null,
        action: entry.action,
        status: entry.status,
        requestPayload: recordOf(entry.requestPayload),
        responsePayload: entry.responsePayload === undefined ? null : recordOf(entry.responsePayload),
        error: entry.error ?? null,
      }),
    );
  }

  /**
   * Which فرع ومستودع a طلب lands in: «ربط المستودعات» (`salla_branch_mappings`) أولاً،
   * ثم أول فرعٍ في المؤسسة — النافذة عند الديسكتوب لا تُربط (`ToolStripMenuItemSallaSafes_Click`
   * فارغ)، فالربط اختياري لا شرط.
   */
  private async resolveTarget(tenantId: string, connectionId: string, remoteBranchId?: string) {
    const mappings = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(sallaBranchMappings)
        .where(and(eq(sallaBranchMappings.tenantId, tenantId), eq(sallaBranchMappings.connectionId, connectionId), isNull(sallaBranchMappings.deletedAt))),
    );
    const mapping = (remoteBranchId ? mappings.find((row) => row.remoteBranchId === remoteBranchId) : undefined) ?? mappings[0];
    if (mapping?.branchId) return { branchId: mapping.branchId, warehouseId: mapping.warehouseId ?? undefined };
    const [branch] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, tenantId), isNull(branches.deletedAt))).limit(1),
    );
    return { branchId: branch?.id ?? '', warehouseId: mapping?.warehouseId ?? undefined };
  }

  // ─────────────────────────────── 📦 المنتجات ───────────────────────────────

  /** «📦 جلب المنتجات» — `ProductsManager.GetProducts()`, then every row in `salla_products`. */
  async pullProducts(tenantId: string, connectionId: string, transport?: SallaTransport) {
    await this.ensureEnabled(tenantId);
    const { client } = await this.clientFor(tenantId, connectionId, transport);
    const body = await this.call(() => client.products.list());
    const rows = listOf(body).map(productOf).filter((row): row is NonNullable<ReturnType<typeof productOf>> => Boolean(row));
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      for (const row of rows) {
        await tx
          .insert(sallaProducts)
          .values({ id: newId(), tenantId, connectionId, remoteId: row.remoteId, sku: row.sku, name: row.name, price: row.price, quantity: row.quantity, status: row.status, currency: row.currency })
          .onConflictDoUpdate({
            target: [sallaProducts.tenantId, sallaProducts.connectionId, sallaProducts.remoteId],
            set: { sku: row.sku, name: row.name, price: row.price, quantity: row.quantity, status: row.status, syncedAt: new Date(), updatedAt: new Date() },
          });
      }
    });
    await this.log(tenantId, { connectionId, action: 'pull', status: 'sent', responsePayload: { count: rows.length } });
    return { data: rows, count: rows.length, message: `تم جلب ${rows.length} منتج.` };
  }

  /** 📦 ما في المتجر الآن — the mirror «📦 جلب المنتجات» filled. */
  async listStoreProducts(tenantId: string, connectionId?: string): Promise<RemoteProductRow[]> {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(sallaProducts)
        .where(
          and(
            eq(sallaProducts.tenantId, tenantId),
            connectionId ? eq(sallaProducts.connectionId, connectionId) : undefined,
          ),
        )
        .orderBy(sallaProducts.remoteId)
        .limit(500),
    );
    return rows.map((row) => ({
      id: row.id,
      remoteId: row.remoteId,
      sku: row.sku ?? '',
      name: row.name ?? '',
      price: row.price,
      quantity: row.quantity,
      status: row.status ?? '',
      currency: row.currency,
      syncedAt: row.syncedAt.toISOString(),
    }));
  }

  /** ➕ إضافة منتج — `ProductsManager.CreateProduct()`, from a real صنف لا من نصٍّ ثابت. */
  async pushProduct(tenantId: string, input: { connectionId: string; itemId: string }, transport?: SallaTransport) {
    await this.ensureEnabled(tenantId);
    const item = await this.rawItem(tenantId, input.itemId);
    const { client } = await this.clientFor(tenantId, input.connectionId, transport);
    const payload = productPayloadOf(item);
    const body = await this.call(() => client.products.create(payload));
    const remoteId = textOf(recordOf(recordOf(body).data).id ?? recordOf(body).id);
    if (!remoteId) throw new DomainError('SALLA_REMOTE_ID_MISSING', 'لم يُرجع المتجر رقم المنتج', 502);
    await this.rememberSync(tenantId, { connectionId: input.connectionId, itemId: item.id, remoteId, snapshot: payload });
    await this.log(tenantId, { connectionId: input.connectionId, itemId: item.id, action: 'create', status: 'sent', requestPayload: payload, responsePayload: body });
    return { data: { itemId: item.id, remoteId }, message: 'تم إضافة المنتج بنجاح.' };
  }

  /** ✏️ `ProductsManager.UpdateProduct()` — the صنف's current state pushed onto its remote row. */
  async updateProduct(tenantId: string, input: { connectionId: string; itemId: string }, transport?: SallaTransport) {
    await this.ensureEnabled(tenantId);
    const item = await this.rawItem(tenantId, input.itemId);
    const remoteId = await this.remoteIdOf(tenantId, input);
    const { client } = await this.clientFor(tenantId, input.connectionId, transport);
    const payload = productPayloadOf(item);
    const body = await this.call(() => client.products.update(remoteId, payload));
    await this.rememberSync(tenantId, { connectionId: input.connectionId, itemId: item.id, remoteId, snapshot: payload });
    await this.log(tenantId, { connectionId: input.connectionId, itemId: item.id, action: 'update', status: 'sent', requestPayload: payload, responsePayload: body });
    return { data: { itemId: item.id, remoteId }, message: 'تم تحديث المنتج بنجاح.' };
  }

  /** 🗑️ `ProductsManager.DeleteProduct()` — gone from the store, and unlinked here. */
  async deleteProduct(tenantId: string, input: { connectionId: string; itemId: string }, transport?: SallaTransport) {
    await this.ensureEnabled(tenantId);
    await this.rawItem(tenantId, input.itemId);
    const remoteId = await this.remoteIdOf(tenantId, input);
    const { client } = await this.clientFor(tenantId, input.connectionId, transport);
    const body = await this.call(() => client.products.remove(remoteId));
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(sallaProducts)
        .set({ status: 'deleted', updatedAt: new Date() })
        .where(and(eq(sallaProducts.tenantId, tenantId), eq(sallaProducts.connectionId, input.connectionId), eq(sallaProducts.remoteId, remoteId))),
    );
    await this.log(tenantId, { connectionId: input.connectionId, itemId: input.itemId, action: 'delete', status: 'sent', responsePayload: body });
    return { data: { deleted: true, remoteId }, message: 'تم حذف المنتج من المتجر.' };
  }

  // ─────────────────────────────── 👥 العملاء ───────────────────────────────

  /**
   * «👥 العملاء» — `CustomersManager.GetCustomers()`. Nothing is stored: the desktop maps
   * a Salla customer to no table at all, and the order carries its own name and mobile.
   */
  async pullCustomers(tenantId: string, connectionId: string, transport?: SallaTransport) {
    await this.ensureEnabled(tenantId);
    const { client } = await this.clientFor(tenantId, connectionId, transport);
    const body = await this.call(() => client.customers.list());
    const rows = listOf(body).map((row) => {
      const source = recordOf(row);
      return {
        remoteId: textOf(source.id),
        name: [source.first_name, source.last_name].map((part) => textOf(part)).filter(Boolean).join(' '),
        mobile: textOf(source.mobile),
        email: textOf(source.email),
      };
    });
    return { data: rows, count: rows.length };
  }

  // ─────────────────────────────── 📋 الطلبات ───────────────────────────────

  /**
   * «📋 جلب الطلبات» — `OrdersManager.GetOrders()`, then a فاتورة مبيعات for every طلب
   * that is not here yet (`salla_orders.remote_id`).
   */
  async pullOrders(tenantId: string, connectionId: string, transport?: SallaTransport) {
    await this.ensureEnabled(tenantId);
    await this.rawConnection(tenantId, connectionId);
    const { client } = await this.clientFor(tenantId, connectionId, transport);
    const body = await this.call(() => client.orders.list());
    const remote = listOf(body).map(orderOf).filter((row): row is NonNullable<ReturnType<typeof orderOf>> => Boolean(row));

    const known = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ remoteId: sallaOrders.remoteId }).from(sallaOrders).where(and(eq(sallaOrders.tenantId, tenantId), eq(sallaOrders.connectionId, connectionId), isNull(sallaOrders.deletedAt))),
    );
    const done = new Set(known.map((row) => row.remoteId));
    const created: RemoteOrderRow[] = [];
    const skipped: string[] = [];

    for (const order of remote) {
      if (done.has(order.remoteId)) {
        skipped.push(order.remoteId);
        continue;
      }
      const target = await this.resolveTarget(tenantId, connectionId);
      if (!target.branchId) throw new DomainError('SALLA_BRANCH_REQUIRED', 'لا يوجد فرعٌ مربوط بهذا الطلب', 422);
      const invoice = await this.sales.create(tenantId, {
        branchId: target.branchId,
        warehouseId: target.warehouseId,
        cashCustomerName: order.customerName || 'عميل سلة',
        cashCustomerMobile: order.customerMobile || undefined,
        kind: 'sale',
        orderType: 'salla',
        lines: (order.items.length ? order.items : [{ name: 'طلب سلة', quantity: '1', unitPrice: order.total }]).map((line) => ({
          description: line.name || 'طلب سلة',
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          taxRate: '0',
        })),
      });
      const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .insert(sallaOrders)
          .values({
            id: newId(),
            tenantId,
            connectionId,
            remoteId: order.remoteId,
            number: order.number,
            remoteStatus: order.remoteStatus || null,
            customerName: order.customerName,
            customerMobile: order.customerMobile || null,
            currency: order.currency,
            total: order.total,
            placedAt: order.placedAt ? new Date(order.placedAt.replace(' ', 'T')) : null,
            branchId: target.branchId,
            warehouseId: target.warehouseId ?? null,
            salesInvoiceId: invoice.id,
            payload: { remoteStatusName: order.statusName },
          })
          .returning(),
      );
      created.push(this.orderRow(row!));
    }

    await this.log(tenantId, { connectionId, action: 'orders', status: 'sent', responsePayload: { count: remote.length, created: created.length, skipped: skipped.length } });
    return { data: created, count: remote.length, created: created.length, skipped, message: `تم جلب ${remote.length} طلب.` };
  }

  /**
   * «إدارة الطلبات» — every invoice tagged `salla` (`orderType`), with the remote number
   * and status beside it when the طلب came through this part's import.
   */
  async listOrders(tenantId: string): Promise<StoreOrderRow[]> {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          id: salesInvoices.id,
          orderId: sallaOrders.id,
          number: salesInvoices.number,
          status: salesInvoices.status,
          customer: salesInvoices.cashCustomerName,
          mobile: salesInvoices.cashCustomerMobile,
          total: salesInvoices.total,
          paymentStatus: salesInvoices.paymentStatus,
          createdAt: salesInvoices.createdAt,
          remoteId: sallaOrders.remoteId,
          remoteStatus: sallaOrders.remoteStatus,
        })
        .from(salesInvoices)
        .leftJoin(sallaOrders, eq(sallaOrders.salesInvoiceId, salesInvoices.id))
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.orderType, 'salla')))
        .orderBy(desc(salesInvoices.createdAt))
        .limit(200),
    );
    return rows.map((row) => ({
      id: row.id,
      orderId: row.orderId ?? null,
      number: row.number ?? null,
      remoteId: row.remoteId ?? null,
      remoteStatus: row.remoteStatus ?? null,
      status: row.status,
      customer: row.customer ?? null,
      mobile: row.mobile ?? null,
      total: row.total,
      paymentStatus: row.paymentStatus,
      createdAt: row.createdAt.toISOString(),
      salesInvoiceId: row.id,
    }));
  }

  /** `OrdersManager.UpdateOrderStatus()` — `PUT orders/{id}/status` بـ`{ status }`. */
  async updateOrderStatus(tenantId: string, orderId: string, status: string, transport?: SallaTransport) {
    await this.ensureEnabled(tenantId);
    const order = await this.rawOrder(tenantId, orderId);
    const trimmed = String(status ?? '').trim();
    if (!trimmed) throw new DomainError('SALLA_ORDER_STATUS_REQUIRED', 'يجب تحديد حالة الطلب', 422);
    const { client } = await this.clientFor(tenantId, order.connectionId, transport);
    const body = await this.call(() => client.orders.updateStatus(order.remoteId, trimmed));
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.update(sallaOrders).set({ remoteStatus: trimmed, updatedAt: new Date() }).where(eq(sallaOrders.id, orderId)).returning(),
    );
    await this.log(tenantId, { connectionId: order.connectionId, action: 'status', status: 'sent', requestPayload: { status: trimmed }, responsePayload: body });
    return { data: this.orderRow(row!) };
  }

  /**
   * 🗑️ حذف الطلب — the import's own way back.
   *
   * A مسوّدة (`draft`) invoice is safe to erase: it has no قيد, no حركة مخزون and no
   * إرسال إلى ZATCA. A posted one is not — «لا يمكن حذف طلبٍ مُرحَّل؛ أصدِر مرتجعاً
   * بدلاً منه» (جملةٌ مخترَعة: النافذة عند الديسكتوب لا تحذف طلباً أصلاً).
   */
  async deleteOrder(tenantId: string, orderId: string) {
    await this.ensureEnabled(tenantId);
    const order = await this.rawOrder(tenantId, orderId);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      if (order.salesInvoiceId) {
        const [invoice] = await tx
          .select({ id: salesInvoices.id, status: salesInvoices.status })
          .from(salesInvoices)
          .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, order.salesInvoiceId)));
        if (invoice && invoice.status !== 'draft') throw new DomainError('SALLA_ORDER_POSTED', 'لا يمكن حذف طلبٍ مُرحَّل؛ أصدِر مرتجعاً بدلاً منه', 409);
        if (invoice) {
          await tx.delete(salesInvoiceLines).where(and(eq(salesInvoiceLines.tenantId, tenantId), eq(salesInvoiceLines.invoiceId, invoice.id)));
          await tx.delete(salesInvoices).where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, invoice.id)));
        }
      }
      await tx.update(sallaOrders).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(sallaOrders.id, orderId));
    });
    return { deleted: true, id: orderId };
  }

  /**
   * قطع المتجر — the store's own mirrors go with it: منتجاته (`salla_products`) وحالة
   * مزامنة أصنافه (`salla_item_sync`). أما الطلبات (`salla_orders`) فتبقى: كلٌّ منها
   * فاتورة مبيعات قائمة في المؤسسة، والمرآة وحدها لا تُنشئ الفاتورة ولا تمحوها.
   */
  async disconnect(tenantId: string, connectionId: string) {
    await this.ensureEnabled(tenantId);
    await this.rawConnection(tenantId, connectionId);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.delete(sallaProducts).where(and(eq(sallaProducts.tenantId, tenantId), eq(sallaProducts.connectionId, connectionId)));
      await tx.delete(sallaItemSync).where(and(eq(sallaItemSync.tenantId, tenantId), eq(sallaItemSync.connectionId, connectionId)));
      await tx.update(sallaBranchMappings).set({ deletedAt: new Date() }).where(and(eq(sallaBranchMappings.tenantId, tenantId), eq(sallaBranchMappings.connectionId, connectionId)));
      await tx
        .update(sallaConnections)
        .set({ deletedAt: new Date(), status: 'revoked', updatedAt: new Date() })
        .where(and(eq(sallaConnections.tenantId, tenantId), eq(sallaConnections.id, connectionId)));
    });
    return { deleted: true, id: connectionId };
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private orderRow(row: typeof sallaOrders.$inferSelect): RemoteOrderRow {
    return {
      id: row.id,
      remoteId: row.remoteId,
      number: row.number ?? null,
      remoteStatus: row.remoteStatus ?? null,
      customerName: row.customerName ?? '',
      customerMobile: row.customerMobile ?? '',
      total: row.total,
      currency: row.currency,
      placedAt: row.placedAt ? row.placedAt.toISOString() : null,
      branchId: row.branchId ?? null,
      salesInvoiceId: row.salesInvoiceId ?? null,
    };
  }

  private async rawItem(tenantId: string, itemId: string) {
    const [item] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: items.id, nameAr: items.nameAr, nameEn: items.nameEn, sku: items.sku, salePrice: items.salePrice })
        .from(items)
        .where(and(eq(items.tenantId, tenantId), eq(items.id, itemId), isNull(items.deletedAt)))
        .limit(1),
    );
    if (!item) throw new DomainError('ITEM_NOT_FOUND', 'الصنف غير موجود', 404);
    return item;
  }

  /** The link between a صنف and its remote product — `salla_item_sync.remote_id`. */
  private async remoteIdOf(tenantId: string, input: { connectionId: string; itemId: string }): Promise<string> {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ remoteId: sallaItemSync.remoteId })
        .from(sallaItemSync)
        .where(and(eq(sallaItemSync.tenantId, tenantId), eq(sallaItemSync.connectionId, input.connectionId), eq(sallaItemSync.itemId, input.itemId)))
        .limit(1),
    );
    const remoteId = row?.remoteId;
    if (!remoteId) throw new DomainError('SALLA_REMOTE_ID_MISSING', 'الصنف غير مرتبط بمنتجٍ في المتجر', 422);
    return remoteId;
  }

  private async rememberSync(tenantId: string, input: { connectionId: string; itemId: string; remoteId: string; snapshot: Record<string, unknown> }) {
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(sallaItemSync)
        .values({
          id: newId(),
          tenantId,
          connectionId: input.connectionId,
          itemId: input.itemId,
          remoteId: input.remoteId,
          lastExportedSnapshot: input.snapshot,
          diffFlags: [],
          status: 'synced',
        })
        .onConflictDoUpdate({
          target: [sallaItemSync.tenantId, sallaItemSync.connectionId, sallaItemSync.itemId],
          set: { remoteId: input.remoteId, lastExportedSnapshot: input.snapshot, diffFlags: [], status: 'synced', updatedAt: new Date() },
        }),
    );
  }

  private async rawOrder(tenantId: string, orderId: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(sallaOrders).where(and(eq(sallaOrders.tenantId, tenantId), eq(sallaOrders.id, orderId), isNull(sallaOrders.deletedAt))).limit(1),
    );
    if (!row) throw new DomainError('SALLA_ORDER_NOT_FOUND', 'الطلب غير موجود', 404);
    return row;
  }
}
