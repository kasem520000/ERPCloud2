/* eslint-disable no-restricted-syntax, import/order */
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { DomainError, errorCodes, newId } from '@erp/contracts';
import { accounts, journalEntries, journalEntryLines, parties, partyContacts, paymentAllocations, paymentMethods, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { isUniqueViolation } from '../organization/shared/org-support.js';

export type PaymentMethodInput = { code: string; nameAr: string; nameEn?: string; kind?: 'cash' | 'card' | 'transfer' | 'cheque' | 'credit'; dueDays?: number; cashLocationId?: string; isActive?: boolean; isDefault?: boolean };
export type PartyInput = { kind: 'customer' | 'supplier' | 'both'; name: string; paymentMethodId?: string; legalName?: string; taxNo?: string; nationalId?: string; address?: Record<string, string | undefined>; phone?: string; email?: string; receivableAccountId?: string; payableAccountId?: string; creditLimit?: string; isOwner?: boolean; isContractor?: boolean; branchId?: string };
export type ContactInput = { name: string; role?: string; phone?: string; email?: string; isPrimary?: boolean };
export type AllocationInput = { partyId: string; voucherId?: string; invoiceKind: string; invoiceId: string; amount: string; invoiceTotal?: string; alreadyAllocated?: string };

@Injectable()
export class PartiesService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly customFields: CustomFieldsService,
  ) {}
  async list(tenantId: string, kind?: string) {
    const rows = await withTenantTx(this.database.db, tenantId, async (tx) => {
      // Ensure provisioned tenants always have the default general customer (`عميل عام`)
      // and general supplier (`مورد عام`).
      const hasDefaultAccounts = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.tenantId, tenantId), isNull(accounts.deletedAt), sql`${accounts.code} IN ('12310001', '22111001')`))
        .limit(1);
      if (hasDefaultAccounts.length > 0) {
        const existingDefaults = await tx
          .select({ code: parties.code, name: parties.name })
          .from(parties)
          .where(
            and(
              eq(parties.tenantId, tenantId),
              isNull(parties.deletedAt),
              sql`(${parties.code} IN ('CUST-GEN', 'SUPP-GEN') OR ${parties.name} IN ('عميل عام', 'مورد عام'))`,
            ),
          );
        const hasCustomer = existingDefaults.some((p) => p.code === 'CUST-GEN' || p.name === 'عميل عام');
        const hasSupplier = existingDefaults.some((p) => p.code === 'SUPP-GEN' || p.name === 'مورد عام');
        if (!hasCustomer) {
          await tx
            .insert(parties)
            .values({
              id: newId(),
              tenantId,
              code: 'CUST-GEN',
              kind: 'customer',
              name: 'عميل عام',
              legalName: 'عميل عام',
              creditLimit: '0',
            })
            .onConflictDoNothing();
        }
        if (!hasSupplier) {
          await tx
            .insert(parties)
            .values({
              id: newId(),
              tenantId,
              code: 'SUPP-GEN',
              kind: 'supplier',
              name: 'مورد عام',
              legalName: 'مورد عام',
              creditLimit: '0',
            })
            .onConflictDoNothing();
        }
      }
      return tx
        .select()
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), isNull(parties.deletedAt), kind ? eq(parties.kind, kind) : undefined))
        .orderBy(desc(parties.createdAt))
        .limit(100);
    });
    return this.customFields.decorate(tenantId, 'party', rows);
  }
  /**
   * 🔑 R6 — «عميل/مورد» بمعرّفٍ لا وجود له كان يعيد `undefined`، فيخرج الردّ **200 بجسمٍ
   * فارغ**: لا هو نجاحٌ يفهمه العميل ولا خطأٌ يشرح السبب. والغياب يُعلَن: `PARTY_NOT_FOUND`
   * **404**. وهذا يحمي التعديل والحذف كذلك — كانا يكتبان صفرَ صفوف ثم يعيدان الفراغ نفسه.
   */
  async get(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, id), isNull(parties.deletedAt))));
    if (!row) throw new DomainError(errorCodes.PARTY_NOT_FOUND, 'Party was not found', 404);
    const [decorated] = await this.customFields.decorate(tenantId, 'party', [row]);
    return decorated ?? row;
  }
  async update(tenantId: string, id: string, input: Partial<PartyInput>) { await withTenantTx(this.database.db, tenantId, (tx) => tx.update(parties).set({ ...input, updatedAt: new Date(), version: sql`${parties.version} + 1` }).where(and(eq(parties.tenantId, tenantId), eq(parties.id, id), isNull(parties.deletedAt)))); return this.get(tenantId, id); }
  async create(tenantId: string, input: PartyInput) { const id = newId(); const code = await withTenantTx(this.database.db, tenantId, async (tx) => { const result = await tx.execute(sql`SELECT COALESCE(MAX(CAST(code AS INTEGER)), 0) + 1 AS next FROM parties WHERE tenant_id = ${tenantId} AND code ~ '^[0-9]+$'`); return String(Number((result.rows[0] as { next: string }).next).toString().padStart(6, '0')); }); await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(parties).values({ id, tenantId, code, ...input, creditLimit: input.creditLimit ?? '0' })); return this.get(tenantId, id); }
  /**
   * 🗑️ حذف عميل — `frmCustomers`. A party with a balance stays: the refusal protects the
   * ledger, not the row.
   *
   * The comparison is numeric on purpose. `partyBalance` returns money as four-decimal
   * strings, so comparing them to `'0'` refused **every** delete — a عميل with no
   * movement at all could never be removed. Found by `scripts/verify-tailoring.mjs`.
   */
  async softDelete(tenantId: string, id: string) {
    await this.get(tenantId, id);
    const balance = await this.partyBalance(tenantId, id);
    const receivable = new Decimal(balance.receivable);
    const payable = new Decimal(balance.payable);
    if (!receivable.isZero() || !payable.isZero() || balance.open.length)
      throw new DomainError('PARTY_HAS_OPEN_BALANCE', 'Party has an open balance and cannot be deleted', 422);
    await withTenantTx(this.database.db, tenantId, (tx) => tx.update(parties).set({ deletedAt: new Date() }).where(and(eq(parties.tenantId, tenantId), eq(parties.id, id))));
  }
  async contacts(tenantId: string, partyId: string) {
    // جهات الاتصال موردٌ تابع: عميلٌ غير موجود لا تكون له قائمةٌ فارغة، بل 404.
    await this.get(tenantId, partyId);
    return withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(partyContacts).where(and(eq(partyContacts.tenantId, tenantId), eq(partyContacts.partyId, partyId), isNull(partyContacts.deletedAt)))); }
  async addContact(tenantId: string, partyId: string, input: ContactInput) { const id = newId(); await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(partyContacts).values({ id, partyId, tenantId, ...input })); return this.contacts(tenantId, partyId); }
  async removeContact(tenantId: string, partyId: string, id: string) { await withTenantTx(this.database.db, tenantId, (tx) => tx.update(partyContacts).set({ deletedAt: new Date() }).where(and(eq(partyContacts.tenantId, tenantId), eq(partyContacts.partyId, partyId), eq(partyContacts.id, id)))); return this.contacts(tenantId, partyId); }
  async listPaymentMethods(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(paymentMethods).where(and(eq(paymentMethods.tenantId, tenantId), isNull(paymentMethods.deletedAt))).orderBy(paymentMethods.code));
  }

  /**
   * Only one method can be the default, so promoting one demotes the rest inside the same
   * transaction — the partial unique index would reject the second default anyway, and
   * failing after a partial write would leave the tenant with none.
   */
  async createPaymentMethod(tenantId: string, input: PaymentMethodInput) {
    const id = newId();
    if (input.dueDays !== undefined && (!Number.isInteger(input.dueDays) || input.dueDays < 0)) {
      throw new DomainError('PAYMENT_METHOD_DUE_DAYS_INVALID', 'Due days must be a whole number of days', 422);
    }
    try {
      await withTenantTx(this.database.db, tenantId, async (tx) => {
      if (input.isDefault) await tx.update(paymentMethods).set({ isDefault: false }).where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.isDefault, true)));
      await tx.insert(paymentMethods).values({
        id,
        tenantId,
        code: input.code,
        nameAr: input.nameAr,
        nameEn: input.nameEn,
        kind: input.kind ?? 'cash',
        dueDays: input.dueDays ?? 0,
        cashLocationId: input.cashLocationId,
        isActive: input.isActive ?? true,
        isDefault: input.isDefault ?? false,
      });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('PAYMENT_METHOD_CODE_TAKEN', 'Another payment method already uses this code', 422);
      throw error;
    }
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(paymentMethods).where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.id, id))));
    return row;
  }

  async updatePaymentMethod(tenantId: string, id: string, input: Partial<PaymentMethodInput>) {
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      if (input.isDefault) await tx.update(paymentMethods).set({ isDefault: false }).where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.isDefault, true)));
      await tx.update(paymentMethods).set({ ...input, updatedAt: new Date(), version: sql`${paymentMethods.version} + 1` }).where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.id, id), isNull(paymentMethods.deletedAt)));
    });
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(paymentMethods).where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.id, id))));
    if (!row) throw new DomainError('PAYMENT_METHOD_NOT_FOUND', 'Payment method was not found', 404);
    return row;
  }

  async allocate(tenantId: string, input: AllocationInput) {
    const amount = new Decimal(input.amount);
    const total = input.invoiceTotal === undefined ? null : new Decimal(input.invoiceTotal);
    const allocated = new Decimal(input.alreadyAllocated ?? '0');
    if (!amount.isFinite() || amount.lte(0) || (total && allocated.plus(amount).gt(total))) {
      throw new DomainError('ALLOCATION_EXCEEDS_OPEN_AMOUNT', 'Allocation exceeds the invoice open amount', 422);
    }
    const id = newId();
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await tx.select({ amount: paymentAllocations.amount }).from(paymentAllocations).where(and(eq(paymentAllocations.tenantId, tenantId), eq(paymentAllocations.invoiceKind, input.invoiceKind), eq(paymentAllocations.invoiceId, input.invoiceId)));
      const persisted = existing.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
      if (total && persisted.plus(amount).gt(total)) throw new DomainError('ALLOCATION_EXCEEDS_OPEN_AMOUNT', 'Allocation exceeds the invoice open amount', 422);
      await tx.insert(paymentAllocations).values({ id, tenantId, partyId: input.partyId, voucherId: input.voucherId, invoiceKind: input.invoiceKind, invoiceId: input.invoiceId, amount: amount.toFixed(4) });
    });
    return { id, ...input, amount: amount.toFixed(4) };
  }
  async partyBalance(tenantId: string, partyId: string, asOf?: string) {
    // رصيد صفرٌ لعميلٍ غير موجود رقمٌ كاذب؛ والكشف مثله. الغياب يُعلَن قبل الحساب.
    await this.get(tenantId, partyId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) => tx.select({ accountId: journalEntryLines.accountId, debit: journalEntryLines.debit, credit: journalEntryLines.credit, date: journalEntries.date, entryId: journalEntries.id }).from(journalEntryLines).innerJoin(journalEntries, eq(journalEntryLines.entryId, journalEntries.id)).where(and(eq(journalEntryLines.tenantId, tenantId), eq(journalEntryLines.partyId, partyId), eq(journalEntries.status, 'posted'), asOf ? sql`${journalEntries.date} <= ${asOf}` : undefined)));
    const total = rows.reduce((sum, row) => sum.plus(new Decimal(row.debit).minus(row.credit)), new Decimal(0));
    const allocations = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(paymentAllocations).where(and(eq(paymentAllocations.tenantId, tenantId), eq(paymentAllocations.partyId, partyId))));
    return { receivable: total.toFixed(4), payable: '0.0000', open: rows.map((row) => ({ ...row, allocated: allocations.filter((a) => a.invoiceId === row.entryId).reduce((sum, a) => sum.plus(a.amount), new Decimal(0)).toFixed(4) })) };
  }
  async assertCreditAvailable(tenantId: string, partyId: string, newAmount: string, override = false) {
    const party = await this.get(tenantId, partyId);
    if (!party) throw new DomainError(errorCodes.NOT_FOUND, 'Party not found', 404);
    if (!override && new Decimal((await this.partyBalance(tenantId, partyId)).receivable).plus(new Decimal(newAmount)).gt(new Decimal(party.creditLimit))) throw new DomainError('CREDIT_LIMIT_EXCEEDED', 'Credit limit exceeded', 422);
    return true;
  }
}
