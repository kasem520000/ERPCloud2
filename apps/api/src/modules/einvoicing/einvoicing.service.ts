import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, or, sql } from 'drizzle-orm';
import { dataEncryptionKey } from '@erp/config';
import { DomainError, newId } from '@erp/contracts';
import { branches, einvoiceChain, einvoiceCredentials, einvoiceSettings, einvoiceSubmissions, parties, salesInvoiceLines, salesInvoices, users, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { getRequestContext } from '../../request-context/request-context.js';
import { WebhookPublisher } from '../developer/webhook-publisher.service.js';

import { ZatcaOnboardingService, type FilingContext } from './zatca-onboarding.service.js';
import { fileInvoice } from './zatca/filing.js';
import { buildQrPayload, decodeQrPayload, hashInvoiceXml, signInvoiceHash } from './zatca/qr.js';
import { GENESIS_PIH, buildInvoiceXml, type ZatcaLine, type ZatcaParty } from './zatca/ubl.js';

export type CredentialInput = { authority: 'zatca' | 'eta'; environment: 'simulation' | 'production'; csr?: string; privateKey?: string; csid?: string; secret?: string; org?: Record<string, unknown>; validFrom?: string; validTo?: string };

/**
 * The eight QR tags, named as ZATCA names them.
 *
 * Tags 1–5 are defined by the authority's own specification. The Arabic labels for tags
 * 6–8 are ours: the desktop never showed them, because its compiled SDK returned the
 * finished payload and the window only ever displayed it as a picture. The payload itself
 * is untouched — tag 6 is still the invoice hash and tag 8 the SPKI public key — only the
 * words describing them are written here, for «📄 بيانات الفاتورة».
 */
export const QR_TAG_LABELS: Record<number, string> = {
  1: 'اسم البائع',
  2: 'الرقم الضريبي للبائع',
  3: 'تاريخ الفاتورة ووقتها',
  4: 'الإجمالي شامل الضريبة',
  5: 'إجمالي ضريبة القيمة المضافة',
  6: 'تجزئة الفاتورة (Invoice Hash)',
  7: 'التوقيع الرقمي',
  8: 'المفتاح العام',
  9: 'توقيع الشهادة',
};

function keyBytes(secret = dataEncryptionKey()): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plain: string, key = process.env.DATA_ENC_KEY): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(payload: string, key = process.env.DATA_ENC_KEY): string {
  const [, iv64, tag64, data64] = payload.split(':');
  if (!iv64 || !tag64 || !data64) throw new DomainError('SECRET_DECRYPT_FAILED', 'Encrypted secret payload is invalid', 500);
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]).toString('utf8');
}

function maskEncrypted(value?: string | null): string | null {
  if (!value) return null;
  let plain = '';
  try { plain = decryptSecret(value); } catch { return '****'; }
  return `****${plain.slice(-4)}`;
}

/** The statuses that mean «the authority has this invoice» — re-filing one is a duplicate. */
const ACCEPTED = ['cleared', 'reported'];

/** ⏸ إيقاف الربط — the desktop hides the whole call behind the flag; we say why. */
const LINK_PAUSED_MESSAGE = 'الربط موقوف — شغّله من «⚙️ إعدادات الربط الضريبي - زاتكا ZATCA» (▶ تشغيل).';
/** 409 `EINVOICE_ALREADY_ACCEPTED`, in the words the single-invoice path already uses. */
const ALREADY_ACCEPTED_MESSAGE = 'تم إرسال هذه الفاتورة مسبقاً — استخدم «🔁 إعادة الإرسال» إن فشل الإرسال.';
/** 🔄 مزامنة ZATCA — how many rows one call may file. */
const SYNC_BATCH_LIMIT = 200;

/** One row of a 🔄 مزامنة ZATCA run: what happened to the invoice the clerk ticked. */
export type SyncRow = {
  invoiceId: string;
  number: string | null;
  /** `sent` — the authority accepted it · `failed` — it was refused · `skipped` — it was never sent. */
  outcome: 'sent' | 'failed' | 'skipped';
  status: string | null;
  authorityStatus: string | null;
  message: string | null;
};

@Injectable()
export class EinvoicingService {
  private readonly logger = new Logger(EinvoicingService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly onboarding: ZatcaOnboardingService,
    // P-C11 — فشل الإرسال إلى زاتكا خبرٌ عاجل: يُعلَن ليُعالَج، لا ليُكتشف في تقرير الشهر.
    private readonly webhooks: WebhookPublisher,
  ) {}

  async upsertCredentials(tenantId: string, input: CredentialInput) {
    if (input.authority === 'eta') throw new DomainError('ETA_NOT_IMPLEMENTED', 'Egypt ETA adapter is configured as a disabled stub in this phase', 501);
    const values = { id: newId(), tenantId, authority: input.authority, environment: input.environment, csr: input.csr, privateKeyEnc: input.privateKey ? encryptSecret(input.privateKey) : null, csidEnc: input.csid ? encryptSecret(input.csid) : null, secretEnc: input.secret ? encryptSecret(input.secret) : null, org: input.org ?? {}, validFrom: input.validFrom ? new Date(input.validFrom) : null, validTo: input.validTo ? new Date(input.validTo) : null, updatedAt: new Date() };
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(einvoiceCredentials).values(values).onConflictDoUpdate({ target: [einvoiceCredentials.tenantId, einvoiceCredentials.authority, einvoiceCredentials.environment], set: { csr: values.csr, privateKeyEnc: values.privateKeyEnc, csidEnc: values.csidEnc, secretEnc: values.secretEnc, org: values.org, validFrom: values.validFrom, validTo: values.validTo, updatedAt: new Date() } }).returning());
    if (!row) throw new DomainError('EINVOICE_CREDENTIAL_SAVE_FAILED', 'Credential save returned no row', 500);
    return this.maskCredential(row);
  }

  listCredentials(tenantId: string) { return withTenantTx(this.database.db, tenantId, async (tx) => (await tx.select().from(einvoiceCredentials).where(eq(einvoiceCredentials.tenantId, tenantId))).map((row) => this.maskCredential(row))); }
  /** The ledger as a flat list — kept for the screens that page client-side. */
  submissions(tenantId: string, status?: string) { return withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(einvoiceSubmissions).where(and(eq(einvoiceSubmissions.tenantId, tenantId), status ? eq(einvoiceSubmissions.status, status) : undefined)).orderBy(desc(einvoiceSubmissions.createdAt)).limit(100)); }
  health(tenantId: string) { return withTenantTx(this.database.db, tenantId, async (tx) => ({ status: 'ok', credentials: (await tx.select().from(einvoiceCredentials).where(eq(einvoiceCredentials.tenantId, tenantId))).length })); }

  // ── 🧾 الإرسال والتوقيع والسلسلة ────────────────────────────────────────────────────────

  /**
   * 🧾 الفواتير المرفوعة على موقع الضرائب — the paged grid of
   * `Form_WPF/frmSentEinvoice.xaml` (🔍 عرض · حجم الصفحة · رقم الصفحة).
   *
   * Paging is done by the database, not in the browser: a tenant that has filed sixty
   * thousand invoices must not have to send them all to render page 3.
   */
  async filings(tenantId: string, query: { status?: string; from?: string; to?: string; pageNo?: number; pageSize?: number } = {}) {
    const pageSize = clamp(query.pageSize ?? 20, 1, 100);
    const pageNo = clamp(query.pageNo ?? 1, 1, 100_000);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const filters = [
        eq(einvoiceSubmissions.tenantId, tenantId),
        query.status ? eq(einvoiceSubmissions.status, query.status) : undefined,
        query.from ? gte(einvoiceSubmissions.createdAt, new Date(`${query.from}T00:00:00.000Z`)) : undefined,
        query.to ? lte(einvoiceSubmissions.createdAt, new Date(`${query.to}T23:59:59.999Z`)) : undefined,
      ].filter(Boolean);
      const where = and(...filters);
      // The grid of `frmInvsSyncStatusZatca.xaml` shows the invoice, not the submission:
      // رقم الفاتورة · نوع الفاتورة · التاريخ · العميل · الصافي · الفرع · المستخدم. Those
      // live on other tables, so they are joined here — one query per page, not one per row.
      const rows = await tx
        .select({
          submission: einvoiceSubmissions,
          invoiceNumber: salesInvoices.number,
          invoiceKind: salesInvoices.kind,
          invoiceTotal: salesInvoices.total,
          cashCustomerName: salesInvoices.cashCustomerName,
          issuedAt: salesInvoices.postedAt,
          partyName: parties.name,
          branchName: branches.nameAr,
          createdByName: users.fullName,
        })
        .from(einvoiceSubmissions)
        .leftJoin(salesInvoices, eq(salesInvoices.id, einvoiceSubmissions.invoiceId))
        .leftJoin(parties, eq(parties.id, salesInvoices.partyId))
        .leftJoin(branches, eq(branches.id, salesInvoices.branchId))
        .leftJoin(users, eq(users.id, einvoiceSubmissions.createdBy))
        .where(where)
        .orderBy(desc(einvoiceSubmissions.createdAt))
        .limit(pageSize)
        .offset((pageNo - 1) * pageSize);
      const [{ count } = { count: '0' }] = await tx.select({ count: sql<string>`count(*)::text` }).from(einvoiceSubmissions).where(where);
      return {
        items: rows.map((row) => ({
          ...row.submission,
          invoice: {
            number: row.invoiceNumber ?? null,
            kind: row.invoiceKind ?? null,
            total: row.invoiceTotal ?? null,
            issuedAt: row.issuedAt ?? null,
            partyName: row.partyName ?? row.cashCustomerName ?? null,
            branchName: row.branchName ?? null,
            createdByName: row.createdByName ?? null,
          },
        })),
        total: Number(count ?? 0),
        pageNo,
        pageSize,
        pages: Math.max(1, Math.ceil(Number(count ?? 0) / pageSize)),
      };
    });
  }

  /**
   * 📄 بيانات الفاتورة — one filing, with everything needed to inspect it: the document
   * that was sent, the document that came back cleared, the QR decoded back into its tags,
   * and the place the invoice holds in the chain.
   */
  async filing(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx.select().from(einvoiceSubmissions).where(and(eq(einvoiceSubmissions.tenantId, tenantId), eq(einvoiceSubmissions.id, id)));
      if (!row) throw new DomainError('EINVOICE_SUBMISSION_NOT_FOUND', 'Submission was not found', 404);
      const [invoice] = await tx.select().from(salesInvoices).where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, row.invoiceId)));
      const request = (row.requestPayload ?? {}) as Record<string, unknown>;
      const response = (row.response ?? {}) as Record<string, unknown>;
      return {
        submission: row,
        invoice: invoice ? { id: invoice.id, number: invoice.number, kind: invoice.kind, total: invoice.total, taxTotal: invoice.taxTotal, currency: invoice.currency, issuedAt: invoice.postedAt ?? invoice.createdAt ?? null } : null,
        document: {
          xml: typeof request.xml === 'string' ? request.xml : null,
          clearedXml: typeof request.clearedXml === 'string' ? request.clearedXml : null,
          counter: row.chainIndex ?? (typeof request.counter === 'number' ? request.counter : null),
          profile: typeof request.profile === 'string' ? request.profile : null,
          clearance: typeof request.profile === 'string' ? request.profile === 'standard' : null,
        },
        chain: { previousHash: row.previousHash, hash: row.hash },
        qr: { payload: row.qrPayload, tags: this.qrTags(row.qrPayload) },
        authority: { status: row.authorityStatus, errors: messageList(response.errorMessages), warnings: messageList(response.warningMessages), error: row.error, response },
      };
    });
  }

  /** The tenant's place in the chain — the last hash filed and the counter that follows it. */
  async chain(tenantId: string, authority = 'zatca') {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const settings = await this.settingsRow(tx, tenantId, authority);
      const environment = settings ? (settings.simulation ? 'simulation' : 'production') : 'production';
      await this.reserveChain(tx, tenantId, authority, environment);
      const [row] = await tx.select().from(einvoiceChain).where(and(eq(einvoiceChain.tenantId, tenantId), eq(einvoiceChain.authority, authority), eq(einvoiceChain.environment, environment)));
      return {
        authority,
        environment,
        counter: Number(row?.counter ?? 0),
        lastHash: row?.lastHash || GENESIS_PIH,
        nextCounter: Number(row?.counter ?? 0) + 1,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  /**
   * Prepares — and, when the tenant is linked, files — the ZATCA e-invoice for a posted
   * sales invoice.
   *
   * The document is always produced: UBL 2.1 XML from the real invoice, the hash chained
   * onto the previous one, the invoice counter, and the QR. What varies is how far it gets:
   *
   * | tenant state | submission status | invoice `zatca_status` |
   * |---|---|---|
   * | no credentials uploaded | `prepared` | `prepared` |
   * | key uploaded, nothing to authenticate with | `signed` | `signed` |
   * | ⏸ إيقاف الربط | `signed` | `signed` |
   * | linked · simplified (0200000) | `reported` / `failed` | same |
   * | linked · standard (0100000) | `cleared` / `failed` | same |
   *
   * The phase-1 QR (tags 1–5) is valid in every one of those states, so an invoice printed
   * from a tenant that has not finished onboarding still carries a scannable code. What it
   * never does is claim to have been accepted by an authority it never spoke to.
   *
   * `environment`, when the caller passes one, overrides the tenant's saved link for this
   * filing only; otherwise the link saved in «⚙️ إعدادات الربط الضريبي» decides which
   * gateway and which credential pair are used.
   */
  async submitSalesInvoice(tenantId: string, invoiceId: string, authority: 'zatca' | 'eta' = 'zatca', environment?: 'simulation' | 'production') {
    if (authority === 'eta') return this.createEtaStub(tenantId, invoiceId, environment ?? 'simulation');

    const context = await this.onboarding.filingContext(tenantId, authority, environment ? { environment } : undefined);
    const prepared = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [invoice] = await tx.select().from(salesInvoices).where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, invoiceId)));
      if (!invoice || invoice.status !== 'posted') throw new DomainError('EINVOICE_INVOICE_NOT_POSTED', 'Only posted invoices can be submitted', 409);

      // ZATCA rejects a duplicate filing, and the desktop's own re-send would have hit the
      // same wall — it is refused here, where the message can say why.
      const [accepted] = await tx
        .select({ id: einvoiceSubmissions.id })
        .from(einvoiceSubmissions)
        .where(and(eq(einvoiceSubmissions.tenantId, tenantId), eq(einvoiceSubmissions.invoiceId, invoiceId), or(...ACCEPTED.map((status) => eq(einvoiceSubmissions.status, status)))));
      if (accepted) throw new DomainError('EINVOICE_ALREADY_ACCEPTED', ALREADY_ACCEPTED_MESSAGE, 409);

      const document = await this.buildDocument(tx, tenantId, invoice, authority, context.environment);
      const privateKey = context.privateKey;
      const signed = privateKey ? signInvoiceHash(document.invoiceHash, privateKey) : null;
      if (privateKey && !signed) this.logger.warn(`ZATCA private key for tenant ${tenantId} (${context.environment}) could not sign — filing unsigned`);

      const qrPayload = buildQrPayload({
        sellerName: document.seller.nameAr,
        vatNo: document.seller.vatNo ?? '',
        timestamp: document.issuedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        grandTotal: Number(invoice.total ?? 0).toFixed(2),
        vatTotal: Number(invoice.taxTotal ?? 0).toFixed(2),
        invoiceHash: signed ? document.invoiceHash : undefined,
        signature: signed?.signature,
        publicKeyDer: signed?.publicKeyDer,
      });

      const status = signed ? 'signed' : 'prepared';
      const submissionUuid = newId();
      const requestPayload: Record<string, unknown> = { xml: document.xml, counter: document.counter, profile: document.profile };
      if (document.referenceNumber) requestPayload.referenceNumber = document.referenceNumber;
      const [submission] = await tx
        .insert(einvoiceSubmissions)
        .values({
          id: newId(),
          tenantId,
          invoiceId,
          authority,
          // المُستخدم الذي أرسل — the grid's «المستخدم» column, and the audit trail of who
          // filed what. Read from the request context, as the inventory service does.
          createdBy: getRequestContext().tenant?.userId ?? null,
          environment: context.environment,
          status,
          uuid: submissionUuid,
          hash: document.invoiceHash,
          previousHash: document.previousHash,
          chainIndex: document.counter,
          qrPayload,
          requestPayload,
          response: {
            submitted: false,
            signed: Boolean(signed),
            curve: signed?.curve ?? null,
            phase1Qr: true,
            gateway: context.gateway.kind,
            credential: context.credentialKind,
          },
          attempts: '0',
        })
        .returning();
      if (!submission) throw new DomainError('EINVOICE_SUBMISSION_FAILED', 'Submission insert returned no row', 500);

      await tx
        .update(salesInvoices)
        .set({ zatcaUuid: submissionUuid, zatcaHash: document.invoiceHash, zatcaQr: qrPayload, zatcaStatus: status, updatedAt: new Date() })
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, invoiceId)));

      return { submission, xml: document.xml, profile: document.profile };
    });

    return this.fileWithAuthority(tenantId, prepared.submission, prepared.xml, prepared.profile, context);
  }

  /**
   * Hands the prepared document to the authority.
   *
   * `0100000` (standard, the buyer has a VAT number) is **cleared**; `0200000` (simplified)
   * is **reported** — the switch the desktop hides inside `CallReportingAPI`
   * (`ZatcaService.cs` L386-L405). A cleared invoice comes back as a re-signed document,
   * and per L390-L392 that document — not ours — is what is stored, with the QR read out
   * of it.
   *
   * Nothing here is mocked: with no CSID pair the method returns the prepared submission
   * untouched, which is the honest description of what happened.
   */
  private async fileWithAuthority(
    tenantId: string,
    submission: typeof einvoiceSubmissions.$inferSelect,
    xml: string,
    profile: string,
    context: FilingContext,
  ) {
    const clearance = profile === 'standard';
    // Two different resting places, and the difference matters: an unsigned document is one
    // the tenant has not enabled yet, while a signed one with nothing to authenticate with is
    // a tenant that stopped halfway through the ladder.
    if (!context.privateKey) {
      return this.recordStop(tenantId, submission, 'NO_CREDENTIALS', 'لم تُرفع بيانات الاعتماد (مفتاح وشهادة ZATCA) بعد — الفاتورة مُجهَّزة ورمز QR للمرحلة الأولى صالح.');
    }
    if (!context.settings.active) {
      return this.recordStop(tenantId, submission, 'LINK_PAUSED', LINK_PAUSED_MESSAGE);
    }
    if (!context.csid || !context.secret) {
      // The desktop's `LoadZatcaCredential` reads `P_CSID`/`P_Secret`; with no CSID there is
      // no way to authenticate as this taxpayer, so nothing is dialled and nothing is claimed.
      return this.recordStop(tenantId, submission, 'NO_GATEWAY_CONFIGURED', 'لا توجد شهادة (CSID) للإرسال بها — أكمل «🔐 حفظ مفتاح التشفير» أولاً.');
    }

    const outcome = await fileInvoice(context.gateway, { csid: context.csid, secret: context.secret }, {
      invoiceHash: submission.hash ?? '',
      uuid: String(submission.uuid ?? submission.id),
      invoice: Buffer.from(xml, 'utf8').toString('base64'),
      clearance,
      qr: submission.qrPayload,
    });

    const accepted = outcome.status !== 'failed';
    const recorded = await this.recordOutcome(tenantId, submission.id, submission.invoiceId, {
      status: outcome.status,
      authorityStatus: outcome.authorityStatus || null,
      clearedInvoice: outcome.clearedInvoice,
      clearedXml: outcome.clearedXml,
      qr: outcome.qr,
      environment: context.environment,
      response: {
        submitted: true,
        gateway: context.gateway.kind,
        endpoint: outcome.endpoint,
        durationMs: outcome.durationMs,
        clearance,
        profile,
        credential: context.credentialKind,
        errorMessages: outcome.errors,
        warningMessages: outcome.warnings,
      },
      error: accepted ? null : (outcome.errors[0] ?? outcome.authorityStatus ?? 'FAILED'),
    });
    if (!accepted) {
      // P-C11 — `einvoice.submission_failed`: رفضٌ يحتاج تدخّلاً، فيُعلَن ولا يُنتظر تقرير.
      void this.webhooks.emit('einvoice.submission_failed', tenantId, {
        invoiceId: submission.invoiceId,
        submissionId: submission.id,
        authority: 'zatca',
        environment: context.environment,
        status: outcome.status,
        error: outcome.errors[0] ?? outcome.authorityStatus ?? 'FAILED',
      });
    }
    return recorded;
  }

  /** A filing that never left: the document keeps the status it earned and says why it stopped. */
  private async recordStop(tenantId: string, submission: typeof einvoiceSubmissions.$inferSelect, reason: string, message: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx
        .update(einvoiceSubmissions)
        .set({ response: { ...(submission.response ?? {}), submitted: false, reason, message }, error: null, updatedAt: new Date() })
        .where(and(eq(einvoiceSubmissions.tenantId, tenantId), eq(einvoiceSubmissions.id, submission.id)))
        .returning();
      return row!;
    });
  }

  private async recordOutcome(
    tenantId: string,
    submissionId: string,
    invoiceId: string,
    outcome: { status: string; authorityStatus: string | null; clearedInvoice?: string | null; clearedXml?: string | null; qr?: string | null; environment?: string; response: Record<string, unknown>; error: string | null },
  ) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [current] = await tx.select().from(einvoiceSubmissions).where(and(eq(einvoiceSubmissions.tenantId, tenantId), eq(einvoiceSubmissions.id, submissionId)));
      const request = { ...((current?.requestPayload ?? {}) as Record<string, unknown>), ...(outcome.clearedXml ? { clearedXml: outcome.clearedXml } : {}) };
      const qr = outcome.qr ?? current?.qrPayload ?? null;
      const [row] = await tx
        .update(einvoiceSubmissions)
        .set({
          status: outcome.status,
          authorityStatus: outcome.authorityStatus,
          ...(outcome.environment ? { environment: outcome.environment } : {}),
          clearedInvoice: outcome.clearedInvoice ?? null,
          qrPayload: qr,
          requestPayload: request,
          response: outcome.response,
          error: outcome.error,
          attempts: sql`(attempts::int + 1)::text`,
          submittedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(einvoiceSubmissions.tenantId, tenantId), eq(einvoiceSubmissions.id, submissionId)))
        .returning();
      // The desktop wrote the QR, the hash and the UUID onto the invoice row in the same
      // breath (`update Inv set QRCode=…, InvoiceHash=…, UUID=…, ZatcaSent=…`), and the
      // printed invoice is the one that carries them.
      await tx
        .update(salesInvoices)
        .set({ zatcaStatus: outcome.status, zatcaQr: qr, updatedAt: new Date() })
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, invoiceId)));
      return row!;
    });
  }

  /** Assembles the UBL document, its place in the hash chain and its counter value. */
  private async buildDocument(
    tx: DrizzleTx,
    tenantId: string,
    invoice: typeof salesInvoices.$inferSelect,
    authority: string,
    environment: string,
  ) {
    const lines = await tx.select().from(salesInvoiceLines).where(and(eq(salesInvoiceLines.tenantId, tenantId), eq(salesInvoiceLines.invoiceId, invoice.id))).orderBy(asc(salesInvoiceLines.lineNo));
    const names = await tx.execute(sql`
      SELECT l.id AS line_id, COALESCE(l.description, i.name_ar) AS label, u.code AS unit_code
        FROM sales_invoice_lines l
        LEFT JOIN items i ON i.id = l.item_id
        LEFT JOIN units_of_measure u ON u.id = i.base_unit_id
       WHERE l.tenant_id = ${tenantId} AND l.invoice_id = ${invoice.id}
    `);
    const labels = new Map<string, { label: string; unitCode: string }>();
    for (const row of rowsOf(names)) labels.set(String(row.line_id), { label: String(row.label ?? 'صنف'), unitCode: String(row.unit_code ?? 'PCE') });

    const seller = await this.sellerParty(tx, tenantId);
    const buyer = await this.buyerParty(tx, tenantId, invoice);
    const { previousHash, counter } = await this.nextChainSlot(tx, tenantId, authority, environment);
    // A credit or debit note has to name the invoice it corrects, or ZATCA cannot match it
    // to the original — the desktop's `billingReference.InvoiceDocumentReferenceID = ReffNo`.
    const referenceNumber = await this.referenceNumber(tx, tenantId, invoice);

    const documentLines: ZatcaLine[] = lines.map((line) => ({
      lineNo: line.lineNo,
      name: labels.get(line.id)?.label ?? line.description ?? 'صنف',
      unitCode: labels.get(line.id)?.unitCode ?? 'PCE',
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      net: line.net,
      discount: line.discountAmount,
      tax: line.tax,
      taxRate: line.taxRate,
    }));

    const profile: 'standard' | 'simplified' = buyer?.vatNo ? 'standard' : 'simplified';
    const issuedAt = invoice.postedAt ?? invoice.createdAt ?? new Date();
    const xml = buildInvoiceXml({
      number: invoice.number ?? invoice.id,
      uuid: invoice.id,
      issuedAt,
      kind: invoice.kind,
      profile,
      currency: invoice.currency || 'SAR',
      seller,
      buyer: buyer ?? undefined,
      lines: documentLines,
      invoiceDiscount: invoice.invoiceDiscount,
      subtotal: invoice.subtotal,
      taxTotal: invoice.taxTotal,
      total: invoice.total,
      paymentMeansCode: Number(invoice.paidTotal ?? 0) > 0 ? '10' : '30',
      counter,
      previousHash,
      referenceNumber,
    });
    const invoiceHash = hashInvoiceXml(xml);
    // The chain moves forward only once the document exists: the next invoice's PIH is this
    // hash, and its ICV is this counter plus one.
    await tx
      .update(einvoiceChain)
      .set({ lastHash: invoiceHash, counter, updatedAt: new Date() })
      .where(and(eq(einvoiceChain.tenantId, tenantId), eq(einvoiceChain.authority, authority), eq(einvoiceChain.environment, environment)));
    return { xml, invoiceHash, previousHash, counter, profile, seller, buyer, issuedAt, referenceNumber };
  }

  private async sellerParty(tx: DrizzleTx, tenantId: string): Promise<ZatcaParty> {
    const profile = rowsOf(await tx.execute(sql`SELECT name_ar, name_en, tax_no, cr_no, address FROM company_profiles WHERE tenant_id = ${tenantId}`))[0];
    const tenant = rowsOf(await tx.execute(sql`SELECT name FROM tenants WHERE id = ${tenantId}`))[0];
    const address = (profile?.address ?? {}) as Record<string, string | undefined>;
    return {
      nameAr: String(profile?.name_ar ?? tenant?.name ?? 'المنشأة'),
      nameEn: profile?.name_en ? String(profile.name_en) : undefined,
      vatNo: profile?.tax_no ? String(profile.tax_no) : undefined,
      crNo: profile?.cr_no ? String(profile.cr_no) : undefined,
      ...nationalAddress(address),
    };
  }

  private async buyerParty(tx: DrizzleTx, tenantId: string, invoice: typeof salesInvoices.$inferSelect): Promise<ZatcaParty | null> {
    if (!invoice.partyId) return invoice.cashCustomerName ? { nameAr: invoice.cashCustomerName } : null;
    const party = rowsOf(await tx.execute(sql`SELECT name, tax_no, address FROM parties WHERE tenant_id = ${tenantId} AND id = ${invoice.partyId}`))[0];
    if (!party) return null;
    const address = (party.address ?? {}) as Record<string, string | undefined>;
    return {
      nameAr: String(party.name ?? ''),
      vatNo: party.tax_no ? String(party.tax_no) : undefined,
      ...nationalAddress(address),
    };
  }

  /** The number of the invoice a credit/debit note corrects — `ReffNo` in the desktop. */
  private async referenceNumber(tx: DrizzleTx, tenantId: string, invoice: typeof salesInvoices.$inferSelect): Promise<string | undefined> {
    if (!invoice.referenceInvoiceId) return undefined;
    const [source] = await tx
      .select({ number: salesInvoices.number })
      .from(salesInvoices)
      .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, invoice.referenceInvoiceId)));
    return source?.number ?? undefined;
  }

  /**
   * Reserves the next link in the chain: the previous invoice's hash and the next counter,
   * taken under `FOR UPDATE` so two invoices filed at once cannot share an ICV.
   */
  private async nextChainSlot(tx: DrizzleTx, tenantId: string, authority: string, environment: string) {
    await this.reserveChain(tx, tenantId, authority, environment);
    const [chain] = await tx.select().from(einvoiceChain).where(and(eq(einvoiceChain.tenantId, tenantId), eq(einvoiceChain.authority, authority), eq(einvoiceChain.environment, environment))).for('update');
    return { previousHash: chain?.lastHash || GENESIS_PIH, counter: Number(chain?.counter ?? 0) + 1 };
  }

  private async reserveChain(tx: DrizzleTx, tenantId: string, authority: string, environment: string) {
    await tx.execute(sql`INSERT INTO einvoice_chain (tenant_id, authority, environment, last_hash, counter, updated_at) VALUES (${tenantId}, ${authority}, ${environment}, '', 0, now()) ON CONFLICT (tenant_id, authority, environment) DO NOTHING`);
  }

  private async settingsRow(tx: DrizzleTx, tenantId: string, authority: string) {
    const [row] = await tx.select().from(einvoiceSettings).where(and(eq(einvoiceSettings.tenantId, tenantId), eq(einvoiceSettings.authority, authority)));
    return row ?? null;
  }

  /**
   * Re-files a submission that failed. The document is not rebuilt — the hash must not move,
   * or the chain behind it stops matching.
   */
  async retry(tenantId: string, submissionId: string) {
    const context = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx.select().from(einvoiceSubmissions).where(and(eq(einvoiceSubmissions.tenantId, tenantId), eq(einvoiceSubmissions.id, submissionId)));
      if (!row) throw new DomainError('EINVOICE_SUBMISSION_NOT_FOUND', 'Submission was not found', 404);
      if (row.authority === 'eta') throw new DomainError('ETA_NOT_IMPLEMENTED', 'ETA retry path is disabled', 501);
      if (ACCEPTED.includes(row.status)) throw new DomainError('EINVOICE_ALREADY_ACCEPTED', 'هذه الفاتورة مقبولة لدى الهيئة — لا تُعاد.', 409);
      return row;
    });
    // Re-filed with the link as it is *now*, not as it was when the document was built: a
    // tenant that fixed its settings and pressed إعادة الإرسال expects the fixed settings.
    const filingContext = await this.onboarding.filingContext(tenantId, context.authority);
    const xml = String((context.requestPayload as Record<string, unknown>).xml ?? '');
    if (!xml) throw new DomainError('EINVOICE_SUBMISSION_NOT_FOUND', 'Submission has no stored document to re-file', 409);
    const profile = String((context.requestPayload as Record<string, unknown>).profile ?? 'simplified');
    return this.fileWithAuthority(tenantId, context, xml, profile, filingContext);
  }

  // ── 📊 حالة المزامنة — `frmInvsSyncStatusZatca.xaml` ──────────────────────────────────────

  /**
   * 🔄 مزامنة ZATCA — `btnSync_Click` (L392-L412) and `SendZatcaAsync` (L442-L565).
   *
   * The desktop asks «هل انت متأكد من مزامنة الفواتير المختارة ؟», then walks the rows the
   * clerk ticked: `IntegrateInvoice`, `UPDATE Inv SET ZatcaSent=1, InvoiceHash=…` for the
   * ones the authority accepted, and `InsertZatcaResponse` for every one of them — so the
   * window's grid can show «تمت العملية بنجاح ✅» next to the ones that failed.
   *
   * Two differences, both deliberate:
   *
   *   • **A paused link says so.** The desktop's `btnSync_Click` wraps the whole call in
   *     `if (MainSetting.ZatcaIntegerationActive)`, so pressing the button with the link
   *     off does nothing at all — silently. Here every row comes back `skipped` with the
   *     reason, because an operator who pressed a button deserves to know why nothing
   *     happened.
   *   • **An invoice the authority already has is skipped, not re-filed.** The desktop
   *     would send it again and let ZATCA reject the duplicate; part two refuses that
   *     (409 `EINVOICE_ALREADY_ACCEPTED`) and the bulk path reports it per row instead of
   *     aborting the batch.
   */
  async sync(tenantId: string, input: { ids?: string[] } = {}) {
    const ids = [...new Set((input.ids ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
    // «لا توجد صفوف محددة.» — the desktop's own words for an empty selection (L457).
    if (ids.length === 0) throw new DomainError('EINVOICE_SYNC_EMPTY', 'لا توجد صفوف محددة.', 422);
    // A guard the desktop has no need for: it runs on one machine against one database.
    if (ids.length > SYNC_BATCH_LIMIT) throw new DomainError('EINVOICE_SYNC_TOO_MANY', `يمكن مزامنة ${SYNC_BATCH_LIMIT} فاتورة في المرة الواحدة — اختر عدداً أقل.`, 422);

    const context = await this.onboarding.filingContext(tenantId, 'zatca');
    if (!context.settings.active) {
      return this.syncReport(ids, ids.map((invoiceId) => ({ invoiceId, number: null, outcome: 'skipped' as const, status: null, authorityStatus: null, message: LINK_PAUSED_MESSAGE })), context.environment);
    }

    const results: SyncRow[] = [];
    for (const invoiceId of ids) {
      const [invoice] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select({ id: salesInvoices.id, number: salesInvoices.number, status: salesInvoices.status }).from(salesInvoices).where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, invoiceId))));
      if (!invoice) {
        results.push({ invoiceId, number: null, outcome: 'skipped', status: null, authorityStatus: null, message: 'الفاتورة غير موجودة.' });
        continue;
      }
      if (invoice.status !== 'posted') {
        results.push({ invoiceId, number: invoice.number, outcome: 'skipped', status: null, authorityStatus: null, message: 'الفاتورة غير مرحَّلة — لا تُرسل إلا بعد ترحيلها.' });
        continue;
      }
      const [accepted] = await withTenantTx(this.database.db, tenantId, (tx) => tx
        .select({ id: einvoiceSubmissions.id })
        .from(einvoiceSubmissions)
        .where(and(eq(einvoiceSubmissions.tenantId, tenantId), eq(einvoiceSubmissions.invoiceId, invoiceId), or(...ACCEPTED.map((status) => eq(einvoiceSubmissions.status, status))))));
      if (accepted) {
        results.push({ invoiceId, number: invoice.number, outcome: 'skipped', status: null, authorityStatus: null, message: ALREADY_ACCEPTED_MESSAGE });
        continue;
      }

      try {
        const submission = await this.submitSalesInvoice(tenantId, invoiceId, 'zatca');
        if (!submission) {
          results.push({ invoiceId, number: invoice.number, outcome: 'failed', status: null, authorityStatus: null, message: 'لم تُنتَج وثيقة إرسال لهذه الفاتورة.' });
          continue;
        }
        const outcome = ACCEPTED.includes(submission.status) ? 'sent' : submission.status === 'failed' ? 'failed' : 'skipped';
        const response = (submission.response ?? {}) as Record<string, unknown>;
        results.push({
          invoiceId,
          number: invoice.number,
          outcome,
          status: submission.status,
          authorityStatus: submission.authorityStatus ?? null,
          message: submission.error ?? (typeof response.message === 'string' ? response.message : null),
        });
      } catch (error) {
        // One invoice that cannot be filed must not stop the ones behind it — the desktop
        // keeps walking its grid too, and writes the failure on the row that earned it.
        const code = error instanceof DomainError ? error.code : '';
        results.push({
          invoiceId,
          number: invoice.number,
          outcome: code === 'EINVOICE_ALREADY_ACCEPTED' || code === 'EINVOICE_INVOICE_NOT_POSTED' ? 'skipped' : 'failed',
          status: null,
          authorityStatus: null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return this.syncReport(ids, results, context.environment);
  }

  /** The counts and the one line the window shows — «تمت العملية بنجاح ✅» (L563). */
  private syncReport(ids: string[], results: SyncRow[], environment: string) {
    const sent = results.filter((row) => row.outcome === 'sent').length;
    const failed = results.filter((row) => row.outcome === 'failed').length;
    const skipped = results.filter((row) => row.outcome === 'skipped').length;
    const message =
      sent === 0 && failed === 0
        ? 'لم تُرسل أي فاتورة — راجع «الرسالة» أمام كل صف.'
        : sent > 0 && failed === 0
          ? 'تمت العملية بنجاح ✅'
          : `أُرسلت ${sent} من ${ids.length} فاتورة، ولم تُقبل ${failed}. راجع «الرسالة» أمام كل صف.`;
    return { requested: ids.length, sent, failed, skipped, environment, authority: 'zatca', message, results };
  }

  private async createEtaStub(tenantId: string, invoiceId: string, environment: 'simulation' | 'production') { const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(einvoiceSubmissions).values({ id: newId(), tenantId, invoiceId, authority: 'eta', environment, status: 'not_implemented', error: 'ETA adapter is stubbed until certification scope is approved' }).returning()); return row; }

  private qrTags(payload: string | null) {
    if (!payload) return [];
    return decodeQrPayload(payload).map(({ tag, value }) => ({
      tag,
      labelAr: QR_TAG_LABELS[tag] ?? `الوسم ${tag}`,
      // Tags 1–3 and 6 are text; 4–5 are amounts; 7–9 are binary and shown base64.
      value: tag <= 6 ? value.toString('utf8') : value.toString('base64'),
      bytes: value.length,
    }));
  }

  private maskCredential(row: typeof einvoiceCredentials.$inferSelect) { return { ...row, privateKeyEnc: undefined, csidEnc: undefined, secretEnc: undefined, privateKeyMasked: maskEncrypted(row.privateKeyEnc), csidMasked: maskEncrypted(row.csidEnc), secretMasked: maskEncrypted(row.secretEnc) }; }
}

/**
 * Maps our national-address shape (`plot`, `building`, `street`, `district`, `city`, `postal`)
 * onto the UBL element names ZATCA expects.
 */
function nationalAddress(address: Record<string, string | undefined>) {
  return {
    street: address.street,
    buildingNumber: address.building ?? address.plot,
    district: address.district,
    city: address.city,
    postalZone: address.postal,
    countryCode: address.countryCode ?? 'SA',
  };
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

function messageList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function clamp(value: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
