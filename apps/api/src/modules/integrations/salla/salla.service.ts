import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import { branches, itemCategories, items, salesInvoices, sallaBranchMappings, sallaConnections, sallaExportLog, sallaItemSync, tenantSettings, warehouses, withPlatformAdminTx, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { SalesService } from '../../sales/sales.service.js';
import { setAuditTenantId } from '../../../request-context/request-context.js';

import { decryptSallaSecret, detectSallaDiff, encryptSallaSecret, verifySallaSignature } from './salla-utils.js';

@Injectable()
export class SallaService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle, private readonly sales: SalesService) {}
  async ensureEnabled(tenantId: string) { const [flag] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'integration.salla'))).limit(1)); if (flag && flag.value !== true && flag.value !== 'true') throw new DomainError('NOT_FOUND', 'Salla integration is disabled', 404); }
  authUrl(tenantId: string, input: { clientId: string; redirectUri: string; state: string }) { void tenantId; if (!input.state || input.state.length < 12) throw new DomainError('SALLA_STATE_REQUIRED', 'OAuth state nonce is required', 422); const url = new URL('https://accounts.salla.sa/oauth2/auth'); url.searchParams.set('response_type', 'code'); url.searchParams.set('client_id', input.clientId); url.searchParams.set('redirect_uri', input.redirectUri); url.searchParams.set('state', input.state); return { url: url.toString(), state: input.state }; }
  async connect(tenantId: string, input: { storeId: string; accessToken: string; refreshToken?: string; webhookSecret: string; scopes?: string[]; expiresAt?: string }) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(sallaConnections).values({ id: newId(), tenantId, storeId: input.storeId, accessTokenEnc: encryptSallaSecret(input.accessToken), refreshTokenEnc: input.refreshToken ? encryptSallaSecret(input.refreshToken) : null, webhookSecretEnc: encryptSallaSecret(input.webhookSecret), scopes: input.scopes ?? [], expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }).returning()); return this.mask(row); }
  async mapBranch(tenantId: string, input: { connectionId: string; branchId?: string; warehouseId?: string; cashLocationId?: string; remoteBranchId?: string }) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(sallaBranchMappings).values({ id: newId(), tenantId, ...input }).returning()); return row; }
  async queueExport(tenantId: string, input: { connectionId: string; itemId: string; action?: 'create' | 'update' | 'price' | 'qty' }) { await this.ensureEnabled(tenantId); const flags = await this.refreshDiff(tenantId, input.connectionId, input.itemId); const [log] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(sallaExportLog).values({ id: newId(), tenantId, connectionId: input.connectionId, itemId: input.itemId, action: input.action ?? 'update', requestPayload: { diffFlags: flags } }).returning()); return { data: log, diffFlags: flags }; }
  async refreshDiff(tenantId: string, connectionId: string, itemId: string) { const [item] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(items).where(and(eq(items.tenantId, tenantId), eq(items.id, itemId)))); if (!item) throw new DomainError('ITEM_NOT_FOUND', 'Item not found', 404); const snapshot = { name: item.nameAr, price: item.salePrice ?? '0', cost: item.purchasePrice ?? '0', qty: '0' }; const [sync] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(sallaItemSync).where(and(eq(sallaItemSync.tenantId, tenantId), eq(sallaItemSync.connectionId, connectionId), eq(sallaItemSync.itemId, itemId)))); const flags = detectSallaDiff(snapshot, sync?.lastExportedSnapshot ?? {}); await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(sallaItemSync).values({ id: newId(), tenantId, connectionId, itemId, lastExportedSnapshot: sync?.lastExportedSnapshot ?? {}, diffFlags: flags, status: flags.length ? 'changed' : 'synced' }).onConflictDoUpdate({ target: [sallaItemSync.tenantId, sallaItemSync.connectionId, sallaItemSync.itemId], set: { diffFlags: flags, status: flags.length ? 'changed' : 'synced', updatedAt: new Date() } })); return flags; }
  async exportNext(tenantId: string) { await this.ensureEnabled(tenantId); const [log] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(sallaExportLog).where(and(eq(sallaExportLog.tenantId, tenantId), eq(sallaExportLog.status, 'queued'))).orderBy(sallaExportLog.createdAt).limit(1)); if (!log) return { data: null }; await withTenantTx(this.database.db, tenantId, async (tx) => { const [item] = log.itemId ? await tx.select().from(items).where(and(eq(items.tenantId, tenantId), eq(items.id, log.itemId))) : [undefined]; const snapshot = item ? { name: item.nameAr, price: item.salePrice ?? '0', cost: item.purchasePrice ?? '0', qty: '0' } : {}; await tx.update(sallaExportLog).set({ status: 'sent', responsePayload: { ok: true, mock: true, remoteId: log.itemId } }).where(and(eq(sallaExportLog.tenantId, tenantId), eq(sallaExportLog.id, log.id))); if (log.connectionId && log.itemId) await tx.update(sallaItemSync).set({ status: 'synced', diffFlags: [], lastExportedSnapshot: snapshot, attempts: 0, updatedAt: new Date() }).where(and(eq(sallaItemSync.tenantId, tenantId), eq(sallaItemSync.connectionId, log.connectionId), eq(sallaItemSync.itemId, log.itemId))); }); return { data: { ...log, status: 'sent' } }; }
  /** Connections without any secret material — the screens only need identity and health. */
  async listConnections(tenantId: string) { await this.ensureEnabled(tenantId); const rows = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(sallaConnections).where(and(eq(sallaConnections.tenantId, tenantId), isNull(sallaConnections.deletedAt))).orderBy(desc(sallaConnections.createdAt))); return { data: rows.map((row) => this.mask(row)) }; }

  async listBranchMappings(tenantId: string) { await this.ensureEnabled(tenantId); return { data: await withTenantTx(this.database.db, tenantId, (tx) => tx.select({ id: sallaBranchMappings.id, connectionId: sallaBranchMappings.connectionId, storeId: sallaConnections.storeId, branchId: sallaBranchMappings.branchId, branchName: branches.nameAr, warehouseId: sallaBranchMappings.warehouseId, warehouseName: warehouses.name, remoteBranchId: sallaBranchMappings.remoteBranchId, cashLocationId: sallaBranchMappings.cashLocationId }).from(sallaBranchMappings).leftJoin(sallaConnections, eq(sallaConnections.id, sallaBranchMappings.connectionId)).leftJoin(branches, eq(branches.id, sallaBranchMappings.branchId)).leftJoin(warehouses, eq(warehouses.id, sallaBranchMappings.warehouseId)).where(and(eq(sallaBranchMappings.tenantId, tenantId), isNull(sallaBranchMappings.deletedAt)))) }; }

  /** Every sellable item plus its export state, so the products screen shows what still needs pushing. */
  async listProducts(tenantId: string) { await this.ensureEnabled(tenantId); return { data: await withTenantTx(this.database.db, tenantId, (tx) => tx.select({ itemId: items.id, sku: items.sku, nameAr: items.nameAr, categoryName: itemCategories.nameAr, salePrice: items.salePrice, showInPos: items.showInPos, connectionId: sallaItemSync.connectionId, remoteId: sallaItemSync.remoteId, status: sallaItemSync.status, diffFlags: sallaItemSync.diffFlags, attempts: sallaItemSync.attempts, syncedAt: sallaItemSync.updatedAt }).from(items).leftJoin(itemCategories, eq(itemCategories.id, items.categoryId)).leftJoin(sallaItemSync, and(eq(sallaItemSync.tenantId, tenantId), eq(sallaItemSync.itemId, items.id))).where(and(eq(items.tenantId, tenantId), isNull(items.deletedAt))).orderBy(items.nameAr).limit(500)) }; }

  /** Orders arrive as webhooks and land as sales invoices tagged `salla`. */
  async listOrders(tenantId: string) { await this.ensureEnabled(tenantId); return { data: await withTenantTx(this.database.db, tenantId, (tx) => tx.select({ id: salesInvoices.id, number: salesInvoices.number, status: salesInvoices.status, customer: salesInvoices.cashCustomerName, mobile: salesInvoices.cashCustomerMobile, total: salesInvoices.total, paymentStatus: salesInvoices.paymentStatus, createdAt: salesInvoices.createdAt, branchId: salesInvoices.branchId }).from(salesInvoices).where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.orderType, 'salla'))).orderBy(desc(salesInvoices.createdAt)).limit(200)) }; }

  async logs(tenantId: string) { await this.ensureEnabled(tenantId); return { data: await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(sallaExportLog).where(eq(sallaExportLog.tenantId, tenantId)).orderBy(desc(sallaExportLog.createdAt)).limit(100)) }; }
  /**
   * AUD-04 — الويب هوك العامّ: لا رمز مستخدم ولا سياق مستأجر، والمستأجر يُشتقّ من سجلّ
   * الاتصال لا من جسم الطلب. الخطوات بالترتيب:
   *
   *   1. قراءة صفوف الاتصال النشطة بـ`storeId` داخل بمعاملة **المنصّة** (سياسة 0114)، لأن
   *      الطلب العام لا يحمل `app.tenant_id`؛
   *   2. التحقّق من HMAC على البايتات الخام (`req.rawBody`) لكل مرشّح — والسرّ يُفكّ من صفّ
   *      الاتصال نفسه؛
   *   3. صفر مطابق ⇒ 401، وأكثر من مطابق (متجرٌ مرتبط بأكثر من منشأة) ⇒ 409 بلا كتابة؛
   *   4. بعد ذلك فقط تُعالَج الطلبية داخل معاملة المستأجر المستخرج.
   */
  async webhook(
    storeId: string,
    rawBody: string | Buffer,
    signature: string | undefined,
    body: { event?: string; data?: { customer?: { name?: string; mobile?: string }; items?: Array<{ name?: string; quantity?: string; amount?: string }>; branchId?: string } },
  ) {
    const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

    const candidates = await withPlatformAdminTx(this.database.db, (tx) =>
      tx
        .select({ id: sallaConnections.id, tenantId: sallaConnections.tenantId, webhookSecretEnc: sallaConnections.webhookSecretEnc })
        .from(sallaConnections)
        .where(and(eq(sallaConnections.storeId, storeId), eq(sallaConnections.status, 'active'), isNull(sallaConnections.deletedAt))),
    );
    if (candidates.length === 0) throw new DomainError('SALLA_CONNECTION_NOT_FOUND', 'Salla connection not found', 404);
    if (typeof signature !== 'string' || signature.length === 0) throw new DomainError('SALLA_WEBHOOK_SIGNATURE_INVALID', 'Missing Salla webhook signature', 401);

    const verified = candidates.filter((connection) => verifySallaSignature(payload, signature, decryptSallaSecret(connection.webhookSecretEnc)));
    if (verified.length === 0) throw new DomainError('SALLA_WEBHOOK_SIGNATURE_INVALID', 'Invalid Salla webhook signature', 401);
    if (verified.length > 1) throw new DomainError('SALLA_STORE_AMBIGUOUS', 'This Salla store id is linked to more than one tenant', 409);

    const tenantId = verified[0]!.tenantId;
    // AUD-14 — توقيعٌ صحيحٌ وحيد هو ما يثبت المستأجر: يُنسب إليه سجلّ التدقيق.
    setAuditTenantId(tenantId);
    await this.ensureEnabled(tenantId);

    if (body.event !== 'order.created') return { ignored: true };
    const lines = (body.data?.items?.length ? body.data.items : [{ name: 'Salla order', quantity: '1', amount: '0' }]).map((line) => ({ description: line.name ?? 'Salla item', quantity: line.quantity ?? '1', unitPrice: line.amount ?? '0', taxRate: '0' }));
    const branchId = body.data?.branchId;
    if (!branchId) throw new DomainError('SALLA_BRANCH_REQUIRED', 'Webhook payload must resolve a branch', 422);
    const invoice = await this.sales.create(tenantId, { branchId, cashCustomerName: body.data?.customer?.name ?? 'Salla customer', cashCustomerMobile: body.data?.customer?.mobile, kind: 'sale', orderType: 'salla', lines });
    return { data: { invoiceId: invoice.id } };
  }

  private mask(row: typeof sallaConnections.$inferSelect | undefined) { if (!row) return row; return { ...row, accessTokenEnc: undefined, refreshTokenEnc: undefined, webhookSecretEnc: undefined, accessTokenMasked: '****', refreshTokenMasked: row.refreshTokenEnc ? '****' : null, webhookSecretMasked: '****' }; }
}
