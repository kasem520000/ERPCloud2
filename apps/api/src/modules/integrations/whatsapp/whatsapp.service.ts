import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import { companyProfiles, parties, whatsappMessages, whatsappSettings, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { UsageService } from '../../usage/index.js';
import { openSecret, sealSecret } from '../../platform/auth/secret-box.js';
import { getRequestContext } from '../../../request-context/request-context.js';
import { SalesService } from '../../sales/sales.service.js';

import { DOCUMENT_MIME, sendDocument, sendText, simulatedUndeliverable, uploadMedia, verifyConnection, type CloudConfig } from './cloud-api.js';

export type WhatsappSettingsInput = {
  active?: boolean;
  phoneNumberId?: string;
  /** Plain text, sealed before it is stored; never returned. */
  accessToken?: string;
  defaultCountryCode?: string;
  attachDocument?: boolean;
  simulation?: boolean;
  baseUrl?: string;
};

export type SendInput = {
  invoiceId: string;
  /** Overrides the customer's number — «📱» on the invoice, or a walk-in's number. */
  to?: string;
  /** Overrides the greeting line the desktop builds. */
  message?: string;
  /** Overrides the tenant's 📎 switch for this one message. */
  attach?: boolean;
};

export type SettingsView = {
  active: boolean;
  phoneNumberId: string;
  hasToken: boolean;
  tokenMasked: string | null;
  defaultCountryCode: string;
  attachDocument: boolean;
  simulation: boolean;
  baseUrl: string;
  lastTest: Record<string, unknown> | null;
  updatedAt: string | null;
};

export type MessageView = {
  id: string;
  invoiceId: string | null;
  partyId: string | null;
  phone: string;
  message: string;
  attachmentName: string | null;
  attachmentStatus: string;
  status: string;
  providerMessageId: string | null;
  attachmentMessageId: string | null;
  error: string | null;
  simulation: boolean;
  createdAt: string | null;
};

/** «الرجاء تفعيل الإرسال عبر واتساب.» — the switch «💬 واتساب» cannot work without. */
const DISABLED_MESSAGE = 'الرجاء تفعيل الإرسال عبر واتساب.';

function mask(plain: string): string {
  return `****${plain.slice(-4)}`;
}

/**
 * `WhatsAppSender.SendInvoiceAsync` (L113-L116) — verbatim:
 *
 *   if (!text.StartsWith("966")) text = "966" + text.TrimStart('0');
 *
 * The country code is a setting here rather than a constant, for the tenant whose customers
 * are not in Saudi Arabia.
 */
export function normalizePhone(raw: string, countryCode = '966'): string {
  const digits = String(raw ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  if (countryCode && digits.startsWith(countryCode)) return digits;
  return `${countryCode}${digits.replace(/^0+/, '')}`;
}

@Injectable()
export class WhatsappService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sales: SalesService,
    private readonly usage: UsageService,
  ) {}

  // ── ⚙️ الإعدادات ──────────────────────────────────────────────────────────────────

  async view(tenantId: string) {
    return { settings: this.toView(await this.row(tenantId)) };
  }

  async save(tenantId: string, input: WhatsappSettingsInput = {}) {
    const existing = await this.row(tenantId);
    const values = {
      active: input.active === undefined ? existing?.active ?? false : Boolean(input.active),
      phoneNumberId: (input.phoneNumberId ?? existing?.phoneNumberId ?? '').trim(),
      accessTokenEnc:
        input.accessToken && input.accessToken.length > 0 ? sealSecret(input.accessToken) : existing?.accessTokenEnc ?? null,
      defaultCountryCode: (input.defaultCountryCode ?? existing?.defaultCountryCode ?? '966').trim() || '966',
      attachDocument: input.attachDocument === undefined ? existing?.attachDocument ?? true : Boolean(input.attachDocument),
      simulation: input.simulation === undefined ? existing?.simulation ?? true : Boolean(input.simulation),
      updatedAt: new Date(),
      updatedBy: getRequestContext().tenant?.userId ?? null,
    };
    const [row] = existing
      ? await withTenantTx(this.database.db, tenantId, (tx) =>
          tx
            .update(whatsappSettings)
            .set({ ...values, version: (existing.version ?? 1) + 1 })
            .where(eq(whatsappSettings.tenantId, tenantId))
            .returning(),
        )
      : await withTenantTx(this.database.db, tenantId, (tx) =>
          tx.insert(whatsappSettings).values({ id: newId(), tenantId, ...values }).returning(),
        );
    return { settings: this.toView(row) };
  }

  // ── 🧪 اختبار ────────────────────────────────────────────────────────────────────

  /**
   * 🧪 اختبار — the desktop had nothing to test: it opened a browser and hoped the QR code
   * had been scanned. `GET /{phone-number-id}` answers the question a server can actually
   * ask — is this number ours, and is this token good for it?
   */
  async test(tenantId: string) {
    const row = await this.row(tenantId);
    if (!row) throw new DomainError('WHATSAPP_NOT_CONFIGURED', 'لم تُضبط بوابة واتساب — افتح «💬 واتساب» واحفظ الإعدادات.', 404);
    const config = this.config(row);
    const result = await verifyConnection(config);
    const at = new Date().toISOString();
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(whatsappSettings)
        .set({
          lastTest: { at, ...result, lines: [`at: ${at}`, `ok: ${result.ok}`, `number: ${result.displayPhoneNumber ?? '-'}`, `name: ${result.verifiedName ?? '-'}`, `error: ${result.error ?? '-'}`] },
          updatedAt: new Date(),
          updatedBy: getRequestContext().tenant?.userId ?? null,
        })
        .where(eq(whatsappSettings.tenantId, tenantId)),
    );
    return { simulation: config.simulation, at, ...result };
  }

  // ── 💬 الإرسال (`frmInvSale.xaml.cs` L3130-L3195) ──────────────────────────────────

  /**
   * One 💬 press. The desktop did it all in the cashier's browser and kept nothing: the
   * PDF was written to the application folder, handed to Selenium and forgotten. Here the
   * words, the number, the attachment and the provider's own message id are all written
   * down — because «هل وصلت الفاتورة؟» is a question a server has to be able to answer.
   */
  async send(tenantId: string, input: SendInput) {
    // P-C5: رسائل واتساب مقياسٌ محدود — الحدّ أولاً، ثم إعدادات البوابة.
    await this.usage.assertWithinLimit(tenantId, 'whatsapp_per_month');
    const row = await this.row(tenantId);
    if (!row) throw new DomainError('WHATSAPP_NOT_CONFIGURED', 'لم تُضبط بوابة واتساب — افتح «💬 واتساب» واحفظ الإعدادات.', 404);
    if (!row.active) throw new DomainError('WHATSAPP_DISABLED', DISABLED_MESSAGE, 409);

    const invoice = await this.sales.get(tenantId, String(input.invoiceId ?? ''));
    // «لا يمكن إرسال الفاتورة قبل الحفظ» (L3135): a مسوَّدة has no number yet, and the
    // greeting names the invoice by its number.
    if (invoice.status !== 'posted') {
      throw new DomainError('SALES_INVOICE_NOT_POSTED', 'لا يمكن إرسال الفاتورة قبل ترحيلها — رحّلها أولاً.', 409);
    }

    const phone = normalizePhone(input.to ?? (await this.customerPhone(tenantId, invoice)) ?? '', row.defaultCountryCode);
    if (!phone || phone.length < 8 || phone.length > 15) {
      // «❌ لا يوجد رقم جوال للعميل» (L3160), unless a number was given and is unusable.
      throw new DomainError(
        input.to ? 'WHATSAPP_PHONE_INVALID' : 'WHATSAPP_PHONE_MISSING',
        input.to ? `رقم الجوال غير صحيح: ${input.to}` : '❌ لا يوجد رقم جوال للعميل',
        422,
      );
    }

    const company = await this.company(tenantId);
    const customerName = invoice.cashCustomerName ?? (await this.partyName(tenantId, invoice.partyId)) ?? 'العميل';
    const reference = `INV${invoice.number ?? ''}`;
    const message = (input.message ?? '').trim() || `🧾 مرحباً ${customerName}، هذه فاتورتك رقم ${reference} من ${company}`;

    const config = this.config(row);
    const attach = input.attach === undefined ? row.attachDocument : Boolean(input.attach);
    const filename = attach ? `فاتورة-${reference}.txt` : null;

    const text = await sendText(config, phone, message);
    let attachmentStatus: 'none' | 'sent' | 'failed' = 'none';
    let attachmentMessageId: string | null = null;
    let attachmentError: string | null = null;

    if (text.ok && filename) {
      attachmentStatus = 'failed';
      const uploaded = await uploadMedia(config, {
        bytes: Buffer.from(this.invoiceSheet({ invoice, company, customerName }), 'utf8'),
        filename,
        mime: DOCUMENT_MIME,
      });
      if (uploaded.mediaId) {
        const document = await sendDocument(config, { phone, mediaId: uploaded.mediaId, filename });
        if (document.ok) {
          attachmentStatus = 'sent';
          attachmentMessageId = document.messageId;
        } else {
          attachmentError = document.error;
        }
      } else {
        attachmentError = uploaded.error;
      }
    }

    const [record] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(whatsappMessages)
        .values({
          id: newId(),
          tenantId,
          invoiceId: invoice.id,
          partyId: invoice.partyId ?? null,
          phone,
          message,
          attachmentName: attachmentStatus === 'none' ? null : filename,
          attachmentStatus,
          status: text.ok ? 'sent' : 'failed',
          providerMessageId: text.messageId,
          attachmentMessageId,
          error: text.error ?? attachmentError,
          simulation: config.simulation,
          createdBy: getRequestContext().tenant?.userId ?? null,
        })
        .returning(),
    );

    return { message: this.toMessage(record!), attachment: attachmentStatus, attachmentError };
  }

  // ── 📜 السجل ─────────────────────────────────────────────────────────────────────

  async messages(tenantId: string, query: { limit?: string; status?: string; invoiceId?: string } = {}) {
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const filters = [eq(whatsappMessages.tenantId, tenantId)];
    if (query.status) filters.push(eq(whatsappMessages.status, query.status));
    if (query.invoiceId) filters.push(eq(whatsappMessages.invoiceId, query.invoiceId));
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(whatsappMessages).where(and(...filters)).orderBy(desc(whatsappMessages.createdAt)).limit(limit),
    );
    return { messages: rows.map((row) => this.toMessage(row)) };
  }

  /**
   * A CRM greeting, not an invoice. Uses the same gateway and the same monthly cap.
   * `invoiceId` stays null so the invoice log is not mixed with a deal conversation.
   */
  async sendPlain(tenantId: string, input: { to: string; message: string; partyId?: string | null }) {
    await this.usage.assertWithinLimit(tenantId, 'whatsapp_per_month');
    const row = await this.row(tenantId);
    if (!row) throw new DomainError('WHATSAPP_NOT_CONFIGURED', 'لم تُضبط بوابة واتساب — افتح «💬 واتساب» واحفظ الإعدادات.', 404);
    if (!row.active) throw new DomainError('WHATSAPP_DISABLED', DISABLED_MESSAGE, 409);
    const phone = normalizePhone(input.to, row.defaultCountryCode);
    if (!phone || phone.length < 8 || phone.length > 15) {
      throw new DomainError('WHATSAPP_PHONE_INVALID', `رقم الجوال غير صحيح: ${input.to}`, 422);
    }
    const message = input.message.trim();
    if (!message) throw new DomainError('VALIDATION_FAILED', 'نص الرسالة فارغ', 422);
    const config = this.config(row);
    const text = await sendText(config, phone, message);
    const [record] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(whatsappMessages)
        .values({
          id: newId(),
          tenantId,
          invoiceId: null,
          partyId: input.partyId ?? null,
          phone,
          message,
          attachmentStatus: 'none',
          status: text.ok ? 'sent' : 'failed',
          providerMessageId: text.messageId,
          error: text.error,
          simulation: config.simulation,
          createdBy: getRequestContext().tenant?.userId ?? null,
        })
        .returning(),
    );
    return {
      ok: text.ok,
      phone,
      message,
      providerMessageId: text.messageId,
      error: text.error,
      simulation: config.simulation,
      id: record?.id ?? '',
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────────

  /**
   * 📎 The invoice sheet, as UTF-8 text.
   *
   * The desktop exported `rptPOSA4.repx` (or `rptPricingInv.repx` for a تسعيرة) to PDF with
   * DevExpress. This platform's invoice sheet is print-ready HTML for the *browser* to
   * print (`GET /print/invoices/:id`), and a server-side PDF would mean shipping a font with
   * Arabic shaping — a decision already recorded in `reporting.service.ts`. Plain text is
   * the one document type WhatsApp accepts that we can produce honestly here.
   */
  private invoiceSheet(input: { invoice: Awaited<ReturnType<SalesService['get']>>; company: string; customerName: string }): string {
    const { invoice, company, customerName } = input;
    const lines = (invoice.lines ?? []).map((line, index) => {
      const description = line.description ?? '';
      // The sheet is text, not arithmetic: the invoice's own totals below are the ones
      // that were posted, so these numbers are printed, never re-added.
      const qty = Number(line.quantity ?? '0');
      const each = Number(line.unitPrice ?? '0');
      const lineTotal = Number(line.total ?? '0');
      return `${index + 1}. ${description} — ${qty} × ${each.toFixed(2)} = ${lineTotal.toFixed(2)}`;
    });
    return [
      company,
      `فاتورة مبيعات رقم INV${invoice.number ?? ''}`,
      `التاريخ: ${String(invoice.postedAt ?? invoice.createdAt ?? '').slice(0, 10)}`,
      `العميل: ${customerName}`,
      ''.padEnd(40, '-'),
      ...lines,
      ''.padEnd(40, '-'),
      `الإجمالي: ${Number(invoice.subtotal ?? '0').toFixed(2)}`,
      `الضريبة: ${Number(invoice.taxTotal ?? '0').toFixed(2)}`,
      `الصافي: ${Number(invoice.total ?? '0').toFixed(2)} ${invoice.currency ?? 'SAR'}`,
      '',
    ].join('\n');
  }

  private async customerPhone(tenantId: string, invoice: { partyId?: string | null; cashCustomerMobile?: string | null }): Promise<string | null> {
    if (invoice.cashCustomerMobile) return invoice.cashCustomerMobile;
    if (!invoice.partyId) return null;
    const [party] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ phone: parties.phone }).from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, invoice.partyId!))),
    );
    return party?.phone ?? null;
  }

  private async partyName(tenantId: string, partyId?: string | null): Promise<string | null> {
    if (!partyId) return null;
    const [party] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ name: parties.name }).from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId))),
    );
    return party?.name ?? null;
  }

  /** `Common.FoundationInfoDT.Rows[0]["nameA"]` — the company's own name, as the desktop used it (L3175). */
  private async company(tenantId: string): Promise<string> {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ nameAr: companyProfiles.nameAr }).from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId)),
    );
    return row?.nameAr ?? '';
  }

  private async row(tenantId: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(whatsappSettings).where(eq(whatsappSettings.tenantId, tenantId)),
    );
    return row;
  }

  private config(row: NonNullable<Awaited<ReturnType<WhatsappService['row']>>>): CloudConfig & { baseUrl: string } {
    let accessToken = '';
    if (row.accessTokenEnc) {
      try {
        accessToken = openSecret(row.accessTokenEnc).toString('utf8');
      } catch {
        throw new DomainError('SECRET_DECRYPT_FAILED', 'تعذّر فكّ تشفير رمز واتساب — احفظه من جديد.', 500);
      }
    }
    return {
      phoneNumberId: row.phoneNumberId ?? '',
      accessToken,
      baseUrl: 'https://graph.facebook.com',
      simulation: row.simulation ?? true,
    };
  }

  private toView(row?: Awaited<ReturnType<WhatsappService['row']>>): SettingsView {
    let tokenMasked: string | null = null;
    if (row?.accessTokenEnc) {
      try {
        tokenMasked = mask(openSecret(row.accessTokenEnc).toString('utf8'));
      } catch {
        tokenMasked = '****';
      }
    }
    return {
      active: row?.active ?? false,
      phoneNumberId: row?.phoneNumberId ?? '',
      hasToken: Boolean(row?.accessTokenEnc),
      tokenMasked,
      defaultCountryCode: row?.defaultCountryCode ?? '966',
      attachDocument: row?.attachDocument ?? true,
      simulation: row?.simulation ?? true,
      baseUrl: 'https://graph.facebook.com',
      lastTest: (row?.lastTest as Record<string, unknown> | null) ?? null,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  }

  private toMessage(row: typeof whatsappMessages.$inferSelect): MessageView {
    return {
      id: row.id,
      invoiceId: row.invoiceId,
      partyId: row.partyId,
      phone: row.phone,
      message: row.message,
      attachmentName: row.attachmentName,
      attachmentStatus: row.attachmentStatus,
      status: row.status,
      providerMessageId: row.providerMessageId,
      attachmentMessageId: row.attachmentMessageId,
      error: row.error,
      simulation: row.simulation,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    };
  }
}

/** 🧪 — kept next to the service so the tests and the script share one vocabulary. */
export { simulatedUndeliverable };
