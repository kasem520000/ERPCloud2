import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  accounts,
  bankAccounts,
  bankReconciliationRules,
  bankStatementLines,
  bankStatements,
  costCenters,
  journalEntries,
  journalEntryLines,
  parties,
  purchaseInvoices,
  salesInvoices,
  vouchers,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../../request-context/request-context.js';

import {
  bestBankMatch,
  parseBankStatementCsv,
  type BankMatchCandidate,
  type ParsedBankStatementLine,
} from './bank-feeds.utils.js';

export type BankAccountInput = {
  bankName: string;
  accountNo?: string;
  iban?: string;
  currency?: string;
  openingBalance?: string;
  accountId?: string;
};

export type BankAccountUpdate = Partial<BankAccountInput> & {
  status?: 'active' | 'inactive';
  version?: number;
};

export type BankStatementImportInput = {
  bankAccountId: string;
  /** CSV text for the first release. A file_id can still be retained for audit linkage. */
  csv?: string;
  content?: string;
  fileId?: string;
  fileName?: string;
  openingBalance?: string;
};

export type BankLineMatchInput = {
  lineId: string;
  voucherId?: string;
  invoiceId?: string;
  invoiceType?: 'sale' | 'purchase';
};

export type BankRuleInput = {
  keyword: string;
  accountId: string;
  costCenterId?: string;
  priority?: number;
};

const money = (value: string | null | undefined): Decimal => {
  const result = new Decimal(value ?? '0');
  if (!result.isFinite()) throw new DomainError('BANK_AMOUNT_INVALID', 'Bank amount is not a valid number', 422);
  return result;
};

function actorId(): string | null {
  return tryGetAuthContext()?.userId ?? null;
}

function dateOnly(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString().slice(0, 10);
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function normaliseIban(value?: string): string | null {
  const result = value?.replace(/\s+/g, '').trim().toUpperCase();
  return result || null;
}

function normaliseText(value?: string): string | null {
  const result = value?.trim();
  return result || null;
}

function statementDto(row: typeof bankStatements.$inferSelect) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

function accountDto(row: typeof bankAccounts.$inferSelect) {
  return {
    ...row,
    iban: row.iban ? maskIban(row.iban) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

function maskIban(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}••••`;
  return `${value.slice(0, 4)}${'•'.repeat(Math.max(2, value.length - 8))}${value.slice(-4)}`;
}

function assertPositiveOrZero(value: string | undefined, field: string): string {
  const parsed = money(value ?? '0');
  if (parsed.isNegative()) throw new DomainError('BANK_AMOUNT_INVALID', `${field} cannot be negative`, 422, { field });
  return parsed.toFixed(4);
}

function extractCsv(input: BankStatementImportInput): string {
  const csv = input.csv ?? input.content;
  if (!csv?.trim()) {
    throw new DomainError('BANK_CSV_REQUIRED', 'CSV content is required for a bank statement import', 422, {
      field: 'csv',
    });
  }
  return csv;
}

@Injectable()
export class BankFeedsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async listBankAccounts(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx.select().from(bankAccounts).where(eq(bankAccounts.tenantId, tenantId)).orderBy(asc(bankAccounts.bankName));
      return rows.map(accountDto);
    });
  }

  async getBankAccount(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => accountDto(await this.mustBankAccount(tx, tenantId, id)));
  }

  async createBankAccount(tenantId: string, input: BankAccountInput) {
    const bankName = normaliseText(input.bankName);
    if (!bankName) throw new DomainError('BANK_NAME_REQUIRED', 'Bank name is required', 422, { field: 'bankName' });
    const id = newId();
    const created = await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.assertAccount(tx, tenantId, input.accountId);
      const [row] = await tx
        .insert(bankAccounts)
        .values({
          id,
          tenantId,
          bankName,
          accountNo: normaliseText(input.accountNo),
          iban: normaliseIban(input.iban),
          currency: (input.currency ?? 'SAR').trim().toUpperCase(),
          openingBalance: assertPositiveOrZero(input.openingBalance, 'openingBalance'),
          accountId: input.accountId ?? null,
          createdBy: actorId(),
        })
        .returning();
      if (!row) throw new DomainError('BANK_ACCOUNT_CREATE_FAILED', 'Bank account could not be created', 500);
      return row;
    });
    return accountDto(created);
  }

  async updateBankAccount(tenantId: string, id: string, input: BankAccountUpdate) {
    const updated = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.mustBankAccount(tx, tenantId, id);
      if (input.version !== undefined && input.version !== current.version) {
        throw new DomainError('VERSION_CONFLICT', 'Bank account was changed by another user', 409);
      }
      await this.assertAccount(tx, tenantId, input.accountId);
      const updates: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: actorId(),
        version: sql`${bankAccounts.version} + 1`,
      };
      if (input.bankName !== undefined) {
        const bankName = normaliseText(input.bankName);
        if (!bankName) throw new DomainError('BANK_NAME_REQUIRED', 'Bank name is required', 422, { field: 'bankName' });
        updates.bankName = bankName;
      }
      if (input.accountNo !== undefined) updates.accountNo = normaliseText(input.accountNo);
      if (input.iban !== undefined) updates.iban = normaliseIban(input.iban);
      if (input.currency !== undefined) updates.currency = input.currency.trim().toUpperCase();
      if (input.openingBalance !== undefined) updates.openingBalance = assertPositiveOrZero(input.openingBalance, 'openingBalance');
      if (input.accountId !== undefined) updates.accountId = input.accountId || null;
      if (input.status !== undefined) updates.status = input.status;

      const [row] = await tx
        .update(bankAccounts)
        .set(updates)
        .where(and(eq(bankAccounts.tenantId, tenantId), eq(bankAccounts.id, id), eq(bankAccounts.version, current.version)))
        .returning();
      if (!row) throw new DomainError('VERSION_CONFLICT', 'Bank account was changed by another user', 409);
      return row;
    });
    return accountDto(updated);
  }

  async deleteBankAccount(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustBankAccount(tx, tenantId, id);
      const [statement] = await tx.select({ id: bankStatements.id }).from(bankStatements).where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.bankAccountId, id))).limit(1);
      if (statement) throw new DomainError('BANK_ACCOUNT_HAS_STATEMENTS', 'Delete the imported statements before deleting the bank account', 409);
      const [deleted] = await tx.delete(bankAccounts).where(and(eq(bankAccounts.tenantId, tenantId), eq(bankAccounts.id, id))).returning({ id: bankAccounts.id });
      if (!deleted) throw new DomainError('BANK_ACCOUNT_NOT_FOUND', 'Bank account was not found', 404);
      return { id, deleted: true as const };
    });
  }

  async listStatements(tenantId: string, bankAccountId?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      if (bankAccountId) await this.mustBankAccount(tx, tenantId, bankAccountId);
      const rows = await tx
        .select()
        .from(bankStatements)
        .where(and(eq(bankStatements.tenantId, tenantId), bankAccountId ? eq(bankStatements.bankAccountId, bankAccountId) : undefined))
        .orderBy(desc(bankStatements.periodTo), desc(bankStatements.createdAt))
        .limit(200);
      return rows.map(statementDto);
    });
  }

  async deleteStatement(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const statement = await this.mustStatement(tx, tenantId, id);
      const [matched] = await tx.select({ id: bankStatementLines.id }).from(bankStatementLines).where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.statementId, id), eq(bankStatementLines.status, 'matched'))).limit(1);
      if (matched) throw new DomainError('BANK_STATEMENT_HAS_MATCHES', 'A reconciled statement cannot be deleted', 409);
      await tx.delete(bankStatements).where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.id, id)));
      return { id: statement.id, deleted: true as const };
    });
  }

  async getStatement(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [statement] = await tx
        .select()
        .from(bankStatements)
        .where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.id, id)))
        .limit(1);
      if (!statement) throw new DomainError('BANK_STATEMENT_NOT_FOUND', 'Bank statement was not found', 404);
      const lines = await tx
        .select()
        .from(bankStatementLines)
        .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.statementId, id)))
        .orderBy(asc(bankStatementLines.lineNo));
      return { ...statementDto(statement), lines };
    });
  }

  async importStatement(tenantId: string, input: BankStatementImportInput) {
    const csv = extractCsv(input);
    let parsed: ParsedBankStatementLine[];
    try {
      parsed = parseBankStatementCsv(csv);
    } catch (error) {
      throw new DomainError('BANK_CSV_INVALID', error instanceof Error ? error.message : 'CSV is invalid', 422, {
        field: 'csv',
      });
    }
    if (parsed.length === 0) throw new DomainError('BANK_CSV_EMPTY', 'CSV contains no transactions', 422);

    const periodFrom = parsed.reduce((min, row) => (row.txnDate < min ? row.txnDate : min), parsed[0]?.txnDate ?? '');
    const periodTo = parsed.reduce((max, row) => (row.txnDate > max ? row.txnDate : max), parsed[0]?.txnDate ?? '');
    const lastBalance = [...parsed].reverse().find((row) => row.balance !== null)?.balance ?? null;
    const statementId = newId();

    const result = await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustBankAccount(tx, tenantId, input.bankAccountId);
      if (input.fileId) {
        const [existing] = await tx
          .select({ id: bankStatements.id })
          .from(bankStatements)
          .where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.fileId, input.fileId)))
          .limit(1);
        if (existing) throw new DomainError('BANK_FILE_ALREADY_IMPORTED', 'This file was already imported', 409);
      }

      const openingBalance = input.openingBalance === undefined ? null : assertPositiveOrZero(input.openingBalance, 'openingBalance');
      const [statement] = await tx
        .insert(bankStatements)
        .values({
          id: statementId,
          tenantId,
          bankAccountId: input.bankAccountId,
          fileId: input.fileId ?? null,
          periodFrom,
          periodTo,
          openingBalance,
          closingBalance: lastBalance,
          status: 'processed',
          sourceFileName: normaliseText(input.fileName),
          rowCount: parsed.length,
          processedAt: new Date(),
          createdBy: actorId(),
        })
        .returning();
      if (!statement) throw new DomainError('BANK_STATEMENT_CREATE_FAILED', 'Bank statement could not be created', 500);

      await tx.insert(bankStatementLines).values(
        parsed.map((line) => ({
          id: newId(),
          tenantId,
          statementId,
          lineNo: line.lineNo,
          txnDate: line.txnDate,
          description: line.description,
          reference: line.reference,
          amount: line.amount,
          balance: line.balance,
          status: 'pending',
          createdBy: actorId(),
        })),
      );
      return statement;
    });

    return { statement: statementDto(result), importedLines: parsed.length };
  }

  async listLines(tenantId: string, statementId: string, status?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustStatement(tx, tenantId, statementId);
      return tx
        .select()
        .from(bankStatementLines)
        .where(
          and(
            eq(bankStatementLines.tenantId, tenantId),
            eq(bankStatementLines.statementId, statementId),
            status && ['pending', 'matched', 'ignored'].includes(status) ? eq(bankStatementLines.status, status) : undefined,
          ),
        )
        .orderBy(asc(bankStatementLines.lineNo));
    });
  }

  async matchLine(tenantId: string, statementId: string, input: BankLineMatchInput) {
    if (!input.voucherId && !input.invoiceId) throw new DomainError('BANK_MATCH_TARGET_REQUIRED', 'A voucher or invoice is required', 422);
    if (input.voucherId && input.invoiceId) throw new DomainError('BANK_MATCH_TARGET_AMBIGUOUS', 'Choose either a voucher or an invoice', 422);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const line = await this.mustLine(tx, tenantId, statementId, input.lineId);
      let invoiceType: 'sale' | 'purchase' | null = null;
      if (input.voucherId) {
        const [voucher] = await tx
          .select({ id: vouchers.id })
          .from(vouchers)
          .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, input.voucherId)))
          .limit(1);
        if (!voucher) throw new DomainError('BANK_MATCH_TARGET_NOT_FOUND', 'Voucher was not found in this tenant', 404);
      }
      if (input.invoiceId) {
        if (input.invoiceType === 'purchase') {
          const [invoice] = await tx.select({ id: purchaseInvoices.id }).from(purchaseInvoices).where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, input.invoiceId))).limit(1);
          if (!invoice) throw new DomainError('BANK_MATCH_TARGET_NOT_FOUND', 'Purchase invoice was not found in this tenant', 404);
          invoiceType = 'purchase';
        } else if (input.invoiceType === 'sale') {
          const [invoice] = await tx.select({ id: salesInvoices.id }).from(salesInvoices).where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, input.invoiceId))).limit(1);
          if (!invoice) throw new DomainError('BANK_MATCH_TARGET_NOT_FOUND', 'Sales invoice was not found in this tenant', 404);
          invoiceType = 'sale';
        } else {
          const [sale] = await tx.select({ id: salesInvoices.id }).from(salesInvoices).where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, input.invoiceId))).limit(1);
          if (sale) invoiceType = 'sale';
          else {
            const [purchase] = await tx.select({ id: purchaseInvoices.id }).from(purchaseInvoices).where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, input.invoiceId))).limit(1);
            if (purchase) invoiceType = 'purchase';
          }
          if (!invoiceType) throw new DomainError('BANK_MATCH_TARGET_NOT_FOUND', 'Invoice was not found in this tenant', 404);
        }
      }

      const [updated] = await tx
        .update(bankStatementLines)
        .set({
          matchedVoucherId: input.voucherId ?? null,
          matchedInvoiceId: input.invoiceId ?? null,
          matchedInvoiceType: invoiceType,
          matchConfidence: '1.0000',
          matchReason: 'مطابقة يدوية',
          status: 'matched',
          matchedAt: new Date(),
          matchedBy: actorId(),
          updatedAt: new Date(),
          updatedBy: actorId(),
          version: line.version + 1,
        })
        .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.id, line.id), eq(bankStatementLines.version, line.version)))
        .returning();
      if (!updated) throw new DomainError('VERSION_CONFLICT', 'Bank statement line was changed by another user', 409);
      await this.refreshStatementStatus(tx, tenantId, statementId);
      return updated;
    });
  }

  async ignoreLine(tenantId: string, statementId: string, lineId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const line = await this.mustLine(tx, tenantId, statementId, lineId);
      const [updated] = await tx
        .update(bankStatementLines)
        .set({ status: 'ignored', matchReason: 'تجاهل يدوي', updatedAt: new Date(), updatedBy: actorId(), version: line.version + 1 })
        .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.id, line.id), eq(bankStatementLines.version, line.version)))
        .returning();
      await this.refreshStatementStatus(tx, tenantId, statementId);
      return updated;
    });
  }

  async unmatchLine(tenantId: string, statementId: string, lineId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const line = await this.mustLine(tx, tenantId, statementId, lineId);
      const [updated] = await tx
        .update(bankStatementLines)
        .set({
          matchedVoucherId: null,
          matchedInvoiceId: null,
          matchedInvoiceType: null,
          matchConfidence: null,
          matchReason: null,
          status: 'pending',
          matchedAt: null,
          matchedBy: null,
          updatedAt: new Date(),
          updatedBy: actorId(),
          version: line.version + 1,
        })
        .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.id, line.id), eq(bankStatementLines.version, line.version)))
        .returning();
      await this.refreshStatementStatus(tx, tenantId, statementId);
      return updated;
    });
  }

  async autoMatch(tenantId: string, statementId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustStatement(tx, tenantId, statementId);
      const pending = await tx
        .select()
        .from(bankStatementLines)
        .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.statementId, statementId), eq(bankStatementLines.status, 'pending')))
        .orderBy(asc(bankStatementLines.lineNo));
      const candidates = await this.candidates(tx, tenantId);
      const rules = await tx
        .select()
        .from(bankReconciliationRules)
        .where(and(eq(bankReconciliationRules.tenantId, tenantId), eq(bankReconciliationRules.status, 'active')))
        .orderBy(asc(bankReconciliationRules.priority), asc(bankReconciliationRules.createdAt));
      let matched = 0;
      let suggested = 0;

      for (const line of pending) {
        const lineForScore: ParsedBankStatementLine = {
          lineNo: line.lineNo,
          txnDate: line.txnDate,
          description: line.description,
          reference: line.reference,
          amount: line.amount,
          balance: line.balance,
        };
        const rule = rules.find((item) => `${line.description} ${line.reference ?? ''}`.toLocaleLowerCase().includes(item.keyword.toLocaleLowerCase()));
        const best = bestBankMatch(lineForScore, candidates);
        if (best) {
          await tx
            .update(bankStatementLines)
            .set({
              matchedVoucherId: best.candidate.type === 'voucher' ? best.candidate.id : null,
              matchedInvoiceId: best.candidate.type === 'voucher' ? null : best.candidate.id,
              matchedInvoiceType: best.candidate.type === 'voucher' ? null : best.candidate.type,
              matchConfidence: best.score.confidence.toFixed(4),
              matchReason: best.score.reason,
              suggestedAccountId: rule?.accountId ?? null,
              suggestedCostCenterId: rule?.costCenterId ?? null,
              status: 'matched',
              matchedAt: new Date(),
              matchedBy: actorId(),
              updatedAt: new Date(),
              updatedBy: actorId(),
              version: line.version + 1,
            })
            .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.id, line.id), eq(bankStatementLines.version, line.version)));
          matched += 1;
        } else if (rule) {
          await tx
            .update(bankStatementLines)
            .set({
              suggestedAccountId: rule.accountId,
              suggestedCostCenterId: rule.costCenterId,
              matchReason: `قاعدة: ${rule.keyword}`,
              updatedAt: new Date(),
              updatedBy: actorId(),
              version: line.version + 1,
            })
            .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.id, line.id), eq(bankStatementLines.version, line.version)));
          suggested += 1;
        }
      }
      await this.refreshStatementStatus(tx, tenantId, statementId);
      return { statementId, scanned: pending.length, matched, suggested, pending: pending.length - matched };
    });
  }

  async listRules(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(bankReconciliationRules).where(eq(bankReconciliationRules.tenantId, tenantId)).orderBy(asc(bankReconciliationRules.priority), asc(bankReconciliationRules.keyword)),
    );
  }

  async createRule(tenantId: string, input: BankRuleInput) {
    const keyword = normaliseText(input.keyword);
    if (!keyword) throw new DomainError('BANK_RULE_KEYWORD_REQUIRED', 'Rule keyword is required', 422, { field: 'keyword' });
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.assertAccount(tx, tenantId, input.accountId);
      await this.assertCostCenter(tx, tenantId, input.costCenterId);
      const [row] = await tx
        .insert(bankReconciliationRules)
        .values({ id: newId(), tenantId, keyword, accountId: input.accountId, costCenterId: input.costCenterId ?? null, priority: input.priority ?? 100, createdBy: actorId() })
        .returning();
      if (!row) throw new DomainError('BANK_RULE_CREATE_FAILED', 'Reconciliation rule could not be created', 500);
      return row;
    });
  }

  async updateRule(tenantId: string, id: string, input: Partial<BankRuleInput> & { status?: 'active' | 'inactive' }) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [current] = await tx.select().from(bankReconciliationRules).where(and(eq(bankReconciliationRules.tenantId, tenantId), eq(bankReconciliationRules.id, id))).limit(1);
      if (!current) throw new DomainError('BANK_RULE_NOT_FOUND', 'Reconciliation rule was not found', 404);
      await this.assertAccount(tx, tenantId, input.accountId);
      await this.assertCostCenter(tx, tenantId, input.costCenterId);
      const updates: Record<string, unknown> = { updatedAt: new Date(), updatedBy: actorId(), version: current.version + 1 };
      if (input.keyword !== undefined) updates.keyword = normaliseText(input.keyword);
      if (input.accountId !== undefined) updates.accountId = input.accountId;
      if (input.costCenterId !== undefined) updates.costCenterId = input.costCenterId || null;
      if (input.priority !== undefined) updates.priority = input.priority;
      if (input.status !== undefined) updates.status = input.status;
      const [row] = await tx.update(bankReconciliationRules).set(updates).where(and(eq(bankReconciliationRules.tenantId, tenantId), eq(bankReconciliationRules.id, id), eq(bankReconciliationRules.version, current.version))).returning();
      if (!row) throw new DomainError('VERSION_CONFLICT', 'Reconciliation rule was changed by another user', 409);
      return row;
    });
  }

  async deleteRule(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const result = await tx.delete(bankReconciliationRules).where(and(eq(bankReconciliationRules.tenantId, tenantId), eq(bankReconciliationRules.id, id))).returning({ id: bankReconciliationRules.id });
      if (!result[0]) throw new DomainError('BANK_RULE_NOT_FOUND', 'Reconciliation rule was not found', 404);
      return { id, deleted: true as const };
    });
  }

  async reconciliation(tenantId: string, input: { bankAccountId: string; from?: string; to?: string }) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const account = await this.mustBankAccount(tx, tenantId, input.bankAccountId);
      const conditions = [eq(bankStatementLines.tenantId, tenantId), eq(bankStatements.bankAccountId, input.bankAccountId)];
      if (input.from) conditions.push(gte(bankStatementLines.txnDate, input.from));
      if (input.to) conditions.push(lte(bankStatementLines.txnDate, input.to));
      const lines = await tx
        .select({ line: bankStatementLines, statement: bankStatements })
        .from(bankStatementLines)
        .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
        .where(and(...conditions))
        .orderBy(asc(bankStatementLines.txnDate), asc(bankStatementLines.lineNo));

      const firstStatement = lines[0]?.statement;
      const opening = money(firstStatement?.openingBalance ?? account.openingBalance);
      const bankMovement = lines.reduce((sum, row) => sum.plus(money(row.line.amount)), new Decimal(0));
      const matchedMovement = lines.filter((row) => row.line.status === 'matched').reduce((sum, row) => sum.plus(money(row.line.amount)), new Decimal(0));
      const unmatchedMovement = lines.filter((row) => row.line.status === 'pending').reduce((sum, row) => sum.plus(money(row.line.amount)), new Decimal(0));
      const lastWithBalance = [...lines].reverse().find((row) => row.line.balance !== null)?.line.balance;
      const bankBalance = lastWithBalance === undefined || lastWithBalance === null ? opening.plus(bankMovement) : money(lastWithBalance);

      let ledgerBalance = opening.plus(matchedMovement);
      let ledgerSource = 'matched bank lines';
      if (account.accountId) {
        const ledgerConditions = [
          eq(journalEntryLines.tenantId, tenantId),
          eq(journalEntryLines.accountId, account.accountId),
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.id, journalEntryLines.entryId),
          eq(journalEntries.status, 'posted'),
          input.from ? gte(journalEntries.date, input.from) : undefined,
          input.to ? lte(journalEntries.date, input.to) : undefined,
        ];
        const ledgerRows = await tx
          .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit })
          .from(journalEntryLines)
          .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
          .where(and(...ledgerConditions));
        const ledgerMovement = ledgerRows.reduce((sum, row) => sum.plus(money(row.debit).minus(money(row.credit))), new Decimal(0));
        ledgerBalance = opening.plus(ledgerMovement);
        ledgerSource = 'journal ledger';
      }

      return {
        bankAccountId: account.id,
        bankName: account.bankName,
        periodFrom: input.from ?? firstStatement?.periodFrom ?? null,
        periodTo: input.to ?? firstStatement?.periodTo ?? null,
        currency: account.currency,
        bankMovement: bankMovement.toFixed(4),
        bankBalance: bankBalance.toFixed(4),
        ledgerBalance: ledgerBalance.toFixed(4),
        ledgerSource,
        difference: bankBalance.minus(ledgerBalance).toFixed(4),
        matchedMovement: matchedMovement.toFixed(4),
        unmatchedMovement: unmatchedMovement.toFixed(4),
        matchedLines: lines.filter((row) => row.line.status === 'matched').length,
        pendingLines: lines.filter((row) => row.line.status === 'pending').length,
        ignoredLines: lines.filter((row) => row.line.status === 'ignored').length,
        statementCount: new Set(lines.map((row) => row.statement.id)).size,
        lineCount: lines.length,
      };
    });
  }

  private async candidates(tx: DrizzleTx, tenantId: string): Promise<BankMatchCandidate[]> {
    const [sales, purchases, voucherRows] = await Promise.all([
      tx
        .select({ id: salesInvoices.id, number: salesInvoices.number, total: salesInvoices.total, postedAt: salesInvoices.postedAt, createdAt: salesInvoices.createdAt, partyName: parties.name })
        .from(salesInvoices)
        .leftJoin(parties, eq(parties.id, salesInvoices.partyId))
        .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.status, 'posted')))
        .orderBy(desc(salesInvoices.createdAt))
        .limit(1000),
      tx
        .select({ id: purchaseInvoices.id, number: purchaseInvoices.number, total: purchaseInvoices.total, postedAt: purchaseInvoices.postedAt, createdAt: purchaseInvoices.createdAt, partyName: parties.name })
        .from(purchaseInvoices)
        .leftJoin(parties, eq(parties.id, purchaseInvoices.partyId))
        .where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.status, 'posted')))
        .orderBy(desc(purchaseInvoices.createdAt))
        .limit(1000),
      tx
        .select({ id: vouchers.id, number: vouchers.number, reference: vouchers.referenceNo, amount: vouchers.amount, date: vouchers.date, description: vouchers.description, partyName: parties.name, kind: vouchers.kind })
        .from(vouchers)
        .leftJoin(parties, eq(parties.id, vouchers.partyId))
        .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.status, 'posted')))
        .orderBy(desc(vouchers.date))
        .limit(1000),
    ]);

    const result: BankMatchCandidate[] = [];
    for (const row of sales) result.push({ id: row.id, type: 'sale', date: dateOnly(row.postedAt ?? row.createdAt), amount: row.total, number: row.number, partyName: row.partyName });
    for (const row of purchases) result.push({ id: row.id, type: 'purchase', date: dateOnly(row.postedAt ?? row.createdAt), amount: row.total, number: row.number, partyName: row.partyName });
    for (const row of voucherRows) result.push({ id: row.id, type: 'voucher', date: row.date, amount: row.amount, number: row.number, reference: row.reference, partyName: row.partyName, kind: row.kind === 'receipt' || row.kind === 'payment' ? row.kind : undefined });
    return result;
  }

  private async mustBankAccount(tx: DrizzleTx, tenantId: string, id: string) {
    const [row] = await tx.select().from(bankAccounts).where(and(eq(bankAccounts.tenantId, tenantId), eq(bankAccounts.id, id))).limit(1);
    if (!row) throw new DomainError('BANK_ACCOUNT_NOT_FOUND', 'Bank account was not found', 404);
    return row;
  }

  private async mustStatement(tx: DrizzleTx, tenantId: string, id: string) {
    const [row] = await tx.select().from(bankStatements).where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.id, id))).limit(1);
    if (!row) throw new DomainError('BANK_STATEMENT_NOT_FOUND', 'Bank statement was not found', 404);
    return row;
  }

  private async mustLine(tx: DrizzleTx, tenantId: string, statementId: string, id: string) {
    const [row] = await tx
      .select()
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.statementId, statementId), eq(bankStatementLines.id, id)))
      .limit(1);
    if (!row) throw new DomainError('BANK_LINE_NOT_FOUND', 'Bank statement line was not found', 404);
    return row;
  }

  private async assertAccount(tx: DrizzleTx, tenantId: string, id?: string | null) {
    if (!id) return;
    const [row] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id))).limit(1);
    if (!row) throw new DomainError('BANK_ACCOUNT_LEDGER_INVALID', 'Ledger account does not belong to this tenant', 422, { field: 'accountId' });
  }

  private async assertCostCenter(tx: DrizzleTx, tenantId: string, id?: string | null) {
    if (!id) return;
    const [row] = await tx.select({ id: costCenters.id }).from(costCenters).where(and(eq(costCenters.tenantId, tenantId), eq(costCenters.id, id))).limit(1);
    if (!row) throw new DomainError('BANK_COST_CENTER_INVALID', 'Cost center does not belong to this tenant', 422, { field: 'costCenterId' });
  }

  private async refreshStatementStatus(tx: DrizzleTx, tenantId: string, statementId: string): Promise<void> {
    const rows = await tx
      .select({ status: bankStatementLines.status })
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.statementId, statementId)));
    const status = rows.length > 0 && rows.every((row) => row.status !== 'pending') ? 'reconciled' : 'processed';
    await tx.update(bankStatements).set({ status, updatedAt: new Date(), version: sql`${bankStatements.version} + 1` }).where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.id, statementId)));
  }
}
