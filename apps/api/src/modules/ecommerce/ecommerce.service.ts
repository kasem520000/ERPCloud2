import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import {
  branches,
  ecommerceOrders,
  ecommerceStores,
  ecommerceSyncLogs,
  platformSettings,
  stockBalances,
  withTenantTx,
  type DatabaseHandle,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import type { DomainEvent } from '../../events/domain-events.service.js';
import { SalesService } from '../sales/sales.service.js';
import { OutboxService } from '../platform-services/index.js';
import { setAuditTenantId } from '../../request-context/request-context.js';

import {
  decryptEcommerceSecret,
  encryptEcommerceSecret,
  maskSecret,
  verifyEcommerceSignature,
} from './ecommerce.utils.js';
import { EcommerceProviderRegistry } from './ecommerce.providers.js';
import {
  ECOMMERCE_PROVIDERS,
  type EcommerceOrderDto,
  type EcommerceProvider,
  type EcommerceStoreDto,
  type EcommerceStoreInput,
  type RemoteOrder,
  type RemoteOrderLine,
  type SyncResult,
} from './ecommerce.types.js';

const PROCESSING_MARKER = '__ecommerce_import_processing__';

@Injectable()
export class EcommerceService {
  private readonly logger = new Logger(EcommerceService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly providers: EcommerceProviderRegistry,
    private readonly outbox: OutboxService,
    private readonly sales: SalesService,
  ) {}

  listProviders() {
    return ECOMMERCE_PROVIDERS.map((provider) => ({
      provider,
      label: provider === 'salla' ? 'سلة' : provider === 'zid' ? 'زد' : 'Shopify',
      supports: ['orders', 'stock'],
    }));
  }

  async listStores(tenantId: string): Promise<EcommerceStoreDto[]> {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(ecommerceStores)
        .where(eq(ecommerceStores.tenantId, tenantId))
        .orderBy(desc(ecommerceStores.createdAt)),
    );
    return rows.map((row) => this.toStoreDto(row));
  }

  async createStore(tenantId: string, input: EcommerceStoreInput): Promise<EcommerceStoreDto> {
    const token = (input.apiKey ?? input.code ?? '').trim();
    if (!token)
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'apiKey or code is required', 422, {
        field: 'apiKey',
      });
    if (!ECOMMERCE_PROVIDERS.includes(input.provider)) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `Unsupported e-commerce provider '${input.provider}'`,
        422,
        { field: 'provider' },
      );
    }
    if (input.provider === 'shopify' && !input.storeUrl?.trim()) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'storeUrl is required for Shopify', 422, {
        field: 'storeUrl',
      });
    }
    if (input.storeUrl) {
      try {
        const url = new URL(input.storeUrl);
        if (url.protocol !== 'https:') throw new Error('https required');
      } catch {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'storeUrl must be an HTTPS URL', 422, {
          field: 'storeUrl',
        });
      }
    }

    const id = newId();
    const encryptionKey = await this.encryptionKey(tenantId);
    const [created] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(ecommerceStores)
        .values({
          id,
          tenantId,
          provider: input.provider,
          storeUrl: input.storeUrl?.trim() || null,
          remoteStoreId: input.remoteStoreId ?? null,
          accessTokenEnc: encryptEcommerceSecret(token, encryptionKey),
          refreshTokenEnc: input.refreshToken
            ? encryptEcommerceSecret(input.refreshToken.trim(), encryptionKey)
            : null,
          webhookSecretEnc: encryptEcommerceSecret((input.webhookSecret ?? token).trim(), encryptionKey),
          status: 'error',
          settings: input.settings ?? {},
        })
        .returning(),
    );
    if (!created) throw new Error('E-commerce store insert returned no row');

    let result;
    try {
      result = await this.providers.client(input.provider, token).testConnection(input.storeUrl);
    } catch (error) {
      result = {
        ok: false,
        status: 502,
        message: error instanceof Error ? error.message : 'Connection test failed',
      };
    }

    const status = result.ok ? 'active' : 'error';
    const [updated] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(ecommerceStores)
        .set({
          status,
          remoteStoreId: result.remoteStoreId ?? created.remoteStoreId,
          lastError: result.ok ? null : (result.message ?? 'Provider connection failed').slice(0, 2_000),
          updatedAt: new Date(),
          version: created.version + 1,
        })
        .where(and(eq(ecommerceStores.tenantId, tenantId), eq(ecommerceStores.id, id)))
        .returning(),
    );
    if (!updated) throw new Error('E-commerce store update returned no row');
    await this.writeLog(
      tenantId,
      id,
      'in',
      'connection',
      result.ok ? 'success' : 'error',
      result.ok ? 'Connected' : (result.message ?? 'Connection failed'),
      0,
    );
    if (!result.ok)
      this.logger.warn({ tenantId, storeId: id, provider: input.provider }, 'e-commerce token rejected');
    return this.toStoreDto(updated);
  }

  async deleteStore(tenantId: string, storeId: string): Promise<void> {
    const deleted = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .delete(ecommerceStores)
        .where(and(eq(ecommerceStores.tenantId, tenantId), eq(ecommerceStores.id, storeId)))
        .returning({ id: ecommerceStores.id }),
    );
    if (!deleted.length) throw new DomainError(errorCodes.NOT_FOUND, 'E-commerce store was not found', 404);
  }

  async getLogs(tenantId: string, storeId: string) {
    await this.getStore(tenantId, storeId);
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(ecommerceSyncLogs)
        .where(and(eq(ecommerceSyncLogs.tenantId, tenantId), eq(ecommerceSyncLogs.storeId, storeId)))
        .orderBy(desc(ecommerceSyncLogs.createdAt))
        .limit(50),
    );
  }

  async syncStore(tenantId: string, storeId: string): Promise<SyncResult> {
    const store = await this.getStore(tenantId, storeId);
    const token = decryptEcommerceSecret(store.accessTokenEnc, await this.encryptionKey(tenantId));
    const result = await this.providers
      .client(store.provider as EcommerceProvider, token)
      .listOrders(store.storeUrl);
    if (!result.ok) {
      await this.markStoreError(tenantId, storeId, result.message ?? 'Provider order sync failed');
      const logId = await this.writeLog(
        tenantId,
        storeId,
        'in',
        'order',
        'error',
        result.message ?? 'Provider order sync failed',
        0,
      );
      throw new DomainError('ECOMMERCE_PROVIDER_ERROR', result.message ?? 'Provider order sync failed', 502, {
        logId,
      });
    }

    let created = 0;
    let skipped = 0;
    let imported = 0;
    let failed = 0;
    for (const remote of result.orders ?? []) {
      const { orderId, isNew } = await this.upsertRemoteOrder(tenantId, storeId, remote);
      if (!isNew) {
        skipped += 1;
        continue;
      }
      created += 1;
      await this.enqueueImport(tenantId, orderId);
      // The queue is the durable hand-off. Running once inline keeps a development stack
      // without Redis useful; the idempotent maintenance worker safely replays it later.
      try {
        await this.processImport(tenantId, orderId);
        imported += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          { tenantId, storeId, orderId, err: error instanceof Error ? error.message : String(error) },
          'e-commerce order import failed',
        );
      }
    }

    const now = new Date();
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(ecommerceStores)
        .set({
          lastSyncAt: now,
          lastError: failed ? `${failed} order(s) failed to import` : null,
          updatedAt: now,
        })
        .where(and(eq(ecommerceStores.tenantId, tenantId), eq(ecommerceStores.id, storeId))),
    );
    const logId = await this.writeLog(
      tenantId,
      storeId,
      'in',
      'order',
      failed ? 'error' : 'success',
      `Fetched ${result.orders?.length ?? 0} order(s)`,
      result.orders?.length ?? 0,
      { created, skipped, imported, failed },
    );
    return {
      storeId,
      provider: store.provider as EcommerceProvider,
      fetched: result.orders?.length ?? 0,
      created,
      skipped,
      imported,
      failed,
      logId,
    };
  }

  async receiveWebhook(
    provider: EcommerceProvider,
    tenantId: string,
    rawBody: Buffer,
    body: Record<string, unknown>,
    signature: string | undefined,
    storeId?: string,
  ) {
    if (!tenantId)
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'tenantId is required for a public webhook ingress',
        422,
        { field: 'tenantId' },
      );
    const store = await this.findWebhookStore(tenantId, provider, storeId ?? stringValue(body.storeId));
    const secret = decryptEcommerceSecret(
      store.webhookSecretEnc ?? store.accessTokenEnc,
      await this.encryptionKey(tenantId),
    );
    if (!verifyEcommerceSignature(rawBody, signature, secret)) {
      throw new DomainError(
        'ECOMMERCE_WEBHOOK_SIGNATURE_INVALID',
        'Invalid e-commerce webhook signature',
        401,
      );
    }

    // AUD-14 — التوقيع أثبت أن الطلب يخصّ هذا المستأجر: يُنسب إليه سجلّ التدقيق.
    setAuditTenantId(tenantId);

    const remote = normaliseIncomingOrder(body);
    if (!remote.id)
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'Webhook order id is required', 422, {
        field: 'id',
      });
    const { orderId, isNew } = await this.upsertRemoteOrder(tenantId, store.id, remote);
    if (isNew) {
      await this.enqueueImport(tenantId, orderId);
      try {
        await this.processImport(tenantId, orderId);
      } catch (error) {
        this.logger.warn(
          {
            tenantId,
            storeId: store.id,
            orderId,
            err: error instanceof Error ? error.message : String(error),
          },
          'e-commerce webhook import failed',
        );
      }
    }
    await this.writeLog(
      tenantId,
      store.id,
      'in',
      'order',
      'success',
      isNew ? 'Webhook order accepted' : 'Duplicate webhook ignored',
      isNew ? 1 : 0,
      { duplicate: !isNew },
    );
    return { accepted: true, duplicate: !isNew, orderId };
  }

  async listOrders(
    tenantId: string,
    filters: { storeId?: string; status?: string },
  ): Promise<EcommerceOrderDto[]> {
    const conditions = [eq(ecommerceOrders.tenantId, tenantId)];
    if (filters.storeId) conditions.push(eq(ecommerceOrders.storeId, filters.storeId));
    if (filters.status) conditions.push(eq(ecommerceOrders.status, filters.status));
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(ecommerceOrders)
        .where(and(...conditions))
        .orderBy(desc(ecommerceOrders.receivedAt))
        .limit(200),
    );
    const stores = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: ecommerceStores.id, provider: ecommerceStores.provider })
        .from(ecommerceStores)
        .where(eq(ecommerceStores.tenantId, tenantId)),
    );
    const providerByStore = new Map(stores.map((store) => [store.id, store.provider as EcommerceProvider]));
    return rows.map((row) => this.toOrderDto(row, providerByStore.get(row.storeId) ?? 'salla'));
  }

  /** Registered as `maintenance:ecommerce.import`. */
  async processImport(tenantId: string, orderId: string): Promise<void> {
    const claimed = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(ecommerceOrders)
        .where(and(eq(ecommerceOrders.tenantId, tenantId), eq(ecommerceOrders.id, orderId)))
        .limit(1);
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'E-commerce order was not found', 404);
      if (row.status === 'imported') return null;
      const [next] = await tx
        .update(ecommerceOrders)
        .set({ error: PROCESSING_MARKER, updatedAt: new Date(), version: row.version + 1 })
        .where(
          and(
            eq(ecommerceOrders.tenantId, tenantId),
            eq(ecommerceOrders.id, orderId),
            inArray(ecommerceOrders.status, ['pending', 'failed']),
            isNull(ecommerceOrders.error),
          ),
        )
        .returning();
      return next ?? null;
    });
    if (!claimed) return;

    try {
      const store = await this.getStore(tenantId, claimed.storeId);
      const payload = claimed.payload;
      const settings = (store.settings ?? {}) as Record<string, unknown>;
      const branchId = await this.resolveBranch(
        tenantId,
        typeof settings.branchId === 'string' ? settings.branchId : undefined,
      );
      const remote = normaliseIncomingOrder(payload);
      const lines = (
        remote.lines.length
          ? remote.lines
          : [{ name: 'Store order', quantity: '1', unitPrice: claimed.total }]
      ).map((line) => ({
        description: line.name,
        quantity: line.quantity || '1',
        unitPrice: line.unitPrice || '0',
        taxRate: '0',
      }));
      const invoice = await this.sales.create(tenantId, {
        branchId,
        warehouseId: typeof settings.warehouseId === 'string' ? settings.warehouseId : undefined,
        cashCustomerName: remote.customerName ?? claimed.customerName ?? 'E-commerce customer',
        cashCustomerMobile: remote.customerMobile ?? claimed.customerMobile ?? undefined,
        kind: 'sale',
        orderType: `ecommerce:${store.provider}`,
        lines,
      });
      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(ecommerceOrders)
          .set({
            status: 'imported',
            erpInvoiceId: invoice.id,
            error: null,
            importedAt: new Date(),
            updatedAt: new Date(),
            version: claimed.version + 1,
          })
          .where(and(eq(ecommerceOrders.tenantId, tenantId), eq(ecommerceOrders.id, orderId))),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(ecommerceOrders)
          .set({
            status: 'failed',
            error: message.slice(0, 2_000),
            updatedAt: new Date(),
            version: claimed.version + 1,
          })
          .where(and(eq(ecommerceOrders.tenantId, tenantId), eq(ecommerceOrders.id, orderId))),
      );
      throw error;
    }
  }

  /** Registered as `maintenance:ecommerce.stock`; no new queue is introduced. */
  async processStock(
    tenantId: string,
    payload: {
      storeId: string;
      itemId: string;
      warehouseId?: string;
      remoteItemId?: string;
      invoiceId?: string;
    },
  ): Promise<void> {
    const store = await this.getStore(tenantId, payload.storeId);
    if (store.status !== 'active') return;
    const token = decryptEcommerceSecret(store.accessTokenEnc, await this.encryptionKey(tenantId));
    const quantity = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions = [eq(stockBalances.tenantId, tenantId), eq(stockBalances.itemId, payload.itemId)];
      if (payload.warehouseId) conditions.push(eq(stockBalances.warehouseId, payload.warehouseId));
      const [row] = await tx
        .select({ quantity: sql<string>`coalesce(sum(${stockBalances.quantity}), 0)` })
        .from(stockBalances)
        .where(and(...conditions));
      return row?.quantity ?? '0';
    });
    const remoteItemId = payload.remoteItemId ?? payload.itemId;
    const result = await this.providers
      .client(store.provider as EcommerceProvider, token)
      .updateStock(store.storeUrl, remoteItemId, quantity);
    if (!result.ok) {
      await this.markStoreError(tenantId, store.id, result.message ?? 'Stock update failed');
      await this.writeLog(
        tenantId,
        store.id,
        'out',
        'stock',
        'error',
        result.message ?? 'Stock update failed',
        0,
        { itemId: payload.itemId },
      );
      throw new Error(result.message ?? 'E-commerce stock update failed');
    }
    await this.writeLog(tenantId, store.id, 'out', 'stock', 'success', 'Stock quantity updated', 1, {
      itemId: payload.itemId,
      quantity,
    });
  }

  /** Called from the `sales.invoice.posted` domain event. */
  async enqueueStockForPostedSale(event: DomainEvent): Promise<void> {
    if (event.tenantId === null) return;
    const payload = event.payload as {
      invoiceId?: string;
      warehouseId?: string;
      lines?: Array<{ itemId?: string; remoteItemId?: string; quantity?: string }>;
    };
    const lines = payload.lines ?? [];
    if (!payload.invoiceId || !lines.length) return;
    const stores = await withTenantTx(this.database.db, event.tenantId, (tx) =>
      tx
        .select({ id: ecommerceStores.id })
        .from(ecommerceStores)
        .where(and(eq(ecommerceStores.tenantId, event.tenantId!), eq(ecommerceStores.status, 'active'))),
    );
    for (const store of stores) {
      for (const line of lines) {
        if (!line.itemId) continue;
        await this.outbox.enqueue({
          tenantId: event.tenantId,
          queue: 'maintenance',
          type: 'ecommerce.stock',
          payload: {
            storeId: store.id,
            itemId: line.itemId,
            warehouseId: payload.warehouseId,
            remoteItemId: line.remoteItemId,
            invoiceId: payload.invoiceId,
          },
        });
      }
    }
  }

  private async enqueueImport(tenantId: string, orderId: string): Promise<void> {
    await this.outbox.enqueue({
      tenantId,
      queue: 'maintenance',
      type: 'ecommerce.import',
      payload: { orderId },
    });
  }

  private async getStore(tenantId: string, storeId: string) {
    const [store] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(ecommerceStores)
        .where(and(eq(ecommerceStores.tenantId, tenantId), eq(ecommerceStores.id, storeId)))
        .limit(1),
    );
    if (!store) throw new DomainError(errorCodes.NOT_FOUND, 'E-commerce store was not found', 404);
    return store;
  }

  private async findWebhookStore(tenantId: string, provider: EcommerceProvider, storeId?: string) {
    const stores = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(ecommerceStores)
        .where(
          and(
            eq(ecommerceStores.tenantId, tenantId),
            eq(ecommerceStores.provider, provider),
            ...(storeId ? [eq(ecommerceStores.id, storeId)] : []),
          ),
        )
        .orderBy(asc(ecommerceStores.createdAt))
        .limit(2),
    );
    if (!stores.length)
      throw new DomainError('ECOMMERCE_STORE_NOT_FOUND', 'E-commerce store was not found', 404);
    if (!storeId && stores.length > 1)
      throw new DomainError(
        'ECOMMERCE_STORE_REQUIRED',
        'storeId is required when a tenant has more than one store for this provider',
        422,
        { field: 'storeId' },
      );
    const store = stores[0];
    if (!store) throw new DomainError('ECOMMERCE_STORE_NOT_FOUND', 'E-commerce store was not found', 404);
    return store;
  }

  private async resolveBranch(tenantId: string, preferred?: string): Promise<string> {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.tenantId, tenantId), ...(preferred ? [eq(branches.id, preferred)] : [])))
        .orderBy(desc(branches.isDefault), asc(branches.createdAt))
        .limit(1),
    );
    if (!rows[0])
      throw new DomainError(
        'ECOMMERCE_BRANCH_REQUIRED',
        'Create or configure a branch before importing store orders',
        422,
      );
    return rows[0].id;
  }

  private async upsertRemoteOrder(
    tenantId: string,
    storeId: string,
    remote: RemoteOrder,
  ): Promise<{ orderId: string; isNew: boolean }> {
    const payload = {
      ...remote.raw,
      id: remote.id,
      orderNo: remote.orderNo,
      status: remote.status,
      customerName: remote.customerName,
      customerMobile: remote.customerMobile,
      currency: remote.currency,
      total: remote.total,
      lines: remote.lines,
    } as Record<string, unknown>;
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(ecommerceOrders)
        .where(
          and(
            eq(ecommerceOrders.tenantId, tenantId),
            eq(ecommerceOrders.storeId, storeId),
            eq(ecommerceOrders.remoteId, remote.id),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.status === 'pending' || existing.status === 'failed') {
          await tx
            .update(ecommerceOrders)
            .set({
              remoteStatus: remote.status ?? existing.remoteStatus,
              payload,
              customerName: remote.customerName ?? existing.customerName,
              customerMobile: remote.customerMobile ?? existing.customerMobile,
              total: remote.total,
              updatedAt: new Date(),
              version: existing.version + 1,
            })
            .where(and(eq(ecommerceOrders.tenantId, tenantId), eq(ecommerceOrders.id, existing.id)));
        }
        return { orderId: existing.id, isNew: false };
      }
      const id = newId();
      await tx.insert(ecommerceOrders).values({
        id,
        tenantId,
        storeId,
        remoteId: remote.id,
        remoteOrderNo: remote.orderNo ?? null,
        remoteStatus: remote.status ?? null,
        status: 'pending',
        customerName: remote.customerName ?? null,
        customerMobile: remote.customerMobile ?? null,
        currency: remote.currency ?? 'SAR',
        total: remote.total,
        payload,
      });
      return { orderId: id, isNew: true };
    });
  }

  private async writeLog(
    tenantId: string,
    storeId: string,
    direction: 'in' | 'out',
    entity: string,
    status: 'started' | 'success' | 'error',
    message: string,
    records: number,
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    const id = newId();
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.insert(ecommerceSyncLogs).values({
        id,
        tenantId,
        storeId,
        direction,
        entity,
        status,
        message: message.slice(0, 2_000),
        records,
        metadata,
        finishedAt: new Date(),
      }),
    );
    return id;
  }

  private async markStoreError(tenantId: string, storeId: string, message: string): Promise<void> {
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(ecommerceStores)
        .set({ status: 'error', lastError: message.slice(0, 2_000), updatedAt: new Date() })
        .where(and(eq(ecommerceStores.tenantId, tenantId), eq(ecommerceStores.id, storeId))),
    );
  }

  /**
   * The tenant may override the deployment root with the secret held in
   * `platform_settings.ecommerce_encryption_key`. We intentionally read the setting
   * inside the same tenant-scoped transaction as every other tenant table; if no setting
   * exists, DATA_ENC_KEY remains the backwards-compatible deployment default.
   */
  private async encryptionKey(tenantId: string): Promise<string | undefined> {
    const [setting] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ value: platformSettings.value })
        .from(platformSettings)
        .where(
          and(eq(platformSettings.tenantId, tenantId), eq(platformSettings.key, 'ecommerce_encryption_key')),
        )
        .limit(1),
    );
    if (typeof setting?.value === 'string' && setting.value.trim()) return setting.value;
    if (isRecord(setting?.value) && typeof setting.value.key === 'string' && setting.value.key.trim())
      return setting.value.key;
    return process.env.DATA_ENC_KEY;
  }

  private toStoreDto(row: typeof ecommerceStores.$inferSelect): EcommerceStoreDto {
    return {
      id: row.id,
      provider: row.provider as EcommerceProvider,
      storeUrl: row.storeUrl,
      remoteStoreId: row.remoteStoreId,
      status: row.status,
      settings: row.settings as Record<string, unknown>,
      hasAccessToken: Boolean(row.accessTokenEnc),
      accessTokenMasked: maskSecret(row.accessTokenEnc),
      hasRefreshToken: Boolean(row.refreshTokenEnc),
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toOrderDto(
    row: typeof ecommerceOrders.$inferSelect,
    provider: EcommerceProvider,
  ): EcommerceOrderDto {
    return {
      id: row.id,
      storeId: row.storeId,
      provider,
      remoteId: row.remoteId,
      remoteOrderNo: row.remoteOrderNo,
      remoteStatus: row.remoteStatus,
      status: row.status,
      customerName: row.customerName,
      customerMobile: row.customerMobile,
      currency: row.currency,
      total: row.total,
      payload: row.payload as Record<string, unknown>,
      erpInvoiceId: row.erpInvoiceId,
      error: row.error === PROCESSING_MARKER ? null : row.error,
      receivedAt: row.receivedAt.toISOString(),
      importedAt: row.importedAt?.toISOString() ?? null,
    };
  }
}

function normaliseIncomingOrder(body: Record<string, unknown>): RemoteOrder {
  const source = isRecord(body.data) ? body.data : body;
  const customer = isRecord(source.customer) ? source.customer : {};
  const rawLines = Array.isArray(source.lines)
    ? source.lines
    : Array.isArray(source.items)
      ? source.items
      : Array.isArray(source.line_items)
        ? source.line_items
        : [];
  const lines: RemoteOrderLine[] = rawLines.map((value) => {
    const row = isRecord(value) ? value : {};
    return {
      id: stringValue(row.id),
      name: stringValue(row.name) ?? stringValue(row.title) ?? 'Store item',
      sku: stringValue(row.sku),
      quantity: decimalString(row.quantity ?? row.qty ?? 1),
      unitPrice: decimalString(
        valueOf(row.unitPrice) ?? valueOf(row.unit_price) ?? valueOf(row.price) ?? valueOf(row.amount) ?? '0',
      ),
      itemId: stringValue(row.itemId),
    };
  });
  const orderTotal = decimalString(
    valueOf(source.total) ??
      valueOf(source.amount) ??
      valueOf(source.total_price) ??
      valueOf(recordValue(source.totals, 'total')) ??
      '0',
  );
  return {
    id: stringValue(source.id) ?? stringValue(source.order_id) ?? '',
    orderNo:
      stringValue(source.orderNo) ??
      stringValue(source.order_no) ??
      stringValue(source.order_number) ??
      stringValue(source.reference_id) ??
      stringValue(source.number),
    status:
      stringValue(source.status) ??
      stringValue(recordValue(source.status, 'slug')) ??
      stringValue(source.order_status),
    customerName:
      stringValue(customer.name) ??
      ([stringValue(customer.first_name), stringValue(customer.last_name)].filter(Boolean).join(' ') ||
        stringValue(source.customerName)),
    customerMobile:
      stringValue(customer.mobile) ?? stringValue(customer.phone) ?? stringValue(source.customerMobile),
    currency: stringValue(source.currency) ?? 'SAR',
    total: orderTotal,
    lines: lines.length ? lines : [{ name: 'Store order', quantity: '1', unitPrice: orderTotal }],
    raw: body,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function valueOf(value: unknown): unknown {
  if (isRecord(value)) return value.amount ?? value.value ?? value.total;
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function decimalString(value: unknown): string {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(4) : '0.0000';
}
