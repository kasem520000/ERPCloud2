import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { env } from '@erp/config';
import { DomainError, newId } from '@erp/contracts';
import { companyProfiles, memberships, membershipRoles, parties, paymentLinks, portalAccounts, roles, salesInvoices, users, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';
import { Decimal } from 'decimal.js';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { PasswordService } from '../platform/auth/password.service.js';
import { MAILER, type MailerPort } from '../platform-services/notifications/mailer.js';
import { PrintTemplatesService } from '../reporting/print-templates.service.js';

/** The role every portal login gets: a real membership with an empty permission set. */
export const PORTAL_ROLE_NAME = 'Customer portal';

export type PortalGrantInput = {
  email: string;
  fullName?: string;
  password?: string;
  /** E-mail the credentials to the customer (only meaningful when a password was generated). */
  notify?: boolean;
};

/**
 * Customer self-service.
 *
 * Two audiences share this service. The back office grants and revokes portal access from
 * بطاقة عميل; the customer themself reads their own documents. Everything the customer can
 * reach is derived from `portal_accounts.party_id` — never from a parameter they send — so a
 * buyer cannot walk the tenant's ledger by changing an id in the URL.
 */
@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(MAILER) private readonly mailer: MailerPort,
    private readonly passwords: PasswordService,
    private readonly print: PrintTemplatesService,
  ) {}

  // ------------------------------------------------------------------ back office

  /** Portal logins for one customer, or for the whole tenant when `partyId` is omitted. */
  async listAccess(tenantId: string, partyId?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT pa.id, pa.party_id, p.name AS party_name, p.code AS party_code, pa.status, pa.invited_at, pa.last_seen_at,
                 u.email, u.full_name, u.status AS user_status, u.last_login_at, u.must_change_password
            FROM portal_accounts pa
            JOIN users u ON u.id = pa.user_id
            JOIN parties p ON p.id = pa.party_id
           WHERE pa.tenant_id = ${tenantId} AND (${partyId ?? null}::uuid IS NULL OR pa.party_id = ${partyId ?? null}::uuid)
           ORDER BY p.name, pa.invited_at
        `),
      ),
    );
  }

  /**
   * Creates (or links) a login for a customer.
   *
   * A generated password is returned **once** — it is never stored in readable form and the
   * account is flagged `mustChangePassword`, so the back office hands it over and the customer
   * replaces it on first sign-in.
   */
  async grantAccess(tenantId: string, actorUserId: string, partyId: string, input: PortalGrantInput) {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new DomainError('VALIDATION_FAILED', 'A valid e-mail is required', 422);

    const party = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId)));
      return row;
    });
    if (!party) throw new DomainError('NOT_FOUND', 'Party was not found', 404);

    const generated = input.password ?? generatePassword();
    const passwordHash = await this.passwords.hash(generated);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [existing] = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(eq(users.email, email)).limit(1);
      let userId = existing?.id ?? '';
      if (!existing) {
        userId = newId();
        await tx.insert(users).values({
          id: userId,
          email,
          fullName: input.fullName?.trim() || party.name,
          status: 'active',
          passwordHash,
          mustChangePassword: true,
          createdAt: new Date(),
          createdBy: actorUserId,
        });
      } else if (input.password) {
        await tx.update(users).set({ passwordHash, mustChangePassword: true, updatedAt: new Date() }).where(eq(users.id, userId));
      }

      const [alreadyLinked] = await tx.select().from(portalAccounts).where(and(eq(portalAccounts.tenantId, tenantId), eq(portalAccounts.userId, userId)));
      if (alreadyLinked) {
        if (alreadyLinked.partyId !== partyId) throw new DomainError('PORTAL_ACCOUNT_TAKEN', 'This e-mail already has portal access to another customer', 409);
        throw new DomainError('PORTAL_ACCOUNT_EXISTS', 'This e-mail already has portal access to this customer', 409);
      }

      const roleId = await this.portalRoleId(tx, tenantId, actorUserId);
      const [membership] = await tx.select().from(memberships).where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
      const membershipId = membership?.id ?? newId();
      if (!membership) {
        await tx.insert(memberships).values({
          id: membershipId,
          tenantId,
          userId,
          displayName: input.fullName?.trim() || party.name,
          status: 'active',
          isOwner: false,
          // External-customer audience: denied on every `@RequiresPermission` route
          // by `PermissionsGuard`, whatever roles the row may carry.
          kind: 'portal',
          createdAt: new Date(),
          createdBy: actorUserId,
        });
        await tx.insert(membershipRoles).values({ membershipId, roleId });
      } else if (membership.kind !== 'portal') {
        // An existing staff membership promoted to portal access becomes portal-only:
        // one login, one audience — a buyer must never double as back-office staff.
        await tx.update(memberships).set({ kind: 'portal' }).where(eq(memberships.id, membership.id));
      }

      const id = newId();
      await tx.insert(portalAccounts).values({ id, tenantId, partyId, userId, status: 'active', invitedAt: new Date(), createdAt: new Date(), createdBy: actorUserId });
      // The password is echoed only when this call generated it; a caller-supplied one is theirs already.
      return { id, partyId, email, status: 'active', temporaryPassword: input.password ? null : generated };
    }).then(async (result) => {
      // Best-effort: a failed e-mail must never roll back a working grant — the password is
      // in the API response and the back office can hand it over manually.
      if (result.temporaryPassword && input.notify !== false) {
        await this.sendInviteEmail(tenantId, email, party.name, result.temporaryPassword).catch((error) => {
          this.logger.warn({ tenantId, partyId, err: error instanceof Error ? error.message : String(error) }, 'portal invite e-mail was not delivered');
        });
      }
      return result;
    });
  }

  private async sendInviteEmail(tenantId: string, email: string, partyName: string, temporaryPassword: string): Promise<void> {
    // Live read: tests set CUSTOMER_PUBLIC_URL per file after @erp/config was cached.
    const publicUrl = process.env.CUSTOMER_PUBLIC_URL || env.CUSTOMER_PUBLIC_URL;
    const portalLink = publicUrl ? `\nرابط البوابة: ${publicUrl}\n` : '';
    await this.mailer.send({
      to: email,
      subject: 'بيانات الدخول إلى بوابة العملاء',
      tenantId,
      text: [
        `مرحباً،`,
        ``,
        `تم إنشاء حساب لكم في بوابة العملاء الخاصة بـ «${partyName}».`,
        `يمكنكم من خلالها متابعة فواتيركم وكشف حسابكم ومدفوعاتكم وطباعة الفواتير.`,
        ``,
        `البريد الإلكتروني: ${email}`,
        `كلمة المرور المؤقتة: ${temporaryPassword}`,
        ``,
        `سيُطلب منكم تغيير كلمة المرور عند أول تسجيل دخول.`,
        portalLink,
        `مع التحية،`,
        `نظام المحاسبة السحابي`,
      ].join('\n'),
    });
  }

  async setAccessStatus(tenantId: string, id: string, status: 'active' | 'suspended') {
    if (status !== 'active' && status !== 'suspended') throw new DomainError('VALIDATION_FAILED', 'Unknown portal account status', 422);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx.update(portalAccounts).set({ status, updatedAt: new Date() }).where(and(eq(portalAccounts.tenantId, tenantId), eq(portalAccounts.id, id))).returning();
      if (!row) throw new DomainError('NOT_FOUND', 'Portal account was not found', 404);
      return row;
    });
  }

  /** Revoking access removes the link and the membership; the `users` row survives on purpose. */
  async revokeAccess(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx.select().from(portalAccounts).where(and(eq(portalAccounts.tenantId, tenantId), eq(portalAccounts.id, id)));
      if (!row) throw new DomainError('NOT_FOUND', 'Portal account was not found', 404);
      await tx.delete(portalAccounts).where(and(eq(portalAccounts.tenantId, tenantId), eq(portalAccounts.id, id)));
      await tx.update(memberships).set({ status: 'suspended', deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, row.userId)));
      return { id, revoked: true };
    });
  }

  // ------------------------------------------------------------------ the customer's own view

  /** Resolves the caller's portal account, or refuses. Every portal route starts here. */
  async accountFor(tenantId: string, userId: string) {
    const [account] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(portalAccounts).where(and(eq(portalAccounts.tenantId, tenantId), eq(portalAccounts.userId, userId))),
    );
    if (!account) throw new DomainError('PORTAL_ACCESS_REQUIRED', 'This login is not linked to a customer portal account', 403);
    if (account.status !== 'active') throw new DomainError('PORTAL_ACCESS_SUSPENDED', 'Portal access for this account is suspended', 403);
    return account;
  }

  async me(tenantId: string, userId: string) {
    const account = await this.accountFor(tenantId, userId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.update(portalAccounts).set({ lastSeenAt: new Date() }).where(eq(portalAccounts.id, account.id));
      const [party] = await tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, account.partyId)));
      const company = rowsOf(await tx.execute(sql`SELECT name_ar, name_en, tax_no, phones, email FROM company_profiles WHERE tenant_id = ${tenantId}`))[0];
      const openBalance = rowsOf(
        await tx.execute(sql`
          SELECT coalesce(sum(jel.debit - jel.credit), 0)::text AS balance
            FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.entry_id
           WHERE jel.tenant_id = ${tenantId} AND jel.party_id = ${account.partyId} AND je.status = 'posted'
        `),
      )[0];
      return {
        party: party ? { id: party.id, code: party.code, name: party.name, taxNo: party.taxNo, phone: party.phone, email: party.email, creditLimit: party.creditLimit } : null,
        company: { nameAr: str(company?.name_ar), nameEn: str(company?.name_en), taxNo: str(company?.tax_no), email: str(company?.email), phones: Array.isArray(company?.phones) ? company?.phones : [] },
        balance: str(openBalance?.balance) || '0',
      };
    });
  }

  async invoices(tenantId: string, userId: string, filters: { from?: string; to?: string } = {}) {
    const account = await this.accountFor(tenantId, userId);
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT id, number, kind, status, payment_status, currency, subtotal::text, tax_total::text, total::text, paid_total::text,
                 posted_at, created_at, zatca_status
            FROM sales_invoices
           WHERE tenant_id = ${tenantId} AND party_id = ${account.partyId} AND status = 'posted'
             AND (${filters.from ?? null}::date IS NULL OR coalesce(posted_at, created_at)::date >= ${filters.from ?? null}::date)
             AND (${filters.to ?? null}::date IS NULL OR coalesce(posted_at, created_at)::date <= ${filters.to ?? null}::date)
           ORDER BY coalesce(posted_at, created_at) DESC
           LIMIT 500
        `),
      ),
    );
  }

  async invoice(tenantId: string, userId: string, invoiceId: string) {
    const account = await this.accountFor(tenantId, userId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [guard] = await tx.select().from(salesInvoices).where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, invoiceId)));
      // A foreign invoice is a 404, not a 403: the portal must not confirm that the id exists.
      if (!guard || guard.partyId !== account.partyId || guard.status !== 'posted') throw new DomainError('NOT_FOUND', 'Invoice was not found', 404);
      // Re-read through the same projection the list uses, so both screens see identical fields.
      const invoice = rowsOf(
        await tx.execute(sql`
          SELECT id, number, kind, status, payment_status, currency, subtotal::text, tax_total::text, total::text, paid_total::text,
                 invoice_discount::text, posted_at, created_at, zatca_status
            FROM sales_invoices WHERE tenant_id = ${tenantId} AND id = ${invoiceId}
        `),
      )[0];
      const lines = rowsOf(
        await tx.execute(sql`
          SELECT l.line_no, coalesce(l.description, i.name_ar) AS name, u.code AS unit, l.quantity::text, l.unit_price::text,
                 l.discount_amount::text, l.net::text, l.tax::text, l.total::text
            FROM sales_invoice_lines l
            LEFT JOIN items i ON i.id = l.item_id
            LEFT JOIN units_of_measure u ON u.id = i.base_unit_id
           WHERE l.tenant_id = ${tenantId} AND l.invoice_id = ${invoiceId}
           ORDER BY l.line_no
        `),
      );
      const payments = rowsOf(await tx.execute(sql`SELECT method, amount::text, reference, created_at FROM invoice_payments WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId} ORDER BY created_at`));
      return { invoice, lines, payments };
    });
  }

  /** The hosted payment link the merchant issued, never a link belonging to another customer. */
  async paymentLink(tenantId: string, userId: string, invoiceId: string) {
    const account = await this.accountFor(tenantId, userId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [invoice] = await tx
        .select()
        .from(salesInvoices)
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, invoiceId)));
      if (!invoice || invoice.partyId !== account.partyId || invoice.status !== 'posted') {
        throw new DomainError('NOT_FOUND', 'Invoice was not found', 404);
      }
      const [company] = await tx
        .select({ nameAr: companyProfiles.nameAr, nameEn: companyProfiles.nameEn })
        .from(companyProfiles)
        .where(eq(companyProfiles.tenantId, tenantId))
        .limit(1);
      const links = await tx
        .select()
        .from(paymentLinks)
        .where(and(eq(paymentLinks.tenantId, tenantId), eq(paymentLinks.invoiceId, invoiceId)));
      const ranked = [...links].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
      const link = ranked.find((row) => row.status === 'pending') ?? ranked[0] ?? null;
      // AUD-17 — الرصيد المتبقّي يُحسب عشريًّا (كان `Number()`): الفرق `numeric(18,4)`
      // بين المبلغ والمسدَّد لا يمرّ بالعائم، فيبقى عرض العميل مطابقًا لدفتره.
      const remaining = new Decimal(invoice.total).minus(invoice.paidTotal ?? 0);
      return {
        companyName: company?.nameAr || company?.nameEn || '',
        invoice: {
          id: invoice.id,
          number: invoice.number,
          currency: invoice.currency,
          total: invoice.total,
          paidTotal: invoice.paidTotal,
          remaining: remaining.toFixed(4),
          paymentStatus: invoice.paymentStatus,
        },
        link: link
          ? {
              id: link.id,
              provider: link.provider,
              amount: link.amount,
              currency: link.currency,
              url: link.linkUrl,
              status: link.status,
              paidAt: link.paidAt,
            }
          : null,
      };
    });
  }

  /** The same printed document the back office produces — the customer can save it as a PDF. */
  async invoicePrint(tenantId: string, userId: string, invoiceId: string) {
    await this.invoice(tenantId, userId, invoiceId); // ownership check, and 404 for anything else
    return this.print.salesInvoice(tenantId, invoiceId);
  }

  /**
   * The customer's account statement, built from documents rather than journal lines.
   *
   * A buyer's question is "which invoice is still open", not "which account was debited", and
   * a document-level statement also stays correct in a tenant that has not finished setting up
   * its posting profiles: an invoice they were handed is a debit whether or not the back office
   * has posted it to the ledger yet.
   */
  async statement(tenantId: string, userId: string, filters: { from?: string; to?: string } = {}) {
    const account = await this.accountFor(tenantId, userId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const lines = rowsOf(
        await tx.execute(sql`
          WITH movements AS (
            SELECT coalesce(si.posted_at, si.created_at)::date AS day,
                   CASE si.kind WHEN 'return' THEN 'return' ELSE 'invoice' END AS doc_type,
                   coalesce(si.number, '—') AS number,
                   CASE si.kind WHEN 'return' THEN 'مردود مبيعات' ELSE 'فاتورة مبيعات' END AS description,
                   CASE WHEN si.kind = 'return' THEN 0 ELSE si.total END AS debit,
                   CASE WHEN si.kind = 'return' THEN si.total ELSE 0 END AS credit,
                   si.id AS document_id
              FROM sales_invoices si
             WHERE si.tenant_id = ${tenantId} AND si.party_id = ${account.partyId} AND si.status = 'posted'
            UNION ALL
            SELECT v.date AS day,
                   CASE v.kind WHEN 'receipt' THEN 'receipt' ELSE 'payment' END AS doc_type,
                   coalesce(v.number, '—') AS number,
                   CASE v.kind WHEN 'receipt' THEN 'سند قبض' ELSE 'سند صرف' END AS description,
                   CASE WHEN v.kind = 'receipt' THEN 0 ELSE v.amount END AS debit,
                   CASE WHEN v.kind = 'receipt' THEN v.amount ELSE 0 END AS credit,
                   v.id AS document_id
              FROM vouchers v
             WHERE v.tenant_id = ${tenantId} AND v.party_id = ${account.partyId} AND v.status = 'posted'
          )
          SELECT day::text AS day, doc_type, number, description, debit::text, credit::text, document_id,
                 sum(debit - credit) OVER (ORDER BY day, number ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::text AS running
            FROM movements
           WHERE (${filters.from ?? null}::date IS NULL OR day >= ${filters.from ?? null}::date)
             AND (${filters.to ?? null}::date IS NULL OR day <= ${filters.to ?? null}::date)
           ORDER BY day, number
           LIMIT 2000
        `),
      );
      const closing = lines.length ? str(lines[lines.length - 1]?.running) : '0';
      return { lines, closing };
    });
  }

  async payments(tenantId: string, userId: string) {
    const account = await this.accountFor(tenantId, userId);
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT v.id, v.number, v.date::text AS day, v.kind, v.method, v.amount::text, v.status, v.reference_no, v.cheque_no
            FROM vouchers v
           WHERE v.tenant_id = ${tenantId} AND v.party_id = ${account.partyId} AND v.status = 'posted'
           ORDER BY v.date DESC, v.number DESC
           LIMIT 500
        `),
      ),
    );
  }

  // ------------------------------------------------------------------ internals

  /** One shared, permission-free role per tenant; created the first time it is needed. */
  private async portalRoleId(tx: DrizzleTx, tenantId: string, actorUserId: string): Promise<string> {
    const [existing] = await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.name, PORTAL_ROLE_NAME)));
    if (existing) return existing.id;
    const id = newId();
    await tx.insert(roles).values({
      id,
      tenantId,
      name: PORTAL_ROLE_NAME,
      description: 'وصول بوابة العملاء — بلا أي صلاحية على النظام؛ الوصول محصور بمستندات العميل نفسه.',
      isSystem: true,
      createdAt: new Date(),
      createdBy: actorUserId,
    });
    return id;
  }
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** A readable one-time password: no ambiguous characters, long enough to survive the policy. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(14);
  globalThis.crypto.getRandomValues(bytes);
  return `${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join('')}#7`;
}