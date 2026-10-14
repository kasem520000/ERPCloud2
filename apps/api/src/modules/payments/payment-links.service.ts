import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import {
  cashLocations,
  memberships,
  parties,
  paymentLinks,
  paymentProviderConfigs,
  vouchers,
  withTenantTx,
  type DatabaseHandle,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { WhatsappService } from '../integrations/whatsapp/whatsapp.service.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';
import { NotificationsService } from '../platform-services/notifications/notifications.service.js';
import { MAILER, type MailerPort } from '../platform-services/notifications/mailer.js';
import { SalesService } from '../sales/sales.service.js';
import { TreasuryService } from '../treasury/treasury.service.js';
import { setAuditTenantId } from '../../request-context/request-context.js';

import { decryptGatewaySecret, encryptGatewaySecret } from './payments.service.js';
import {
  ONLINE_PROVIDERS,
  PROVIDER_LABELS,
  buildProviderCall,
  interpretWebhook,
  isOnlineProvider,
  money2,
  readProviderLink,
  redactWebhook,
  settlementDecision,
  simulatedLink,
  verifyHmacHex,
  verifySharedSecret,
  type NormalizedWebhook,
  type OnlineProvider,
} from './online-payments.js';

export type ProviderConfigInput = {
  provider: string;
  apiKey?: string;
  webhookSecret?: string;
  publishableKey?: string;
  isActive?: boolean;
  simulation?: boolean;
  currency?: string;
  cashLocationId?: string | null;
};

export type CreateLinkInput = {
  invoiceId?: string;
  invoice_id?: string;
  provider?: string;
  amount?: string;
};

type HeaderMap = Record<string, string | string[] | undefined>;

@Injectable()
export class PaymentLinksService {
  private readonly logger = new Logger(PaymentLinksService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sales: SalesService,
    private readonly treasury: TreasuryService,
    private readonly notifications: NotificationsService,
    private readonly whatsapp: WhatsappService,
    @Inject(MAILER) private readonly mailer: MailerPort,
  ) {}

  async listConfigs(tenantId: string) {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(paymentProviderConfigs).where(eq(paymentProviderConfigs.tenantId, tenantId)),
    );
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    return ONLINE_PROVIDERS.map((provider) => this.toConfig(provider, byProvider.get(provider)));
  }

  async saveConfig(tenantId: string, input: ProviderConfigInput) {
    const provider = this.provider(input.provider);
    const [existing] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(paymentProviderConfigs)
        .where(and(eq(paymentProviderConfigs.tenantId, tenantId), eq(paymentProviderConfigs.provider, provider)))
        .limit(1),
    );
    const values = {
      apiKeyEnc: input.apiKey?.trim() ? encryptGatewaySecret(input.apiKey.trim()) : existing?.apiKeyEnc ?? null,
      webhookSecretEnc: input.webhookSecret?.trim()
        ? encryptGatewaySecret(input.webhookSecret.trim())
        : existing?.webhookSecretEnc ?? null,
      publishableKey: input.publishableKey === undefined ? existing?.publishableKey ?? null : input.publishableKey.trim() || null,
      isActive: input.isActive ?? existing?.isActive ?? true,
      simulation: input.simulation ?? existing?.simulation ?? true,
      currency: (input.currency ?? existing?.currency ?? 'SAR').toUpperCase(),
      cashLocationId: input.cashLocationId === undefined ? existing?.cashLocationId ?? null : input.cashLocationId,
      updatedAt: new Date(),
    };
    if (!existing) {
      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx.insert(paymentProviderConfigs).values({ id: newId(), tenantId, provider, ...values }),
      );
    } else {
      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(paymentProviderConfigs)
          .set(values)
          .where(and(eq(paymentProviderConfigs.tenantId, tenantId), eq(paymentProviderConfigs.provider, provider))),
      );
    }
    const [saved] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(paymentProviderConfigs)
        .where(and(eq(paymentProviderConfigs.tenantId, tenantId), eq(paymentProviderConfigs.provider, provider)))
        .limit(1),
    );
    return this.toConfig(provider, saved);
  }

  async listLinks(tenantId: string, invoiceId?: string) {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(paymentLinks)
        .where(
          and(
            eq(paymentLinks.tenantId, tenantId),
            invoiceId ? eq(paymentLinks.invoiceId, invoiceId) : undefined,
          ),
        )
        .orderBy(desc(paymentLinks.createdAt)),
    );
    return rows.map(toLink);
  }

  async createLink(tenantId: string, input: CreateLinkInput) {
    const provider = this.provider(input.provider ?? 'moyasar');
    const invoiceId = input.invoiceId || input.invoice_id;
    if (!invoiceId) throw new DomainError(errorCodes.VALIDATION_FAILED, 'invoice_id is required', 422, { field: 'invoice_id' });
    const invoice = await this.sales.get(tenantId, invoiceId);
    if (invoice.status !== 'posted') {
      throw new DomainError('SALES_INVOICE_NOT_POSTED', 'لا يمكن إنشاء رابط دفع لفاتورة غير مرحّلة', 409);
    }
    const due = new Decimal(invoice.total).minus(invoice.paidTotal ?? '0');
    const requested = new Decimal(input.amount ?? due.toFixed(4));
    if (!requested.isFinite() || requested.lte(0)) throw new DomainError('PAYMENT_AMOUNT_INVALID', 'مبلغ الرابط يجب أن يكون أكبر من صفر', 422);
    if (requested.gt(due.plus('0.0001'))) throw new DomainError('PAYMENT_EXCEEDS_DUE', 'المبلغ أكبر من المتبقي على الفاتورة', 422);

    const config = await this.requireConfig(tenantId, provider);
    if (!config.isActive) throw new DomainError(errorCodes.INVALID_STATE, 'بوابة الدفع غير مفعّلة', 409);
    const id = newId();
    const currency = (invoice.currency || config.currency || 'SAR').toUpperCase();
    const callbackUrl = webhookUrl(provider, tenantId);
    const successUrl = portalPayUrl(invoiceId);
    const party = invoice.partyId ? await this.party(tenantId, invoice.partyId) : undefined;
    let created = simulatedLink(provider, id);
    let simulation = config.simulation;
    if (!simulation) {
      if (!config.apiKeyEnc) throw new DomainError(errorCodes.VALIDATION_FAILED, 'مفتاح البوابة مطلوب خارج وضع المحاكاة', 422);
      const call = buildProviderCall(
        {
          provider,
          amount: requested.toFixed(2),
          currency,
          description: `فاتورة ${invoice.number ?? invoiceId}`,
          paymentLinkId: id,
          invoiceId,
          tenantId,
          callbackUrl,
          successUrl,
          customerName: party?.name,
          customerEmail: party?.email ?? undefined,
          customerPhone: party?.phone ?? undefined,
          entityId: config.publishableKey ?? undefined,
        },
        decryptGatewaySecret(config.apiKeyEnc),
      );
      created = readProviderLink(provider, await this.postProvider(call));
      simulation = false;
    }
    const actor = tryGetAuthContext()?.userId ?? null;
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(paymentLinks)
        .values({
          id,
          tenantId,
          invoiceId,
          provider,
          amount: requested.toFixed(4),
          currency,
          linkUrl: created.url,
          externalId: created.externalId,
          status: 'pending',
          payload: { simulation, providerStatus: created.status },
          createdBy: actor,
        })
        .returning(),
    );
    return toLink(row!);
  }

  async sendLink(tenantId: string, id: string, input: { channel?: string; to?: string }) {
    const link = await this.requireLink(tenantId, id);
    const invoice = await this.sales.get(tenantId, link.invoiceId);
    const party = invoice.partyId ? await this.party(tenantId, invoice.partyId) : undefined;
    const channel = input.channel === 'email' ? 'email' : 'whatsapp';
    const message = `رابط دفع الفاتورة ${invoice.number ?? ''}: ${link.linkUrl}`;
    if (channel === 'email') {
      const to = input.to?.trim() || party?.email;
      if (!to) throw new DomainError(errorCodes.VALIDATION_FAILED, 'لا يوجد بريد للعميل', 422, { field: 'to' });
      await this.mailer.send({ to, subject: `رابط دفع فاتورة ${invoice.number ?? ''}`, text: message, tenantId });
      return { sent: true, channel, to };
    }
    const result = await this.whatsapp.send(tenantId, {
      invoiceId: link.invoiceId,
      to: input.to,
      message,
      attach: false,
    });
    return { sent: true, channel, message: result };
  }

  /**
   * Local stand-in for a provider webhook. Refused unless the tenant's provider is in
   * simulation, so a live key cannot be marked paid without the provider's secret.
   */
  async simulatePayment(tenantId: string, id: string) {
    const link = await this.requireLink(tenantId, id);
    const config = await this.requireConfig(tenantId, link.provider as OnlineProvider);
    if (!config.simulation) throw new DomainError(errorCodes.INVALID_STATE, 'المحاكاة متاحة فقط عندما تكون البوابة في وضع التجربة', 409);
    const event: NormalizedWebhook = {
      provider: link.provider as OnlineProvider,
      eventType: 'payment_paid',
      externalId: link.externalId ?? undefined,
      paymentId: `sim_pay_${id.replace(/-/g, '').slice(0, 12)}`,
      amount: money2(link.amount),
      currency: link.currency,
      outcome: 'paid',
      tenantId,
      paymentLinkId: id,
      invoiceId: link.invoiceId,
    };
    return this.applyEvent(tenantId, link.provider as OnlineProvider, event, { simulation: true });
  }

  async receiveWebhook(providerValue: string, body: Record<string, unknown>, headers: HeaderMap, tenantQuery?: string) {
    if (!isOnlineProvider(providerValue)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, `Unsupported payment provider '${providerValue}'`, 422);
    }
    const event = interpretWebhook(providerValue, body);
    const tenantId = event.tenantId || headerValue(headers, 'x-tenant-id') || tenantQuery?.trim();
    if (!tenantId) throw new DomainError(errorCodes.TENANT_CONTEXT_MISSING, 'Webhook is missing tenant_id', 400);
    const config = await this.requireConfig(tenantId, providerValue);
    const secret = config.webhookSecretEnc ? decryptGatewaySecret(config.webhookSecretEnc) : '';
    const presented = event.secretToken || headerValue(headers, 'x-webhook-secret') || headerValue(headers, 'x-moyasar-signature');
    const tokenOk = verifySharedSecret(presented, secret);
    const hmacOk = verifyHmacHex(JSON.stringify(redactWebhook(body)), headerValue(headers, 'hashstring'), secret);
    if (!tokenOk && !hmacOk) throw new DomainError('WEBHOOK_SIGNATURE_INVALID', 'Webhook secret did not match', 401);
    // AUD-14 — لا يُنسب الطلب إلا بعد أن أثبت السرّ أنه يخصّ هذا المستأجر.
    setAuditTenantId(tenantId);
    return this.applyEvent(tenantId, providerValue, event, redactWebhook(body));
  }

  private async applyEvent(tenantId: string, provider: OnlineProvider, event: NormalizedWebhook, payload: Record<string, unknown>) {
    const link = await this.findLink(tenantId, provider, event);
    const decision = settlementDecision(
      { amount: String(link.amount), currency: link.currency, status: link.status },
      event,
    );
    if (decision.action === 'ignore') return { accepted: true, status: link.status, ignored: decision.reason, link: toLink(link) };
    if (decision.action === 'reject') {
      await this.touch(tenantId, link.id, { lastError: decision.reason, lastEvent: payload });
      throw new DomainError('PAYMENT_AMOUNT_MISMATCH', `لا يمكن تسوية الرابط: ${decision.reason}`, 422);
    }
    if (decision.action === 'expire' || decision.action === 'fail') {
      const status = decision.action === 'expire' ? 'expired' : 'failed';
      const [updated] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(paymentLinks)
          .set({ status, payload: { ...(link.payload ?? {}), lastEvent: payload }, updatedAt: new Date() })
          .where(and(eq(paymentLinks.tenantId, tenantId), eq(paymentLinks.id, link.id), eq(paymentLinks.status, 'pending')))
          .returning(),
      );
      return { accepted: true, status, link: toLink(updated ?? link) };
    }

    const invoice = await this.sales.get(tenantId, link.invoiceId);
    if (invoice.status !== 'posted') throw new DomainError('SALES_INVOICE_NOT_POSTED', 'الفاتورة لم تعد قابلة للتحصيل', 409);
    const remaining = new Decimal(invoice.total).minus(invoice.paidTotal ?? '0');
    if (new Decimal(decision.amount).gt(remaining.plus('0.0001'))) {
      throw new DomainError('PAYMENT_EXCEEDS_DUE', 'المبلغ أكبر من المتبقي على الفاتورة', 422);
    }
    const cashLocationId = await this.cashLocation(tenantId, provider, invoice.branchId);
    const idempotencyKey = `online-pay:${provider}:${decision.paymentId}`;
    const voucher = await this.receipt(tenantId, {
      idempotencyKey,
      branchId: invoice.branchId,
      partyId: invoice.partyId,
      cashLocationId,
      amount: decision.amount,
      currency: decision.currency,
      invoiceId: invoice.id,
      description: `سند قبض رابط دفع ${PROVIDER_LABELS[provider]} فاتورة ${invoice.number ?? invoice.id}`,
      reference: decision.paymentId,
    });
    await this.sales.addPayment(tenantId, invoice.id, {
      method: 'card',
      amount: decision.amount,
      idempotencyKey,
      cashLocationId,
      reference: decision.paymentId,
    });
    const [updated] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(paymentLinks)
        .set({
          status: 'paid',
          paidAt: new Date(),
          voucherId: voucher.id,
          payload: { ...(link.payload ?? {}), paymentId: decision.paymentId, lastEvent: payload, voucherStatus: voucher.status },
          updatedAt: new Date(),
        })
        .where(and(eq(paymentLinks.tenantId, tenantId), eq(paymentLinks.id, link.id)))
        .returning(),
    );
    await this.notifyPaid(tenantId, updated ?? link, voucher.id, decision.amount);
    return { accepted: true, status: 'paid', voucherId: voucher.id, link: toLink(updated ?? link) };
  }

  private async receipt(
    tenantId: string,
    input: {
      idempotencyKey: string;
      branchId: string;
      partyId: string | null;
      cashLocationId: string;
      amount: string;
      currency: string;
      invoiceId: string;
      description: string;
      reference: string;
    },
  ) {
    const loadExisting = () =>
      withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .select()
          .from(vouchers)
          .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.idempotencyKey, input.idempotencyKey)))
          .limit(1),
      );
    let voucher = (await loadExisting())[0];
    if (!voucher) {
      try {
        voucher = await this.treasury.createVoucher(tenantId, {
          branchId: input.branchId,
          kind: 'receipt',
          subtype: 'customer',
          date: new Date().toISOString().slice(0, 10),
          partyId: input.partyId ?? undefined,
          cashLocationId: input.cashLocationId,
          method: 'card',
          amount: input.amount,
          netAmount: input.amount,
          currency: input.currency,
          description: input.description,
          referenceNo: input.reference,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        voucher = (await loadExisting())[0];
        if (!voucher) throw error;
      }
    }
    if (!voucher) throw new DomainError(errorCodes.INTERNAL, 'تعذّر إنشاء سند القبض', 500);
    if (voucher.status === 'draft') {
      try {
        return await this.treasury.postVoucher(tenantId, voucher.id, {
          allocations: input.partyId
            ? [{ partyId: input.partyId, invoiceKind: 'sales', invoiceId: input.invoiceId, amount: input.amount }]
            : [],
        });
      } catch (error) {
        this.logger.warn(`receipt ${voucher.id} stayed draft: ${(error as Error).message}`);
        return voucher;
      }
    }
    return voucher;
  }

  private async notifyPaid(tenantId: string, link: typeof paymentLinks.$inferSelect, voucherId: string, paidValue: string) {
    try {
      const userId = link.createdBy;
      if (!userId) return;
      const [membership] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId), eq(memberships.status, 'active')))
          .limit(1),
      );
      if (!membership) return;
      await this.notifications.create({
        tenantId,
        membershipId: membership.id,
        type: 'payment.received',
        payload: { paymentLinkId: link.id, invoiceId: link.invoiceId, voucherId, amount: paidValue, provider: link.provider },
      });
    } catch (error) {
      this.logger.warn(`payment notification skipped: ${(error as Error).message}`);
    }
  }

  private async findLink(tenantId: string, provider: OnlineProvider, event: NormalizedWebhook) {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(paymentLinks).where(and(eq(paymentLinks.tenantId, tenantId), eq(paymentLinks.provider, provider))),
    );
    const found =
      rows.find((row) => event.paymentLinkId && row.id === event.paymentLinkId) ||
      rows.find((row) => event.externalId && row.externalId === event.externalId) ||
      rows.find((row) => event.invoiceId && row.invoiceId === event.invoiceId && row.status === 'pending');
    if (!found) throw new DomainError(errorCodes.NOT_FOUND, 'رابط الدفع غير موجود', 404);
    return found;
  }

  private async cashLocation(tenantId: string, provider: OnlineProvider, branchId: string) {
    const config = await this.requireConfig(tenantId, provider);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(cashLocations)
        .where(and(eq(cashLocations.tenantId, tenantId), eq(cashLocations.isActive, true), isNull(cashLocations.deletedAt))),
    );
    const chosen =
      rows.find((row) => row.id === config.cashLocationId) ||
      rows.find((row) => row.branchId === branchId && row.isDefault) ||
      rows.find((row) => row.branchId === branchId) ||
      rows.find((row) => row.isDefault) ||
      rows[0];
    if (!chosen) throw new DomainError('CASH_LOCATION_REQUIRED', 'لا يوجد صندوق أو بنك لتسجيل سند القبض', 422);
    return chosen.id;
  }

  private async party(tenantId: string, partyId: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId))).limit(1),
    );
    return row;
  }

  private async requireConfig(tenantId: string, provider: OnlineProvider) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(paymentProviderConfigs)
        .where(and(eq(paymentProviderConfigs.tenantId, tenantId), eq(paymentProviderConfigs.provider, provider)))
        .limit(1),
    );
    if (!row) throw new DomainError('PAYMENT_PROVIDER_NOT_CONFIGURED', `اربط ${PROVIDER_LABELS[provider]} من إعدادات المدفوعات أولاً`, 404);
    return row;
  }

  private async requireLink(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(paymentLinks).where(and(eq(paymentLinks.tenantId, tenantId), eq(paymentLinks.id, id))).limit(1),
    );
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'رابط الدفع غير موجود', 404);
    return row;
  }

  private async touch(tenantId: string, id: string, extra: Record<string, unknown>) {
    const current = await this.requireLink(tenantId, id);
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(paymentLinks)
        .set({ payload: { ...(current.payload ?? {}), ...extra }, updatedAt: new Date() })
        .where(and(eq(paymentLinks.tenantId, tenantId), eq(paymentLinks.id, id))),
    );
  }

  private async postProvider(call: { url: string; headers: Record<string, string>; body: string }) {
    const response = await fetch(call.url, { method: 'POST', headers: call.headers, body: call.body, signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { message: text.slice(0, 300) };
    }
    if (!response.ok) {
      this.logger.warn(`payment provider ${response.status} ${call.url}`);
      throw new DomainError('PAYMENT_PROVIDER_FAILED', 'تعذّر إنشاء رابط الدفع لدى المزوّد', 502);
    }
    return parsed;
  }

  private provider(value: string): OnlineProvider {
    if (!isOnlineProvider(value)) throw new DomainError(errorCodes.VALIDATION_FAILED, `مزوّد غير مدعوم: ${value}`, 422, { field: 'provider' });
    return value;
  }

  private toConfig(provider: OnlineProvider, row?: typeof paymentProviderConfigs.$inferSelect) {
    return {
      provider,
      label: PROVIDER_LABELS[provider],
      isActive: row?.isActive ?? false,
      simulation: row?.simulation ?? true,
      currency: row?.currency ?? 'SAR',
      publishableKey: row?.publishableKey ?? null,
      cashLocationId: row?.cashLocationId ?? null,
      hasApiKey: Boolean(row?.apiKeyEnc),
      hasWebhookSecret: Boolean(row?.webhookSecretEnc),
      webhookUrl: webhookUrl(provider, row?.tenantId),
      configured: Boolean(row),
    };
  }
}

function toLink(row: typeof paymentLinks.$inferSelect) {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    provider: row.provider,
    label: isOnlineProvider(row.provider) ? PROVIDER_LABELS[row.provider] : row.provider,
    amount: row.amount,
    currency: row.currency,
    linkUrl: row.linkUrl,
    externalId: row.externalId,
    status: row.status,
    paidAt: row.paidAt,
    voucherId: row.voucherId,
    createdAt: row.createdAt,
  };
}

function webhookUrl(provider: OnlineProvider, tenantId?: string) {
  const base = (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
  const query = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : '';
  return `${base}/api/v1/payments/webhooks/${provider}${query}`;
}

function portalPayUrl(invoiceId: string) {
  const base = (process.env.APP_PUBLIC_URL || 'http://localhost:3001').replace(/\/+$/, '');
  return `${base}/portal/invoices/${invoiceId}/pay`;
}

function headerValue(headers: HeaderMap, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}
