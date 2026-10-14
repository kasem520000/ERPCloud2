import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  DomainError,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOK_TEST_EVENT,
  apiKeyScopes,
  developerAuditActions,
  errorCodes,
  webhookEvents,
  parseFilters,
  parseSort,
  type ApiKeyCreate,
  type ApiKeyCreated,
  type ApiKeyRevoke,
  type ApiKeyRotate,
  type ApiKeyIdentity,
  type DeveloperCatalogue,
  type ApiKeyInvoiceSample,
  type ApiKeyRow,
  type ApiKeyScope,
  type ListEnvelope,
  type WebhookAttempt,
  type WebhookDeliveryQuery,
  type WebhookDeliveryRow,
  type WebhookEndpointCreate,
  type WebhookEndpointCreated,
  type WebhookEndpointQuery,
  type WebhookEndpointRow,
  type WebhookEndpointUpdate,
  type WebhookEvent,
} from '@erp/contracts';
import {
  apiKeyUses,
  apiKeys,
  salesInvoices,
  tenants,
  users,
  webhookDeliveries,
  webhookEndpoints,
  withPlatformAdminTx,
  withTenantTx,
  type DatabaseHandle,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { AuditService } from '../platform-services/audit/audit.service.js';
import { openSecret, sealSecret } from '../platform/auth/secret-box.js';

import {
  formatSignatureHeader,
  generateApiKey,
  hashApiKey,
  hashesMatch,
  looksLikeApiKey,
  permissionsForScopes,
  prefixOf,
  signWebhookPayload,
} from './api-key.js';

/**
 * P-C11 — بوابة المطوّر: مفاتيح الـAPI والويب هوكس.
 *
 * أربع قواعد تحكم هذا الملف:
 *
 *   1. **المفتاح يُعرض مرّةً واحدة.** `create` و`rotate` يعيدان `secret` وحدهما؛ وما بعدهما
 *      لا مكان في القاعدة يعيده (المحفوظ `prefix` و`hash`). ومن نسي مفتاحه يدوّره.
 *   2. **الإبطال وسمٌ لا حذف.** `revoke` يكتب `revoked_at` وسبباً ⇒ يبقى في السجلّ «من أبطل
 *      ومتى ولماذا». ولا DELETE على `api_keys` أصلاً (منعٌ في الترحيل).
 *   3. **التسليم يُقاس بأرقامه.** كل محاولة تكتب رمز الاستجابة والزمن والخطأ؛ والحكم
 *      (`delivered`/`failed`) يكتبه المُرسِل الفعلي. و`dispatch` **لا يرمي أبداً**: الويب هوك
 *      التزامٌ لا يجب أن يُسقط عملية العميل التي أنتجته.
 *   4. **الحمولة لا تُعرض في اللوحة.** السجلّ يقول `payloadKeys` وحجمها — نفس قرار شبكة
 *      المهام في P-C9: المشغّل يحتاج أن يعرف أن الحدث ذهب، لا أن يقرأ بيانات العميل.
 */
@Injectable()
export class DeveloperService {
  private readonly logger = new Logger(DeveloperService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // مفاتيح الـAPI
  // ───────────────────────────────────────────────────────────────────────────

  async listKeys(tenantId: string): Promise<ListEnvelope<ApiKeyRow>> {
    const rows = await withPlatformAdminTx(this.database.db, async (tx) => {
      return tx.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId)).orderBy(desc(apiKeys.createdAt));
    });

    const ids = rows.map((row) => row.id);
    const uses = new Map<string, number>();
    const labels = await this.actorLabels(rows.map((row) => row.createdBy).filter(Boolean) as string[]);

    if (ids.length > 0) {
      await withPlatformAdminTx(this.database.db, async (tx) => {
        const counted = await tx
          .select({ keyId: apiKeyUses.apiKeyId, total: count() })
          .from(apiKeyUses)
          .where(inArray(apiKeyUses.apiKeyId, ids))
          .groupBy(apiKeyUses.apiKeyId);
        for (const row of counted) uses.set(row.keyId, Number(row.total));
      });
    }

    return {
      data: rows.map((row) => this.toKeyRow(row, uses.get(row.id) ?? 0, labels.get(row.createdBy ?? '') ?? null)),
      meta: { total: rows.length, limit: rows.length, offset: 0 },
    };
  }

  async createKey(tenantId: string, input: ApiKeyCreate, actorUserId: string): Promise<ApiKeyCreated> {
    await this.assertTenant(tenantId);
    const generated = generateApiKey();
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const row = await withPlatformAdminTx(this.database.db, async (tx) => {
      const [created] = await tx
        .insert(apiKeys)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          name: input.name,
          keyPrefix: generated.prefix,
          keyHash: generated.hash,
          scopes: [...input.scopes],
          status: 'active',
          expiresAt,
          createdBy: actorUserId,
        })
        .returning();
      return created!;
    });

    await this.audit.record({
      tenantId,
      actorUserId,
      action: developerAuditActions.apiKeyCreate,
      entity: 'api_keys',
      entityId: row.id,
      after: { name: row.name, prefix: row.keyPrefix, scopes: row.scopes, expiresAt: expiresAt?.toISOString() ?? null },
    });

    const labels = await this.actorLabels([actorUserId]);
    return {
      ...this.toKeyRow(row, 0, labels.get(actorUserId) ?? null),
      // النصّ الصريح هنا وحده — آخر مكانٍ يظهر فيه.
      secret: generated.secret,
    };
  }

  async rotateKey(tenantId: string, keyId: string, input: ApiKeyRotate, actorUserId: string): Promise<ApiKeyCreated> {
    const existing = await this.loadKey(tenantId, keyId);
    // المفتاح المُبطَل لا يُدوَّر (لا معنى لتدوير ما لا يعمل)، والمنتهي يُدوَّر ليعود حيّاً.
    if (existing.status === 'revoked') {
      throw new DomainError(errorCodes.INVALID_STATE, 'A revoked API key cannot be rotated', 409, { keyId });
    }

    const generated = generateApiKey();
    const now = new Date();
    const row = await withPlatformAdminTx(this.database.db, async (tx) => {
      await tx
        .update(apiKeys)
        .set({ status: 'revoked', revokedAt: now, revokedReason: input.reason ?? 'rotated' })
        .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)));
      const [created] = await tx
        .insert(apiKeys)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          name: existing.name,
          keyPrefix: generated.prefix,
          keyHash: generated.hash,
          scopes: existing.scopes,
          status: 'active',
          expiresAt: existing.expiresAt,
          createdBy: actorUserId,
          rotatedFrom: keyId,
        })
        .returning();
      return created!;
    });

    await this.audit.record({
      tenantId,
      actorUserId,
      action: developerAuditActions.apiKeyRotate,
      entity: 'api_keys',
      entityId: row.id,
      before: { rotatedFrom: keyId, prefix: existing.keyPrefix },
      after: { prefix: row.keyPrefix, reason: input.reason ?? null },
    });

    const labels = await this.actorLabels([actorUserId]);
    return { ...this.toKeyRow(row, 0, labels.get(actorUserId) ?? null), secret: generated.secret };
  }

  async revokeKey(tenantId: string, keyId: string, input: ApiKeyRevoke, actorUserId: string): Promise<ApiKeyRow> {
    const existing = await this.loadKey(tenantId, keyId);
    if (existing.status === 'revoked') {
      throw new DomainError(errorCodes.INVALID_STATE, 'This API key is already revoked', 409, { keyId });
    }

    const [row] = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx
        .update(apiKeys)
        .set({ status: 'revoked', revokedAt: new Date(), revokedReason: input.reason })
        .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
        .returning(),
    );

    await this.audit.record({
      tenantId,
      actorUserId,
      action: developerAuditActions.apiKeyRevoke,
      entity: 'api_keys',
      entityId: keyId,
      before: { prefix: existing.keyPrefix, status: 'active' },
      after: { status: 'revoked', reason: input.reason },
    });

    const labels = await this.actorLabels([row!.createdBy ?? '']);
    return this.toKeyRow(row!, 0, labels.get(row!.createdBy ?? '') ?? null);
  }

  /**
   * التحقّق من مفتاحٍ قادم في ترويسة `Authorization`.
   *
   * يُقرأ بـ`prefix` (فهرسٌ فريد) ثم تُقارن البصمة بزمنٍ ثابت. ويعيد `null` لأي سبب:
   * مفتاحٌ غير موجود، أو مُبطَل، أو منتهٍ — لأن التفريق بينها في الردّ يخبر المهاجم أن
   * المفتاح «كان صحيحاً مرّة». ويُسجَّل الاستخدام في `api_key_uses` (ويُحدَّث `last_used_at`).
   */
  async verifyKey(
    secret: string,
    use: { method: string; path: string; ip?: string | null } = { method: 'GET', path: '/' },
  ): Promise<{ keyId: string; tenantId: string; scopes: ApiKeyScope[]; permissions: string[] } | null> {
    if (!looksLikeApiKey(secret)) return null;
    const prefix = prefixOf(secret);
    const hash = hashApiKey(secret);

    const row = await withPlatformAdminTx(this.database.db, async (tx) => {
      const [found] = await tx.select().from(apiKeys).where(eq(apiKeys.keyPrefix, prefix)).limit(1);
      return found;
    });

    if (!row || !hashesMatch(row.keyHash, hash)) return null;
    if (row.status !== 'active') return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

    const scopes = row.scopes as ApiKeyScope[];
    await withPlatformAdminTx(this.database.db, async (tx) => {
      await tx.insert(apiKeyUses).values({
        apiKeyId: row.id,
        tenantId: row.tenantId,
        method: use.method.slice(0, 10),
        path: use.path.slice(0, 200),
        ip: use.ip ?? null,
      });
      await tx.update(apiKeys).set({ lastUsedAt: new Date(), lastUsedIp: use.ip ?? null }).where(eq(apiKeys.id, row.id));
    });

    return { keyId: row.id, tenantId: row.tenantId, scopes, permissions: permissionsForScopes(scopes) };
  }

  /**
   * كتالوج البوابة — النطاقات والأحداث وصيغة التوقيع وسلّم إعادة المحاولة.
   * يُقرأ من العقود ومن هذا الملف (لا من الشاشة)، فيرى المشغّل ما سيُنفَّذ فعلاً.
   */
  catalogue(): DeveloperCatalogue {
    return {
      scopes: [...apiKeyScopes],
      events: [...webhookEvents],
      testEvent: WEBHOOK_TEST_EVENT,
      signature: {
        header: WEBHOOK_SIGNATURE_HEADER,
        algorithm: 'HMAC-SHA256 over "<timestamp>.<body>", hex, sent as t=<seconds>,v1=<hex>',
        toleranceSeconds: WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      },
      retryBackoffSeconds: [1, 2, 3].map((attempt) => backoffSeconds(attempt)),
    };
  }

  /**
   * هويّة المفتاح كما يراها حاملُه (`GET /integration/v1/me`).
   *
   * وتُقرأ من نفس صفّ المفتاح الذي مرّ منه التحقّق — لا من سياق الطلب — لأن المطلوب أن
   * يرى المطوّر ما تراه القاعدة: النطاقات المخزَّنة فعلاً، وآخر استعمالٍ سُجّل.
   */
  async identity(tenantId: string, keyId: string): Promise<ApiKeyIdentity> {
    const row = await this.loadKey(tenantId, keyId);
    const [tenant] = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx.select({ code: tenants.code, name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    );
    const scopes = row.scopes as ApiKeyScope[];
    return {
      keyId: row.id,
      tenantId,
      tenantCode: tenant?.code ?? '',
      tenantName: tenant?.name ?? '',
      name: row.name,
      prefix: row.keyPrefix,
      scopes,
      permissions: permissionsForScopes(scopes),
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * عيّنة قراءة لصاحب نطاق `invoices:read`.
   *
   * تُقرأ بـ`withTenantTx` لا بـ`withPlatformAdminTx`: الطلب طلبُ عميل، فيجب أن يمرّ على
   * سياسة العزل نفسها — وهذا هو الاختبار الحقيقي للنطاق («لا يرى إلا فواتير منشأته»).
   */
  async invoiceSample(tenantId: string, limit: number): Promise<ApiKeyInvoiceSample[]> {
    const take = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 10, 1), 50);
    const rows = await withTenantTx(this.database.db, tenantId, async (tx) =>
      tx
        .select({
          id: salesInvoices.id,
          number: salesInvoices.number,
          status: salesInvoices.status,
          paymentStatus: salesInvoices.paymentStatus,
          total: salesInvoices.total,
          currency: salesInvoices.currency,
          postedAt: salesInvoices.postedAt,
          createdAt: salesInvoices.createdAt,
        })
        .from(salesInvoices)
        .where(eq(salesInvoices.tenantId, tenantId))
        .orderBy(desc(salesInvoices.createdAt))
        .limit(take),
    );
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      paymentStatus: row.paymentStatus,
      total: String(row.total),
      currency: row.currency,
      postedAt: row.postedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // الويب هوكس
  // ───────────────────────────────────────────────────────────────────────────

  async listEndpoints(query: WebhookEndpointQuery): Promise<ListEnvelope<WebhookEndpointRow>> {
    const filters = parseFilters(query.filter, ['tenantId', 'status', 'event'] as const);
    const [sort] = parseSort(query.sort, ['createdAt', 'url'] as const);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const rows = await withPlatformAdminTx(this.database.db, async (tx) => {
      const conditions = [];
      if (filters.tenantId) conditions.push(eq(webhookEndpoints.tenantId, filters.tenantId));
      if (filters.status) conditions.push(eq(webhookEndpoints.status, filters.status));
      // الاشتراك في حدثٍ ما: `= ANY(events)` — يُقرأ من الفهرس الجزئي بعد فلترة الحالة.
      if (filters.event) conditions.push(sql`${filters.event} = ANY(${webhookEndpoints.events})`);
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // `matched` لا `total`: عدّادُ الصفوف ليس مبلغاً، واسمٌ يقول ما هو يمنع قراءته خطأً.
      const [items, matched] = await Promise.all([
        tx
          .select()
          .from(webhookEndpoints)
          .where(where)
          .orderBy(
            sort
              ? sort.direction === 'asc'
                ? asc(sort.column === 'url' ? webhookEndpoints.url : webhookEndpoints.createdAt)
                : desc(sort.column === 'url' ? webhookEndpoints.url : webhookEndpoints.createdAt)
              : desc(webhookEndpoints.createdAt),
          )
          .limit(limit)
          .offset(offset),
        tx.select({ total: count() }).from(webhookEndpoints).where(where),
      ]);
      return { items, total: Number(matched[0]?.total ?? 0) };
    });

    const stats = await this.endpointStats(rows.items.map((row) => row.id));
    const labels = await this.actorLabels(rows.items.map((row) => row.createdBy).filter(Boolean) as string[]);

    return {
      data: rows.items.map((row) =>
        this.toEndpointRow(row, stats.get(row.id), labels.get(row.createdBy ?? '') ?? null),
      ),
      meta: { total: rows.total, limit, offset },
    };
  }

  async createEndpoint(
    tenantId: string,
    input: WebhookEndpointCreate,
    actorUserId: string,
  ): Promise<WebhookEndpointCreated> {
    await this.assertTenant(tenantId);
    // السرّ يُولَّد هنا ويُخزَّن **مشفَّراً**: يجب أن يُقرأ لحظة التوقيع، بخلاف مفتاح الـAPI.
    const secret = `whsec_${crypto.randomUUID().replace(/-/g, '')}`;
    const row = await withPlatformAdminTx(this.database.db, async (tx) => {
      const [created] = await tx
        .insert(webhookEndpoints)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          url: input.url,
          events: [...input.events],
          status: 'active',
          secretPrefix: secret.slice(0, 14),
          secretEnc: sealSecret(secret),
          description: input.description ?? null,
          createdBy: actorUserId,
        })
        .returning();
      return created!;
    });

    await this.audit.record({
      tenantId,
      actorUserId,
      action: developerAuditActions.webhookCreate,
      entity: 'webhook_endpoints',
      entityId: row.id,
      after: { url: row.url, events: row.events, secretPrefix: row.secretPrefix },
    });

    const labels = await this.actorLabels([actorUserId]);
    return { ...this.toEndpointRow(row, undefined, labels.get(actorUserId) ?? null), secret };
  }

  async updateEndpoint(
    endpointId: string,
    input: WebhookEndpointUpdate,
    actorUserId: string,
  ): Promise<WebhookEndpointRow> {
    const existing = await this.loadEndpoint(endpointId);
    const [row] = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx
        .update(webhookEndpoints)
        .set({
          ...(input.events ? { events: [...input.events] } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          updatedAt: new Date(),
        })
        .where(eq(webhookEndpoints.id, endpointId))
        .returning(),
    );

    await this.audit.record({
      tenantId: existing.tenantId,
      actorUserId,
      action: developerAuditActions.webhookUpdate,
      entity: 'webhook_endpoints',
      entityId: endpointId,
      before: { events: existing.events, status: existing.status, description: existing.description },
      after: { events: row!.events, status: row!.status, description: row!.description },
    });

    const labels = await this.actorLabels([row!.createdBy ?? '']);
    return this.toEndpointRow(row!, undefined, labels.get(row!.createdBy ?? '') ?? null);
  }

  /** الحذف نهائيٌّ بقراره: العنوان صار «لا أريد هذا التكامل» — فلا معنى لإيصالاتِ لا مستلِمَ لها. */
  async deleteEndpoint(endpointId: string, actorUserId: string): Promise<{ id: string }> {
    const existing = await this.loadEndpoint(endpointId);
    await withPlatformAdminTx(this.database.db, async (tx) => {
      await tx.delete(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId));
    });
    await this.audit.record({
      tenantId: existing.tenantId,
      actorUserId,
      action: developerAuditActions.webhookDelete,
      entity: 'webhook_endpoints',
      entityId: endpointId,
      before: { url: existing.url, events: existing.events },
    });
    return { id: endpointId };
  }

  async listDeliveries(endpointId: string, query: WebhookDeliveryQuery): Promise<ListEnvelope<WebhookDeliveryRow>> {
    await this.loadEndpoint(endpointId);
    const filters = parseFilters(query.filter, ['status', 'event'] as const);
    const [sort] = parseSort(query.sort, ['createdAt', 'status'] as const);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const rows = await withPlatformAdminTx(this.database.db, async (tx) => {
      const conditions = [eq(webhookDeliveries.endpointId, endpointId)];
      if (filters.status) conditions.push(eq(webhookDeliveries.status, filters.status));
      if (filters.event) conditions.push(eq(webhookDeliveries.event, filters.event));
      const where = and(...conditions);

      const [items, matched] = await Promise.all([
        tx
          .select()
          .from(webhookDeliveries)
          .where(where)
          .orderBy(
            sort
              ? sort.direction === 'asc'
                ? asc(sort.column === 'status' ? webhookDeliveries.status : webhookDeliveries.createdAt)
                : desc(sort.column === 'status' ? webhookDeliveries.status : webhookDeliveries.createdAt)
              : desc(webhookDeliveries.createdAt),
          )
          .limit(limit)
          .offset(offset),
        tx.select({ total: count() }).from(webhookDeliveries).where(where),
      ]);
      return { items, total: Number(matched[0]?.total ?? 0) };
    });

    return {
      data: rows.items.map((row) => this.toDeliveryRow(row)),
      meta: { total: rows.total, limit, offset },
    };
  }

  /** إعادة إرسال تسليمٍ فشل — بيد المشغّل، وبسببٍ يبقى في التدقيق. */
  async retryDelivery(endpointId: string, deliveryId: string, actorUserId: string): Promise<WebhookAttempt> {
    const endpoint = await this.loadEndpoint(endpointId);
    const [delivery] = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.endpointId, endpointId), eq(webhookDeliveries.id, deliveryId)))
        .limit(1),
    );
    if (!delivery) throw new DomainError(errorCodes.NOT_FOUND, 'No such delivery for this endpoint', 404, { deliveryId });
    if (delivery.status === 'delivered') {
      throw new DomainError(errorCodes.INVALID_STATE, 'This delivery has already succeeded', 409, { deliveryId });
    }

    await this.audit.record({
      tenantId: endpoint.tenantId,
      actorUserId,
      action: developerAuditActions.webhookRetry,
      entity: 'webhook_deliveries',
      entityId: deliveryId,
      after: { event: delivery.event, attempts: delivery.attempts },
    });

    return this.deliver(deliveryId);
  }

  /** حدثُ الاختبار: نفس المسار الحقيقي (توقيعٌ وتنفيذٌ وقياس) لا زرٌّ يوهم بالسلامة. */
  async sendTest(endpointId: string, actorUserId: string): Promise<WebhookAttempt> {
    const endpoint = await this.loadEndpoint(endpointId);
    const deliveryId = await withPlatformAdminTx(this.database.db, async (tx) => {
      const [row] = await tx
        .insert(webhookDeliveries)
        .values({
          id: crypto.randomUUID(),
          endpointId,
          tenantId: endpoint.tenantId,
          event: WEBHOOK_TEST_EVENT,
          // الحمولة تحمل اسم الحدث ومنشأته كما تفعل حمولات الأحداث الحقيقية: المستلم يقود
          // منطقه من الجسم لا من ترويسةٍ قد تُهمَل عند الوسيط.
          payload: { event: WEBHOOK_TEST_EVENT, tenantId: endpoint.tenantId, endpointId, at: new Date().toISOString(), via: 'console' },
          status: 'pending',
          maxAttempts: 1,
        })
        .returning();
      return row!.id;
    });

    await this.audit.record({
      tenantId: endpoint.tenantId,
      actorUserId,
      action: developerAuditActions.webhookTest,
      entity: 'webhook_deliveries',
      entityId: deliveryId,
      after: { url: endpoint.url },
    });

    return this.deliver(deliveryId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // الإرسال
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * نشر حدثٍ إلى عناوين المستأجر المشترِكة.
   *
   * **ولا يرمي أبداً**: يُستدعى من مسارات العميل (فاتورةٌ صُدِّرت، ورديةٌ أُغلقت) فلو رمى
   * لأسقط العملية التي أنتجته. والفشل يُكتب في صفّ التسليم ويُقرأ من الشاشة.
   */
  async dispatch(event: WebhookEvent, tenantId: string, payload: Record<string, unknown>): Promise<number> {
    try {
      const endpoints = await withPlatformAdminTx(this.database.db, async (tx) =>
        tx
          .select({ id: webhookEndpoints.id, url: webhookEndpoints.url })
          .from(webhookEndpoints)
          .where(
            and(
              eq(webhookEndpoints.tenantId, tenantId),
              eq(webhookEndpoints.status, 'active'),
              sql`${event} = ANY(${webhookEndpoints.events})`,
            ),
          ),
      );
      if (endpoints.length === 0) return 0;

      const ids = await withPlatformAdminTx(this.database.db, async (tx) => {
        const rows = await tx
          .insert(webhookDeliveries)
          .values(
            endpoints.map((endpoint) => ({
              id: crypto.randomUUID(),
              endpointId: endpoint.id,
              tenantId,
              event,
              payload: { ...payload, event, tenantId },
              status: 'pending',
            })),
          )
          .returning({ id: webhookDeliveries.id });
        return rows.map((row) => row.id);
      });

      // المحاولة الأولى فوراً وفي نفس الطلب (كالبريد `inline`): الطابور شبكة أمان، لا شرط
      // خروج — فمن يعمل بلا عاملٍ (`WORKER=0`) لا تبقى أحداثه معلّقة بلا إرسال.
      for (const id of ids) {
        await this.deliver(id).catch(() => undefined);
      }
      return ids.length;
    } catch (error) {
      this.logger.warn({ event, tenantId, err: (error as Error).message }, 'webhook dispatch failed');
      return 0;
    }
  }

  /**
   * تسليمٌ واحد: توقيع، ثم POST بمهلة 5 ثوان، ثم كتابة النتيجة.
   *
   * وسلّم التراجع 1د · 5د · 30د كما في البريد (P-C6) — والحكم `failed` بعد استنفاد
   * المحاولات، لا بعد أول خطأ: عنوانٌ تعطّل دقيقةً ليس عنواناً ميّتاً.
   */
  async deliver(deliveryId: string): Promise<WebhookAttempt> {
    const delivery = await withPlatformAdminTx(this.database.db, async (tx) => {
      const [row] = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
      return row;
    });
    if (!delivery) throw new DomainError(errorCodes.NOT_FOUND, 'No such delivery', 404, { deliveryId });

    const endpoint = await this.loadEndpoint(delivery.endpointId);
    const body = JSON.stringify(delivery.payload);
    const at = Math.floor(Date.now() / 1000);
    const secret = openSecret(endpoint.secretEnc).toString('utf8');
    const signature = signWebhookPayload(secret, body, at);
    const attempt = delivery.attempts + 1;
    const startedAt = Date.now();

    let responseCode: number | null = null;
    let responseBody: string | null = null;
    let error: string | null = null;
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'erp-webhooks/1',
          'x-erp-event': delivery.event,
          'x-erp-delivery': delivery.id,
          'x-erp-attempt': String(attempt),
          'x-erp-tenant': delivery.tenantId,
          'x-erp-signature': formatSignatureHeader(at, signature),
        },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      responseCode = response.status;
      responseBody = (await response.text().catch(() => '')).slice(0, 500) || null;
      if (!response.ok) error = `The endpoint answered ${response.status}`;
    } catch (caught) {
      error = (caught as Error).message.slice(0, 300);
    }

    const durationMs = Date.now() - startedAt;
    const succeeded = responseCode !== null && responseCode >= 200 && responseCode < 300;
    const exhausted = attempt >= delivery.maxAttempts;
    const nextAttemptAt = succeeded || exhausted ? null : new Date(Date.now() + backoffSeconds(attempt) * 1000);

    const [updated] = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx
        .update(webhookDeliveries)
        .set({
          status: succeeded ? 'delivered' : exhausted ? 'failed' : 'pending',
          attempts: attempt,
          responseCode,
          responseBody,
          durationMs,
          error,
          nextAttemptAt,
          deliveredAt: succeeded ? new Date() : null,
        })
        .where(eq(webhookDeliveries.id, deliveryId))
        .returning(),
    );

    if (!succeeded) {
      this.logger.warn(
        { deliveryId, url: endpoint.url, responseCode, error },
        'webhook delivery attempt failed',
      );
    }

    return this.toAttempt(updated!);
  }

  /**
   * مسحُ المعلَّق: شبكةُ أمانٍ لمن لا عامل له، وحدودُه صريحة (دفعة ≤ 20، وموعدٌ حلّ).
   * يُستدعى من قائمة التسليمات في اللوحة، فلا يبقى صفٌّ منتظرٌ إلى الأبد بلا مُرسِل.
   */
  async scanPending(limit = 20): Promise<number> {
    const due = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.status, 'pending'),
            or(isNull(webhookDeliveries.nextAttemptAt), lt(webhookDeliveries.nextAttemptAt, new Date())),
            lt(webhookDeliveries.attempts, webhookDeliveries.maxAttempts),
          ),
        )
        .orderBy(webhookDeliveries.createdAt)
        .limit(limit),
    );

    let delivered = 0;
    for (const row of due) {
      const attempt = await this.deliver(row.id).catch(() => null);
      if (attempt?.status === 'delivered') delivered += 1;
    }
    return delivered;
  }

  /** يُستدعى من `sendTest`/`deliver` ليعرف الرمز والسرّ قبل الإرسال. */
  private async loadEndpoint(endpointId: string) {
    const [row] = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId)).limit(1),
    );
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'No such webhook endpoint', 404, { endpointId });
    return row;
  }

  private async loadKey(tenantId: string, keyId: string) {
    const [row] = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx.select().from(apiKeys).where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId))).limit(1),
    );
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'No such API key', 404, { keyId });
    return row;
  }

  private async assertTenant(tenantId: string): Promise<void> {
    const exists = await withPlatformAdminTx(this.database.db, async (tx) => {
      const [row] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      return Boolean(row);
    });
    if (!exists) throw new DomainError(errorCodes.NOT_FOUND, 'No such tenant', 404, { tenantId });
  }

  private async actorLabels(userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx.select({ id: users.id, email: users.email, fullName: users.fullName }).from(users).where(inArray(users.id, unique)),
    );
    return new Map(rows.map((row) => [row.id, row.fullName ?? row.email]));
  }

  private async endpointStats(endpointIds: string[]) {
    const stats = new Map<
      string,
      { delivered: number; failed: number; pending: number; lastDeliveryAt: Date | null; lastResponseCode: number | null; lastError: string | null }
    >();
    if (endpointIds.length === 0) return stats;

    await withPlatformAdminTx(this.database.db, async (tx) => {
      const grouped = await tx
        .select({ endpointId: webhookDeliveries.endpointId, status: webhookDeliveries.status, total: count() })
        .from(webhookDeliveries)
        .where(inArray(webhookDeliveries.endpointId, endpointIds))
        .groupBy(webhookDeliveries.endpointId, webhookDeliveries.status);
      for (const row of grouped) {
        const entry = stats.get(row.endpointId) ?? {
          delivered: 0,
          failed: 0,
          pending: 0,
          lastDeliveryAt: null,
          lastResponseCode: null,
          lastError: null,
        };
        if (row.status === 'delivered') entry.delivered = Number(row.total);
        if (row.status === 'failed') entry.failed = Number(row.total);
        if (row.status === 'pending') entry.pending = Number(row.total);
        stats.set(row.endpointId, entry);
      }

      const last = await tx
        .select({
          endpointId: webhookDeliveries.endpointId,
          createdAt: webhookDeliveries.createdAt,
          responseCode: webhookDeliveries.responseCode,
          error: webhookDeliveries.error,
          attempts: webhookDeliveries.attempts,
        })
        .from(webhookDeliveries)
        .where(inArray(webhookDeliveries.endpointId, endpointIds))
        .orderBy(desc(webhookDeliveries.createdAt));
      for (const row of last) {
        const entry = stats.get(row.endpointId);
        if (entry && entry.lastDeliveryAt === null) {
          entry.lastDeliveryAt = row.createdAt;
          entry.lastResponseCode = row.responseCode;
          entry.lastError = row.error;
        }
      }
    });
    return stats;
  }

  private toKeyRow(
    row: typeof apiKeys.$inferSelect,
    uses: number,
    createdByLabel: string | null,
  ): ApiKeyRow {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      prefix: row.keyPrefix,
      scopes: row.scopes as ApiKeyScope[],
      status: row.status as ApiKeyRow['status'],
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      lastUsedIp: row.lastUsedIp,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      revokedReason: row.revokedReason,
      createdBy: row.createdBy,
      createdByLabel,
      createdAt: row.createdAt.toISOString(),
      uses,
    };
  }

  private toEndpointRow(
    row: typeof webhookEndpoints.$inferSelect,
    stats:
      | { delivered: number; failed: number; pending: number; lastDeliveryAt: Date | null; lastResponseCode: number | null; lastError: string | null }
      | undefined,
    createdByLabel: string | null,
  ): WebhookEndpointRow {
    return {
      id: row.id,
      tenantId: row.tenantId,
      url: row.url,
      events: row.events as WebhookEvent[],
      status: row.status as WebhookEndpointRow['status'],
      secretPrefix: row.secretPrefix,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
      createdByLabel,
      stats: {
        delivered: stats?.delivered ?? 0,
        failed: stats?.failed ?? 0,
        pending: stats?.pending ?? 0,
        lastDeliveryAt: stats?.lastDeliveryAt?.toISOString() ?? null,
        lastResponseCode: stats?.lastResponseCode ?? null,
        lastError: stats?.lastError ?? null,
      },
    };
  }

  private toDeliveryRow(row: typeof webhookDeliveries.$inferSelect): WebhookDeliveryRow {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const body = JSON.stringify(payload);
    return {
      id: row.id,
      endpointId: row.endpointId,
      tenantId: row.tenantId,
      event: row.event,
      status: row.status as WebhookDeliveryRow['status'],
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      responseCode: row.responseCode,
      responseBody: row.responseBody,
      durationMs: row.durationMs,
      error: row.error,
      nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      payloadKeys: Object.keys(payload).sort(),
      payloadBytes: Buffer.byteLength(body, 'utf8'),
    };
  }

  private toAttempt(row: typeof webhookDeliveries.$inferSelect): WebhookAttempt {
    return {
      deliveryId: row.id,
      event: row.event,
      status: row.status as WebhookAttempt['status'],
      responseCode: row.responseCode,
      durationMs: row.durationMs,
      error: row.error,
      attempts: row.attempts,
    };
  }
}

/** سلّم التراجع: 1د · 5د · 30د — ثم الحكم النهائي بعد استنفاد المحاولات. */
export function backoffSeconds(attempt: number): number {
  return [60, 300, 1800][Math.min(attempt - 1, 2)] ?? 1800;
}
