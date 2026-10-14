import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { dataEncryptionKey } from '@erp/config';
import { DomainError, newId } from '@erp/contracts';
import { paymentGatewaySettings, paymentGatewayTransactions, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { getRequestContext } from '../../request-context/request-context.js';
import { SalesService } from '../sales/sales.service.js';

import {
  GATEWAY_PROVIDERS,
  defaultBaseUrl,
  gatewayFor,
  maskSecret,
  simulatedSale,
  simulatedStatus,
  simulatedTest,
  type GatewayConfig,
  type GatewayProvider,
  type GatewayResult,
} from './gateways/index.js';

const money = (value: string | number | null | undefined) => new Decimal(value ?? '0');

/** The two providers, as «إعدادات جيديا» names them. */
const PROVIDER_LABELS: Record<GatewayProvider, string> = { geidea: 'جيديا', neoleap: 'NeoLeap' };

/** «الرجاء تفعيل الدفع عن طريق جيديا!» (frmSettings.xaml.cs L2519) — one per provider. */
const DISABLED_MESSAGES: Record<GatewayProvider, string> = {
  geidea: 'الرجاء تفعيل الدفع عن طريق جيديا!',
  neoleap: 'الرجاء تفعيل NeoLeap!',
};

/** A state the gateway will not change again — there is nothing left to refresh. */
const FINAL_STATUSES = ['approved', 'declined', 'cancelled', 'error'];

export type GatewaySettingsInput = {
  active?: boolean;
  printReceipt?: boolean;
  port?: number | null;
  baseUrl?: string;
  currency?: string;
  merchantKey?: string;
  /** Plain text, encrypted before it is stored; never returned. */
  merchantSecret?: string;
  callbackUrl?: string;
  simulation?: boolean;
};

export type SaleInput = {
  /** Decimal string — the money the cashier is taking. */
  amount: string;
  invoiceId?: string;
  branchId?: string;
  /** `ecrRef` · `merchantReferenceId`. Invented when absent; unique per provider. */
  reference?: string;
  currency?: string;
  printReceipt?: boolean;
  callbackUrl?: string;
};

export type GatewayView = {
  provider: GatewayProvider;
  labelAr: string;
  active: boolean;
  printReceipt: boolean;
  port: number | null;
  baseUrl: string;
  currency: string;
  merchantKey: string;
  hasSecret: boolean;
  secretMasked: string | null;
  callbackUrl: string;
  simulation: boolean;
  lastTest: Record<string, unknown> | null;
  updatedAt: string | null;
};

export type TransactionView = {
  id: string;
  provider: GatewayProvider;
  reference: string;
  sessionId: string | null;
  invoiceId: string | null;
  branchId: string | null;
  amount: string;
  currency: string;
  status: string;
  responseCode: string | null;
  detailedResponseCode: string | null;
  message: string | null;
  approvalCode: string | null;
  rrn: string | null;
  stan: string | null;
  cardScheme: string | null;
  panMasked: string | null;
  transactionType: string | null;
  checkoutUrl: string | null;
  simulation: boolean;
  settled: boolean;
  createdAt: string | null;
};

/** The same AES-256-GCM envelope `einvoice_credentials` uses (SECURITY_ARCHITECTURE §9). */
function keyBytes(secret = dataEncryptionKey()): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptGatewaySecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptGatewaySecret(payload: string): string {
  const [, iv64, tag64, data64] = payload.split(':');
  if (!iv64 || !tag64 || !data64) throw new DomainError('SECRET_DECRYPT_FAILED', 'Encrypted secret payload is invalid', 500);
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * The gateway's answer is stored verbatim because a disputed card is argued about with the
 * bank's own words — but the request we sent carries the merchant secret, and a log is not
 * a vault. Every occurrence of the secret is cut out before the row is written.
 */
function redactSecrets(raw: Record<string, unknown>, secret: string): Record<string, unknown> {
  if (!secret) return raw;
  const text = JSON.stringify(raw);
  if (!text.includes(secret)) return raw;
  return JSON.parse(text.split(secret).join('****')) as Record<string, unknown>;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sales: SalesService,
  ) {}

  // ── 💳 إعدادات البوابة («إعدادات جيديا» + GroupBox «NeoLeap») ─────────────────────────

  /** The two cards of the window, each with its own saved row. */
  async view(tenantId: string) {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(paymentGatewaySettings).where(eq(paymentGatewaySettings.tenantId, tenantId)),
    );
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    return {
      providers: GATEWAY_PROVIDERS.map((provider) => this.toView(provider, byProvider.get(provider))),
    };
  }

  /** 💾 حفظ — `BtnSaveGedia_Click` (L2456) and `Btnsavneoleap_Click` (L2535). */
  async save(tenantId: string, provider: string, input: GatewaySettingsInput = {}) {
    const key = this.provider(provider);
    const [existing] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(paymentGatewaySettings)
        .where(and(eq(paymentGatewaySettings.tenantId, tenantId), eq(paymentGatewaySettings.provider, key))),
    );

    const port = input.port === undefined ? existing?.port ?? null : this.port(input.port);
    const values = {
      active: input.active === undefined ? existing?.active ?? false : Boolean(input.active),
      printReceipt: input.printReceipt === undefined ? existing?.printReceipt ?? false : Boolean(input.printReceipt),
      port,
      baseUrl: (input.baseUrl ?? existing?.baseUrl ?? '').trim(),
      currency: (input.currency ?? existing?.currency ?? 'SAR').trim().toUpperCase() || 'SAR',
      merchantKey: (input.merchantKey ?? existing?.merchantKey ?? '').trim(),
      merchantSecretEnc:
        input.merchantSecret && input.merchantSecret.length > 0
          ? encryptGatewaySecret(input.merchantSecret)
          : existing?.merchantSecretEnc ?? null,
      callbackUrl: (input.callbackUrl ?? existing?.callbackUrl ?? '').trim(),
      simulation: input.simulation === undefined ? existing?.simulation ?? true : Boolean(input.simulation),
      updatedAt: new Date(),
      updatedBy: getRequestContext().tenant?.userId ?? null,
    };

    const [row] = existing
      ? await withTenantTx(this.database.db, tenantId, (tx) =>
          tx
            .update(paymentGatewaySettings)
            .set({ ...values, version: (existing.version ?? 1) + 1 })
            .where(and(eq(paymentGatewaySettings.tenantId, tenantId), eq(paymentGatewaySettings.provider, key)))
            .returning(),
        )
      : await withTenantTx(this.database.db, tenantId, (tx) =>
          tx
            .insert(paymentGatewaySettings)
            .values({ id: newId(), tenantId, provider: key, ...values })
            .returning(),
        );

    return this.toView(key, row);
  }

  // ── 🧪 TEST / 🧪 Test ─────────────────────────────────────────────────────────────

  /**
   * 🧪 TEST (L2513) · 🧪 Test (L4047) — the desktop charged a token amount and showed the
   * gateway's answer («Logging» for NeoLeap, a message box for جيديا). We do the same and
   * keep the answer on the row, so the window still shows it after a reload.
   */
  async test(tenantId: string, provider: string, input: { amount?: string } = {}) {
    const key = this.provider(provider);
    const settings = await this.settings(tenantId, key);
    if (!settings.active) {
      throw new DomainError('PAYMENT_GATEWAY_DISABLED', DISABLED_MESSAGES[key], 409);
    }
    const config = this.config(key, settings);
    const result = config.simulation
      ? simulatedTest(key, `TEST-${newId()}`)
      : await gatewayFor(key).test(config, (input.amount ?? '').trim() || undefined);

    const at = new Date().toISOString();
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(paymentGatewaySettings)
        .set({ lastTest: { at, ...this.testLog(result) }, updatedAt: new Date(), updatedBy: getRequestContext().tenant?.userId ?? null })
        .where(and(eq(paymentGatewaySettings.tenantId, tenantId), eq(paymentGatewaySettings.provider, key))),
    );

    return { provider: key, labelAr: PROVIDER_LABELS[key], simulation: config.simulation, at, ...this.testLog(result) };
  }

  // ── 💳 the sale itself (`frmPOSBill.xaml.cs` L460-L492) ──────────────────────────────

  /**
   * One 💳 press. The desktop did this inside the POS save, in the cashier's thread, and
   * threw the answer away once the invoice was written; here the answer is the point — it
   * is stored, it can be refreshed, and an approved sale can be settled onto the invoice.
   */
  async sale(tenantId: string, provider: string, input: SaleInput) {
    const key = this.provider(provider);
    const settings = await this.settings(tenantId, key);
    if (!settings.active) {
      throw new DomainError('PAYMENT_GATEWAY_DISABLED', DISABLED_MESSAGES[key], 409);
    }

    const value = this.value(input.amount);
    const currency = (input.currency ?? settings.currency ?? 'SAR').trim().toUpperCase() || 'SAR';
    const reference = (input.reference ?? '').trim() || `ECR-${newId()}`;

    let invoiceId: string | null = null;
    if (input.invoiceId) {
      invoiceId = String(input.invoiceId);
      const invoice = await this.sales.get(tenantId, invoiceId);
      if (invoice.status !== 'posted') {
        throw new DomainError('SALES_INVOICE_NOT_POSTED', 'لا يمكن تحصيل فاتورة غير مرحَّلة — رحّلها أولاً.', 409);
      }
      // «قيمة مدفوع الشبكة يجب أن تساوي صافي الفاتورة» (frmPOSBill.xaml.cs L505): the
      // desktop demanded equality for شبكة; a partial card payment is normal on a server,
      // so what is enforced is the balance that is actually left.
      const remaining = money(invoice.total).minus(money(invoice.paidTotal));
      if (value.gt(remaining)) {
        throw new DomainError('PAYMENT_EXCEEDS_DUE', `قيمة الشبكة أكبر من المتبقي على الفاتورة (${remaining.toFixed(2)} ${currency}).`, 422);
      }
    }

    const existing = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: paymentGatewayTransactions.id })
        .from(paymentGatewayTransactions)
        .where(
          and(
            eq(paymentGatewayTransactions.tenantId, tenantId),
            eq(paymentGatewayTransactions.provider, key),
            eq(paymentGatewayTransactions.reference, reference),
          ),
        ),
    );
    if (existing.length > 0) {
      // The desktop's `ecrRef` is a GUID the till invents; two presses with the same one
      // are one sale, not two charges.
      throw new DomainError('PAYMENT_REFERENCE_DUPLICATED', 'هذا المرجع مستخدم مسبقاً — اضغط 💳 من جديد.', 409);
    }

    const config = this.config(key, settings);
    const result = config.simulation
      ? simulatedSale(key, { reference, value: value.toFixed(2), currency })
      : await gatewayFor(key).sale(
          {
            value: value.toFixed(2),
            currency,
            reference,
            printReceipt: input.printReceipt ?? settings.printReceipt ?? false,
            callbackUrl: input.callbackUrl ?? settings.callbackUrl ?? '',
          },
          config,
        );

    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(paymentGatewayTransactions)
        .values({
          id: newId(),
          tenantId,
          provider: key,
          reference,
          sessionId: result.sessionId,
          invoiceId,
          branchId: input.branchId ?? null,
          amount: value.toFixed(4),
          currency,
          status: result.status,
          responseCode: result.responseCode,
          detailedResponseCode: result.detailedResponseCode,
          message: result.message,
          approvalCode: result.approvalCode,
          rrn: result.rrn,
          stan: result.stan,
          cardScheme: result.cardScheme,
          panMasked: result.panMasked,
          transactionType: result.transactionType,
          checkoutUrl: result.checkoutUrl,
          rawResponse: redactSecrets(result.raw ?? {}, config.merchantSecret),
          simulation: config.simulation,
          settled: false,
          createdBy: getRequestContext().tenant?.userId ?? null,
        })
        .returning(),
    );

    return this.settleIfApproved(tenantId, row!, result);
  }

  // ── 🔄 how a pending payment ended ─────────────────────────────────────────────────

  /**
   * جيديا keeps a session open until the cardholder finishes; NeoLeap answers at once and
   * has nothing to ask about. `frmPOSBill` had no equivalent — it blocked on the COM port
   * until the terminal answered.
   */
  async refresh(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(paymentGatewayTransactions)
        .where(and(eq(paymentGatewayTransactions.tenantId, tenantId), eq(paymentGatewayTransactions.id, id))),
    );
    if (!row) throw new DomainError('PAYMENT_TRANSACTION_NOT_FOUND', 'العملية غير موجودة.', 404);
    if (FINAL_STATUSES.includes(row.status)) {
      return { transaction: this.toTransaction(row), refreshed: false, message: 'هذه العملية منتهية — لا شيء لتحديثه.' };
    }

    const key = this.provider(row.provider);
    const settings = await this.settings(tenantId, key);
    const config = this.config(key, settings);
    const gateway = gatewayFor(key);
    if (!gateway.queryable) {
      return { transaction: this.toTransaction(row), refreshed: false, message: 'بوابة NeoLeap تُجيب فوراً — لا حالة معلّقة للتحديث.' };
    }

    const result = config.simulation
      ? simulatedStatus(key, { reference: row.reference, sessionId: row.sessionId })
      : await gateway.status({ reference: row.reference, sessionId: row.sessionId }, config);

    const [updated] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(paymentGatewayTransactions)
        .set({
          status: result.status,
          sessionId: result.sessionId ?? row.sessionId,
          responseCode: result.responseCode,
          detailedResponseCode: result.detailedResponseCode,
          message: result.message,
          approvalCode: result.approvalCode,
          rrn: result.rrn,
          stan: result.stan,
          cardScheme: result.cardScheme,
          panMasked: result.panMasked,
          transactionType: result.transactionType,
          checkoutUrl: result.checkoutUrl ?? row.checkoutUrl,
          rawResponse: redactSecrets(result.raw ?? (row.rawResponse as Record<string, unknown>) ?? {}, config.merchantSecret),
        })
        .where(and(eq(paymentGatewayTransactions.tenantId, tenantId), eq(paymentGatewayTransactions.id, id)))
        .returning(),
    );

    return { ...(await this.settleIfApproved(tenantId, updated!, result)), refreshed: true };
  }

  // ── the log the desktop never kept ─────────────────────────────────────────────────

  async transactions(tenantId: string, query: { provider?: string; status?: string; limit?: string } = {}) {
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const filters = [eq(paymentGatewayTransactions.tenantId, tenantId)];
    if (query.provider) filters.push(eq(paymentGatewayTransactions.provider, this.provider(query.provider)));
    if (query.status) filters.push(eq(paymentGatewayTransactions.status, query.status));
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(paymentGatewayTransactions)
        .where(and(...filters))
        .orderBy(desc(paymentGatewayTransactions.createdAt), desc(paymentGatewayTransactions.reference))
        .limit(limit),
    );
    return { transactions: rows.map((row) => this.toTransaction(row)) };
  }

  // ── internals ─────────────────────────────────────────────────────────────────────

  /** An approved sale is money in — write it on the invoice once, and remember that we did. */
  private async settleIfApproved(tenantId: string, row: typeof paymentGatewayTransactions.$inferSelect, result: GatewayResult) {
    if (result.status !== 'approved' || !row.invoiceId || row.settled) {
      return { transaction: this.toTransaction(row), settled: row.settled };
    }
    try {
      await this.sales.addPayment(tenantId, row.invoiceId, {
        method: 'card',
        amount: money(row.amount).toFixed(2),
        idempotencyKey: row.reference,
        reference: result.approvalCode ?? result.sessionId ?? row.reference,
      });
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      this.logger.warn(`card settlement failed for ${row.reference}: ${message}`);
      return { transaction: this.toTransaction(row), settled: false, settlementError: message };
    }
    const [updated] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(paymentGatewayTransactions)
        .set({ settled: true })
        .where(and(eq(paymentGatewayTransactions.tenantId, tenantId), eq(paymentGatewayTransactions.id, row.id)))
        .returning(),
    );
    return { transaction: this.toTransaction(updated ?? row), settled: true };
  }

  private async settings(tenantId: string, provider: GatewayProvider) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(paymentGatewaySettings)
        .where(and(eq(paymentGatewaySettings.tenantId, tenantId), eq(paymentGatewaySettings.provider, provider))),
    );
    if (!row) {
      throw new DomainError('PAYMENT_GATEWAY_NOT_CONFIGURED', `لم تُضبط بوابة ${PROVIDER_LABELS[provider]} — افتح «💳 إعدادات البوابة» واحفظ الإعدادات.`, 404);
    }
    return row;
  }

  private config(provider: GatewayProvider, row: typeof paymentGatewaySettings.$inferSelect): GatewayConfig {
    const baseUrl = (row.baseUrl ?? '').trim() || defaultBaseUrl(provider, row.port);
    if (!baseUrl && !(row.simulation ?? true)) {
      throw new DomainError('PAYMENT_GATEWAY_NOT_CONFIGURED', `لم يُحدَّد عنوان بوابة ${PROVIDER_LABELS[provider]} — اكتب العنوان أو «المنفذ».`, 422);
    }
    let secret = '';
    if (row.merchantSecretEnc) {
      try {
        secret = decryptGatewaySecret(row.merchantSecretEnc);
      } catch {
        throw new DomainError('SECRET_DECRYPT_FAILED', 'تعذّر فكّ تشفير مفتاح البوابة — احفظه من جديد.', 500);
      }
    }
    return {
      provider,
      baseUrl,
      merchantKey: row.merchantKey ?? '',
      merchantSecret: secret,
      currency: row.currency ?? 'SAR',
      printReceipt: row.printReceipt ?? false,
      callbackUrl: row.callbackUrl ?? '',
      port: row.port ?? null,
      simulation: row.simulation ?? true,
    };
  }

  /** «Logging» — the lines the connector's notifier would have printed. */
  private testLog(result: GatewayResult) {
    return {
      status: result.status,
      ok: result.status === 'approved' || result.status === 'initiated',
      responseCode: result.responseCode,
      detailedResponseCode: result.detailedResponseCode,
      message: result.message,
      reference: result.reference,
      sessionId: result.sessionId,
      lines: [
        `reference: ${result.reference}`,
        `status: ${result.status}`,
        `responseCode: ${result.responseCode ?? '-'}`,
        `message: ${result.message ?? '-'}`,
      ],
    };
  }

  private toView(provider: GatewayProvider, row?: typeof paymentGatewaySettings.$inferSelect): GatewayView {
    let secretMasked: string | null = null;
    if (row?.merchantSecretEnc) {
      try {
        secretMasked = maskSecret(decryptGatewaySecret(row.merchantSecretEnc));
      } catch {
        secretMasked = '****';
      }
    }
    return {
      provider,
      labelAr: PROVIDER_LABELS[provider],
      active: row?.active ?? false,
      printReceipt: row?.printReceipt ?? false,
      port: row?.port ?? null,
      baseUrl: (row?.baseUrl ?? '').trim() || defaultBaseUrl(provider, row?.port ?? null),
      currency: row?.currency ?? 'SAR',
      merchantKey: row?.merchantKey ?? '',
      hasSecret: Boolean(row?.merchantSecretEnc),
      secretMasked,
      callbackUrl: row?.callbackUrl ?? '',
      simulation: row?.simulation ?? true,
      lastTest: (row?.lastTest as Record<string, unknown> | null) ?? null,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  }

  private toTransaction(row: typeof paymentGatewayTransactions.$inferSelect): TransactionView {
    return {
      id: row.id,
      provider: row.provider as GatewayProvider,
      reference: row.reference,
      sessionId: row.sessionId,
      invoiceId: row.invoiceId,
      branchId: row.branchId,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      responseCode: row.responseCode,
      detailedResponseCode: row.detailedResponseCode,
      message: row.message,
      approvalCode: row.approvalCode,
      rrn: row.rrn,
      stan: row.stan,
      cardScheme: row.cardScheme,
      panMasked: row.panMasked,
      transactionType: row.transactionType,
      checkoutUrl: row.checkoutUrl,
      simulation: row.simulation,
      settled: row.settled,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    };
  }

  private provider(value: string): GatewayProvider {
    const key = String(value ?? '').trim().toLowerCase();
    if (key !== 'geidea' && key !== 'neoleap') {
      throw new DomainError('PAYMENT_PROVIDER_UNKNOWN', `بوابة غير معروفة: ${value}. البوابات هي جيديا (geidea) و NeoLeap (neoleap).`, 422);
    }
    return key;
  }

  private port(value: number | null | undefined): number | null {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new DomainError('PAYMENT_PORT_INVALID', '«المنفذ» رقم بين 0 و 65535.', 422);
    }
    return parsed;
  }

  private value(input: string | number | undefined): Decimal {
    const parsed = new Decimal(String(input ?? ''));
    if (!parsed.isFinite() || parsed.lte(0)) {
      throw new DomainError('PAYMENT_AMOUNT_INVALID', 'المبلغ يجب أن يكون أكبر من الصفر.', 422);
    }
    return parsed;
  }
}
