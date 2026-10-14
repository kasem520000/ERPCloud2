import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { env } from '@erp/config';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import {
  esignEvents,
  esignRequests,
  notifications,
  parties,
  supplierInvoiceUploads,
  supplierPortalSessions,
  supplierPortalUsers,
  supplierRfqs,
  tenants,
  withTenantTx,
  withTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { isUniqueViolation } from '../organization/shared/org-support.js';
import { PasswordService, tryGetAuthContext } from '../platform/index.js';
import { MAILER, SequencesService, type MailerPort } from '../platform-services/index.js';

import {
  PortalRuleError,
  acceptSignature,
  assertOwnParty,
  assertSignable,
  loginDecision,
  newOtp,
  newSecret,
  respondToRfq,
  scopeToken,
  sha256,
  signedPdf,
  splitScopedToken,
  type EsignStatus,
} from './supplier-esign.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_HOURS = 12;
const SIGN_DAYS = 7;
const TITLE_MAX = 160;

function ruleMessage(code: string, fallback: string): string {
  switch (code) {
    case 'NOT_FOUND':
      return 'المستند غير موجود';
    case 'RFQ_CLOSED':
      return 'تم الرد على هذا الطلب مسبقاً';
    case 'OFFER_INVALID':
      return 'السعر يجب أن يكون أكبر من صفر';
    case 'ALREADY_SIGNED':
      return 'تم توقيع هذا المستند مسبقاً';
    case 'ESIGN_DECLINED':
      return 'تم رفض طلب التوقيع';
    case 'ESIGN_EXPIRED':
      return 'انتهت صلاحية رابط التوقيع';
    case 'SIGNATURE_REQUIRED':
      return 'ارسم التوقيع قبل الإرسال';
    case 'OTP_INVALID':
      return 'رمز التحقق غير صحيح';
    default:
      return fallback;
  }
}

type SessionUser = { id: string; partyId: string; email: string };

function asDomain<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PortalRuleError) throw new DomainError(error.code, ruleMessage(error.code, error.message), error.status);
    throw error;
  }
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

function bearer(header: string | undefined): string {
  const value = header?.trim() ?? '';
  const token = value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : value;
  if (!splitScopedToken(token)) throw new DomainError(errorCodes.UNAUTHENTICATED, 'جلسة المورد غير صالحة', 401);
  return token;
}

function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(14);
  return `${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join('')}#7`;
}

function asPdf(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string' && value.startsWith('%PDF')) return Buffer.from(value, 'latin1');
  if (typeof value === 'string' && value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex');
  throw new DomainError('NOT_SIGNED', 'المستند غير موقّع بعد', 404);
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

@Injectable()
export class SupplierPortalService {
  private readonly logger = new Logger(SupplierPortalService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(MAILER) private readonly mailer: MailerPort,
    private readonly passwords: PasswordService,
    private readonly sequences: SequencesService,
  ) {}

  async invite(tenantId: string, input: { partyId: string; email: string; password?: string }) {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 200) throw new DomainError('EMAIL_INVALID', 'أدخل بريداً صالحاً', 422);
    const supplied = input.password?.trim() ?? '';
    const secret = supplied || temporaryPassword();
    this.passwords.assertPolicy(secret, { email });
    const passwordHash = await this.passwords.hash(secret);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [party] = await tx
        .select({ id: parties.id, name: parties.name })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.id, input.partyId)));
      if (!party) throw new DomainError('PARTY_NOT_FOUND', 'المورد غير موجود', 404);
      const id = newId();
      try {
        await tx.insert(supplierPortalUsers).values({
          id,
          tenantId,
          partyId: party.id,
          email,
          passwordHash,
          isActive: true,
          createdBy: tryGetAuthContext()?.userId ?? null,
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new DomainError('SUPPLIER_PORTAL_EMAIL_TAKEN', 'هذا البريد مرتبط بمورد في هذه المنشأة', 409);
        throw error;
      }
      const link = this.portalLink();
      await this.mailer
        .send({
          to: email,
          subject: 'دخول بوابة الموردين',
          tenantId,
          text: [
            `مرحباً ${party.name}`,
            '',
            'تم فتح بوابة الموردين لحسابكم.',
            `البريد: ${email}`,
            `كلمة المرور المؤقتة: ${secret}`,
            link ? `الرابط: ${link}` : 'افتح /supplier-portal من نظام المنشأة.',
          ].join('\n'),
        })
        .catch((error: unknown) => {
          this.logger.warn({ tenantId, err: error instanceof Error ? error.message : 'mail' }, 'supplier invite was not delivered');
        });
      return { id, email, partyId: party.id, temporaryPassword: supplied ? null : secret };
    });
  }

  listUsers(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          id: supplierPortalUsers.id,
          partyId: supplierPortalUsers.partyId,
          email: supplierPortalUsers.email,
          isActive: supplierPortalUsers.isActive,
          createdAt: supplierPortalUsers.createdAt,
        })
        .from(supplierPortalUsers)
        .where(eq(supplierPortalUsers.tenantId, tenantId))
        .orderBy(desc(supplierPortalUsers.createdAt))
        .limit(200),
    );
  }

  async createRfq(tenantId: string, input: { partyId: string; title: string; note?: string }) {
    const title = input.title.trim();
    if (!title || title.length > TITLE_MAX) throw new DomainError('RFQ_TITLE_REQUIRED', 'عنوان الطلب مطلوب وأقصره 160 حرفاً', 422);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [party] = await tx
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.id, input.partyId)));
      if (!party) throw new DomainError('PARTY_NOT_FOUND', 'المورد غير موجود', 404);
      const allocated = await this.sequences.next({ tenantId, docType: 'supplier_rfq' }, tx, { prefix: 'RFQ-', padding: 6 });
      const id = newId();
      await tx.insert(supplierRfqs).values({
        id,
        tenantId,
        partyId: party.id,
        number: allocated.display,
        title,
        note: input.note?.trim() ?? '',
        status: 'open',
        createdBy: tryGetAuthContext()?.userId ?? null,
      });
      return { id, number: allocated.display, partyId: party.id, title, status: 'open' };
    });
  }

  listRfqs(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(supplierRfqs).where(eq(supplierRfqs.tenantId, tenantId)).orderBy(desc(supplierRfqs.createdAt)).limit(200),
    );
  }

  listUploads(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(supplierInvoiceUploads)
        .where(eq(supplierInvoiceUploads.tenantId, tenantId))
        .orderBy(desc(supplierInvoiceUploads.createdAt))
        .limit(200),
    );
  }

  async login(input: { tenantCode: string; email: string; password: string }) {
    const tenantCode = input.tenantCode.trim();
    const tenant = await withTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({ id: tenants.id, status: tenants.status })
        .from(tenants)
        .where(sql`lower(${tenants.code}) = lower(${tenantCode})`)
        .limit(1);
      return rows[0];
    });
    if (!tenant || tenant.status !== 'active') {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'بيانات الدخول غير صحيحة', 401);
    }
    return withTenantTx(this.database.db, tenant.id, async (tx) => {
      const email = input.email.trim().toLowerCase();
      const [user] = await tx
        .select()
        .from(supplierPortalUsers)
        .where(and(eq(supplierPortalUsers.tenantId, tenant.id), eq(supplierPortalUsers.email, email)));
      const passwordOk = user ? await this.passwords.verify(user.passwordHash, input.password) : false;
      const decision = loginDecision({ found: Boolean(user), active: Boolean(user?.isActive), passwordOk });
      if (!decision.ok || !user) throw new DomainError(errorCodes.UNAUTHENTICATED, 'بيانات الدخول غير صحيحة', 401);
      const secret = newSecret(32);
      const token = scopeToken(tenant.id, secret);
      const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
      await tx.insert(supplierPortalSessions).values({
        id: newId(),
        tenantId: tenant.id,
        userId: user.id,
        tokenHash: sha256(secret),
        expiresAt,
      });
      return { token, expiresAt: expiresAt.toISOString(), partyId: user.partyId };
    });
  }

  async invoices(authorization: string | undefined) {
    const user = await this.sessionUser(authorization);
    const tenantId = this.tenantOf(authorization);
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      rowsOf(await tx.execute(sql`
        SELECT id, number, status, payment_status AS "paymentStatus", currency, total::text, paid_total::text AS "paidTotal", posted_at AS "postedAt"
          FROM purchase_invoices
         WHERE tenant_id = ${tenantId}::uuid
           AND party_id = ${user.partyId}::uuid
           AND status = 'posted'
         ORDER BY posted_at DESC NULLS LAST
         LIMIT 200
      `)),
    );
  }

  async invoice(authorization: string | undefined, invoiceId: string) {
    const user = await this.sessionUser(authorization);
    const tenantId = this.tenantOf(authorization);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = rowsOf<{ id: string; partyId: string; number: string | null; status: string; currency: string; total: string }>(
        await tx.execute(sql`
          SELECT id, party_id AS "partyId", number, status, currency, total::text
            FROM purchase_invoices
           WHERE tenant_id = ${tenantId}::uuid AND id = ${invoiceId}::uuid
           LIMIT 1
        `),
      );
      asDomain(() => assertOwnParty(rows[0], user.partyId));
      const row = rows[0];
      if (!row || row.status !== 'posted') throw new DomainError('NOT_FOUND', 'المستند غير موجود', 404);
      return { id: row.id, number: row.number, status: row.status, currency: row.currency, total: row.total };
    });
  }

  async payments(authorization: string | undefined) {
    const user = await this.sessionUser(authorization);
    const tenantId = this.tenantOf(authorization);
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      rowsOf(await tx.execute(sql`
        SELECT id, number, date::text AS day, kind, amount::text AS value, currency
          FROM vouchers
         WHERE tenant_id = ${tenantId}::uuid
           AND party_id = ${user.partyId}::uuid
           AND status = 'posted'
           AND kind = 'payment'
         ORDER BY date DESC
         LIMIT 200
      `)),
    );
  }

  async quotations(authorization: string | undefined) {
    const user = await this.sessionUser(authorization);
    const tenantId = this.tenantOf(authorization);
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          id: supplierRfqs.id,
          number: supplierRfqs.number,
          title: supplierRfqs.title,
          note: supplierRfqs.note,
          status: supplierRfqs.status,
          offer: supplierRfqs.offer,
          responseNote: supplierRfqs.responseNote,
        })
        .from(supplierRfqs)
        .where(and(eq(supplierRfqs.tenantId, tenantId), eq(supplierRfqs.partyId, user.partyId)))
        .orderBy(desc(supplierRfqs.createdAt))
        .limit(100),
    );
  }

  async respond(authorization: string | undefined, rfqId: string, input: { offer: string; note: string }) {
    const user = await this.sessionUser(authorization);
    const tenantId = this.tenantOf(authorization);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = rowsOf<{ id: string; status: string; partyId: string }>(await tx.execute(sql`
        SELECT id, status, party_id AS "partyId"
          FROM supplier_rfqs
         WHERE tenant_id = ${tenantId}::uuid AND id = ${rfqId}::uuid
         FOR UPDATE
      `));
      const next = asDomain(() => respondToRfq({ status: rows[0]?.status ?? 'closed', partyId: rows[0]?.partyId ?? '' }, user.partyId, input));
      await tx
        .update(supplierRfqs)
        .set({ status: next.status, offer: next.offer, responseNote: next.note, respondedAt: new Date() })
        .where(and(eq(supplierRfqs.tenantId, tenantId), eq(supplierRfqs.id, rfqId), eq(supplierRfqs.partyId, user.partyId)));
      return { id: rfqId, ...next };
    });
  }

  async uploadInvoice(authorization: string | undefined, input: { referenceNo: string; declaredTotal: string; note?: string }) {
    const user = await this.sessionUser(authorization);
    const tenantId = this.tenantOf(authorization);
    const referenceNo = input.referenceNo.trim();
    if (!referenceNo || referenceNo.length > 80) throw new DomainError('REFERENCE_REQUIRED', 'أدخل رقم فاتورة المورد', 422);
    let declared: Decimal;
    try {
      declared = new Decimal(input.declaredTotal);
      if (!declared.isFinite() || declared.lte(0)) throw new Error('invalid');
    } catch {
      throw new DomainError('DECLARED_TOTAL_INVALID', 'إجمالي الفاتورة يجب أن يكون أكبر من صفر', 422);
    }
    const id = newId();
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.insert(supplierInvoiceUploads).values({
        id,
        tenantId,
        partyId: user.partyId,
        referenceNo,
        declaredTotal: declared.toFixed(4),
        note: input.note?.trim() ?? '',
        status: 'submitted',
      }),
    );
    return { id, referenceNo, declaredTotal: declared.toFixed(4), status: 'submitted' };
  }

  async createEsign(
    tenantId: string,
    input: { entityType: string; entityId: string; signerEmail: string; signerName?: string; message?: string },
  ) {
    const signerEmail = input.signerEmail.trim().toLowerCase();
    if (!EMAIL.test(signerEmail)) throw new DomainError('EMAIL_INVALID', 'أدخل بريد الموقّع', 422);
    if (!['sales_quotation', 'sales_invoice', 'contract'].includes(input.entityType)) {
      throw new DomainError('ENTITY_TYPE_INVALID', 'نوع المستند غير مدعوم', 422);
    }
    const secret = newSecret(48);
    const otp = newOtp();
    const expiresAt = new Date(Date.now() + SIGN_DAYS * 24 * 60 * 60 * 1000);
    const id = newId();
    const actor = tryGetAuthContext();
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      if (input.entityType !== 'contract') await this.assertSalesDocument(tx, tenantId, input.entityType, input.entityId);
      await tx.insert(esignRequests).values({
        id,
        tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        signerName: input.signerName?.trim() ?? '',
        signerEmail,
        tokenHash: sha256(secret),
        otpHash: sha256(otp),
        status: 'sent',
        expiresAt,
        payload: JSON.stringify({ message: input.message?.trim() ?? '' }),
        createdBy: actor?.userId ?? null,
        createdByMembershipId: actor?.membershipId ?? null,
      });
      await tx.insert(esignEvents).values({ id: newId(), tenantId, requestId: id, event: 'sent' });
    });
    const token = scopeToken(tenantId, secret);
    await this.mailer
      .send({
        to: signerEmail,
        subject: 'طلب توقيع',
        tenantId,
        text: ['لديكم مستند بانتظار التوقيع.', `الرمز: ${otp}`, `الرابط: ${this.signLink(token)}`, 'الرابط صالح لسبعة أيام.'].join('\n'),
      })
      .catch((error: unknown) => {
        this.logger.warn({ tenantId, err: error instanceof Error ? error.message : 'mail' }, 'signature mail was not delivered');
      });
    return {
      id,
      status: 'sent',
      expiresAt: expiresAt.toISOString(),
      token,
      previewOtp: env.MAIL_TRANSPORT === 'console' ? otp : undefined,
    };
  }

  listEsign(tenantId: string, entityId?: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          id: esignRequests.id,
          entityType: esignRequests.entityType,
          entityId: esignRequests.entityId,
          signerEmail: esignRequests.signerEmail,
          signerName: esignRequests.signerName,
          status: esignRequests.status,
          signedAt: esignRequests.signedAt,
          expiresAt: esignRequests.expiresAt,
          signedFileId: esignRequests.signedFileId,
        })
        .from(esignRequests)
        .where(and(eq(esignRequests.tenantId, tenantId), entityId ? eq(esignRequests.entityId, entityId) : undefined))
        .orderBy(desc(esignRequests.createdAt))
        .limit(100),
    );
  }

  async viewEsign(token: string, ip?: string) {
    const parsed = splitScopedToken(token);
    if (!parsed) throw new DomainError('NOT_FOUND', 'رابط التوقيع غير موجود', 404);
    return withTenantTx(this.database.db, parsed.tenantId, async (tx) => {
      const request = await this.lockEsign(tx, parsed.tenantId, parsed.secret);
      if (request.status === 'declined') throw new DomainError('ESIGN_DECLINED', 'تم رفض طلب التوقيع', 409);
      if (request.status !== 'signed') {
        asDomain(() => assertSignable({ status: request.status, expiresAt: iso(request.expiresAt) }, new Date()));
        if (request.status === 'sent') {
          await tx
            .update(esignRequests)
            .set({ status: 'viewed' })
            .where(and(eq(esignRequests.tenantId, parsed.tenantId), eq(esignRequests.id, request.id)));
          await tx.insert(esignEvents).values({ id: newId(), tenantId: parsed.tenantId, requestId: request.id, event: 'viewed', ip: ip ?? null });
        }
      }
      return this.publicDocument(tx, parsed.tenantId, request);
    });
  }

  async signEsign(token: string, input: { signatureData: string; otp: string }, ip?: string) {
    const parsed = splitScopedToken(token);
    if (!parsed) throw new DomainError('NOT_FOUND', 'رابط التوقيع غير موجود', 404);
    if (input.signatureData.length > 150_000) throw new DomainError('SIGNATURE_TOO_LARGE', 'التوقيع أكبر من الحد المسموح', 422);
    return withTenantTx(this.database.db, parsed.tenantId, async (tx) => {
      const request = await this.lockEsign(tx, parsed.tenantId, parsed.secret);
      asDomain(() => assertSignable({ status: request.status, expiresAt: iso(request.expiresAt) }, new Date()));
      asDomain(() => acceptSignature({ otp: input.otp, expectedOtpHash: request.otpHash, signatureData: input.signatureData }));
      const signedAt = new Date();
      const fileId = newId();
      const pdf = signedPdf({ number: request.entityId.slice(0, 8), signer: request.signerEmail, signedAt: signedAt.toISOString() });
      await tx
        .update(esignRequests)
        .set({
          status: 'signed',
          signedAt,
          signedFileId: fileId,
          signedPdf: pdf,
          ip: ip ?? null,
          payload: JSON.stringify({
            message: this.messageOf(request.payload),
            signatureData: input.signatureData.slice(0, 100_000),
          }),
        })
        .where(and(eq(esignRequests.tenantId, parsed.tenantId), eq(esignRequests.id, request.id)));
      await tx.insert(esignEvents).values({ id: newId(), tenantId: parsed.tenantId, requestId: request.id, event: 'signed', ip: ip ?? null });
      if (request.entityType === 'sales_quotation') {
        await tx.execute(sql`
          UPDATE sales_invoices
             SET status = 'signed', updated_at = now()
           WHERE tenant_id = ${parsed.tenantId}::uuid
             AND id = ${request.entityId}::uuid
             AND kind = 'quotation'
             AND status = 'draft'
        `);
      }
      if (request.createdByMembershipId) {
        await tx.insert(notifications).values({
          id: newId(),
          tenantId: parsed.tenantId,
          membershipId: request.createdByMembershipId,
          type: 'esign.signed',
          payload: { requestId: request.id, entityId: request.entityId, signerEmail: request.signerEmail },
        });
      }
      return { status: 'signed' as const, signedFileId: fileId, signedAt: signedAt.toISOString() };
    });
  }

  async signedPdfOf(token: string) {
    const parsed = splitScopedToken(token);
    if (!parsed) throw new DomainError('NOT_FOUND', 'رابط التوقيع غير موجود', 404);
    return withTenantTx(this.database.db, parsed.tenantId, async (tx) => {
      const request = await this.lockEsign(tx, parsed.tenantId, parsed.secret);
      if (request.status !== 'signed') throw new DomainError('NOT_SIGNED', 'المستند غير موقّع بعد', 404);
      return asPdf(request.signedPdf);
    });
  }

  private tenantOf(authorization: string | undefined) {
    const parsed = splitScopedToken(bearer(authorization));
    if (!parsed) throw new DomainError(errorCodes.UNAUTHENTICATED, 'جلسة المورد غير صالحة', 401);
    return parsed.tenantId;
  }

  private async sessionUser(authorization: string | undefined): Promise<SessionUser> {
    const parsed = splitScopedToken(bearer(authorization));
    if (!parsed) throw new DomainError(errorCodes.UNAUTHENTICATED, 'جلسة المورد غير صالحة', 401);
    return withTenantTx(this.database.db, parsed.tenantId, async (tx) => {
      const rows = rowsOf<{ id: string; partyId: string; email: string; expiresAt: Date; isActive: boolean }>(await tx.execute(sql`
        SELECT u.id, u.party_id AS "partyId", u.email, s.expires_at AS "expiresAt", u.is_active AS "isActive"
          FROM supplier_portal_sessions s
          JOIN supplier_portal_users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
         WHERE s.tenant_id = ${parsed.tenantId}::uuid
           AND s.token_hash = ${sha256(parsed.secret)}
         LIMIT 1
      `));
      const row = rows[0];
      if (!row || !row.isActive || new Date(row.expiresAt).getTime() <= Date.now()) {
        throw new DomainError(errorCodes.UNAUTHENTICATED, 'انتهت جلسة المورد', 401);
      }
      return { id: row.id, partyId: row.partyId, email: row.email };
    });
  }

  private async lockEsign(tx: DrizzleTx, tenantId: string, secret: string) {
    const rows = rowsOf<{
      id: string;
      entityType: string;
      entityId: string;
      signerName: string;
      signerEmail: string;
      status: EsignStatus;
      expiresAt: string | Date;
      otpHash: string;
      payload: string;
      signedPdf: Buffer | null;
      createdByMembershipId: string | null;
    }>(await tx.execute(sql`
      SELECT id, entity_type AS "entityType", entity_id AS "entityId", signer_name AS "signerName",
             signer_email AS "signerEmail", status, expires_at AS "expiresAt", otp_hash AS "otpHash",
             payload, signed_pdf AS "signedPdf", created_by_membership_id AS "createdByMembershipId"
        FROM esign_requests
       WHERE tenant_id = ${tenantId}::uuid AND token_hash = ${sha256(secret)}
       FOR UPDATE
    `));
    const request = rows[0];
    if (!request) throw new DomainError('NOT_FOUND', 'رابط التوقيع غير موجود', 404);
    return request;
  }

  private async publicDocument(
    tx: DrizzleTx,
    tenantId: string,
    request: {
      entityType: string;
      entityId: string;
      signerName: string;
      status: string;
      expiresAt: string | Date;
      payload: string;
    },
  ) {
    const company = rowsOf<{ name_ar: string | null }>(
      await tx.execute(sql`SELECT name_ar FROM company_profiles WHERE tenant_id = ${tenantId}::uuid LIMIT 1`),
    )[0];
    const document =
      request.entityType === 'contract'
        ? null
        : rowsOf<{ number: string | null; total: string; currency: string; kind: string }>(await tx.execute(sql`
            SELECT number, total::text, currency, kind
              FROM sales_invoices
             WHERE tenant_id = ${tenantId}::uuid AND id = ${request.entityId}::uuid
             LIMIT 1
          `))[0];
    const lines = document
      ? rowsOf(
          await tx.execute(sql`
            SELECT line_no AS "lineNo", coalesce(description, '') AS description, quantity::text, total::text
              FROM sales_invoice_lines
             WHERE tenant_id = ${tenantId}::uuid AND invoice_id = ${request.entityId}::uuid
             ORDER BY line_no
          `),
        )
      : [];
    return {
      companyName: company?.name_ar ?? '',
      signerName: request.signerName,
      status: request.status === 'sent' ? 'viewed' : request.status,
      expiresAt: iso(request.expiresAt),
      message: this.messageOf(request.payload),
      document: document
        ? { number: document.number, total: document.total, currency: document.currency, kind: document.kind, lines }
        : null,
    };
  }

  private async assertSalesDocument(tx: DrizzleTx, tenantId: string, entityType: string, entityId: string) {
    const kind = entityType === 'sales_quotation' ? 'quotation' : 'sale';
    const rows = rowsOf<{ id: string }>(await tx.execute(sql`
      SELECT id FROM sales_invoices
       WHERE tenant_id = ${tenantId}::uuid AND id = ${entityId}::uuid AND kind = ${kind}
       LIMIT 1
    `));
    if (!rows[0]) throw new DomainError('NOT_FOUND', 'المستند غير موجود', 404);
  }

  private messageOf(payload: string) {
    try {
      const parsed = JSON.parse(payload) as { message?: string };
      return parsed.message ?? '';
    } catch {
      return '';
    }
  }

  private portalLink() {
    const base = process.env.STAFF_PUBLIC_URL || env.STAFF_PUBLIC_URL;
    return base ? `${base.replace(/\/$/, '')}/supplier-portal` : '';
  }

  private signLink(token: string) {
    const base = process.env.STAFF_PUBLIC_URL || env.STAFF_PUBLIC_URL;
    const path = `/esign/${token}`;
    return base ? `${base.replace(/\/$/, '')}${path}` : path;
  }
}
