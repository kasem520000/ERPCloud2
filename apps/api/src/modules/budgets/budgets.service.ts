/* eslint-disable no-restricted-syntax -- money math is Decimal + decimal-text throughout; the name-based selector cannot see types. */
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  accounts,
  budgetLines,
  budgets,
  fiscalPeriods,
  fiscalYears,
  journalEntries,
  journalEntryLines,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';

export type BudgetAnnualLineInput = {
  accountId: string;
  /** المبلغ السنوي — يُوزَّع على فترات السنة (قسط متساوٍ والباقي في الأخيرة). */
  annualAmount: string;
};

export type BudgetMonthlyLineInput = {
  accountId: string;
  fiscalPeriodId: string;
  amount: string;
};

export type BudgetCreateInput = {
  name?: string;
  fiscalYearId?: string;
  notes?: string;
  lines?: BudgetAnnualLineInput[];
};

export type BudgetUpdateInput = {
  name?: string;
  notes?: string;
  status?: string;
  lines?: BudgetMonthlyLineInput[];
};

export type BudgetVarianceQuery = { to?: string };

const dec = (input: string | number | null | undefined) => new Decimal(input ?? 0);
const money = (value: Decimal) => value.toFixed(4);

/**
 * 📊 الموازنات — ميزانية سنةٍ مالية تُقارَن بالفعلي.
 *
 * القاعدة الأولى: **لا يُخزَّن رصيدٌ ثانٍ.** «الفعلي» هو حركة القيود المُرحَّلة لكل حساب
 * (قراءة ميزان المراجعة نفسها بإشارة الرصيد الطبيعي للحساب)، والموازنة سطورٌ تُجمع
 * بـSUM — فلا يوجد رقمٌ يمكن أن ينحرف عن الدفتر. والقاعدة الثانية: **الاعتماد يجمّد** —
 * الموازنة التي يُقاس الناس عليها لا تتحرك بصمت؛ التعديل للمسودة، والقراءة للجميع.
 *
 * التوزيع الشهري: القسط = السنوي ÷ عدد الفترات (HALF_UP بدقة 4)، والفترة الأخيرة تحمل
 * الباقي بالضبط فيتساوى المجموع مع المبلغ السنوي تساوياً تاماً — القاعدة ذاتها التي يستعملها
 * جدول إهلاك الأصول (M6.1).
 */
@Injectable()
export class BudgetsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async list(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: budgets.id,
          name: budgets.name,
          status: budgets.status,
          notes: budgets.notes,
          fiscalYearId: budgets.fiscalYearId,
          fiscalYearName: fiscalYears.name,
          fiscalYearStart: fiscalYears.startDate,
          fiscalYearEnd: fiscalYears.endDate,
          approvedAt: budgets.approvedAt,
          createdAt: budgets.createdAt,
          totalAmount: sql<string>`COALESCE((SELECT SUM(${budgetLines.amount}) FROM ${budgetLines} WHERE ${budgetLines.budgetId} = ${budgets.id}), 0)::text`,
        })
        .from(budgets)
        .innerJoin(fiscalYears, eq(fiscalYears.id, budgets.fiscalYearId))
        .where(and(eq(budgets.tenantId, tenantId), isNull(budgets.deletedAt)))
        .orderBy(asc(fiscalYears.startDate), asc(budgets.name));
      return rows.map((row) => ({ ...row, totalAmount: money(dec(row.totalAmount)) }));
    });
  }

  async read(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, (tx) => this.loadInTx(tx, tenantId, id));
  }

  /** البطاقة الكاملة داخل معاملة قائمة — تُستعمل من الإنشاء والتعديل ومن القراءة سواء. */
  private async loadInTx(tx: DrizzleTx, tenantId: string, id: string) {
    const [budget] = await tx
        .select({
          id: budgets.id,
          name: budgets.name,
          status: budgets.status,
          notes: budgets.notes,
          fiscalYearId: budgets.fiscalYearId,
          fiscalYearName: fiscalYears.name,
          fiscalYearStart: fiscalYears.startDate,
          fiscalYearEnd: fiscalYears.endDate,
          approvedAt: budgets.approvedAt,
        })
        .from(budgets)
        .innerJoin(fiscalYears, eq(fiscalYears.id, budgets.fiscalYearId))
        .where(and(eq(budgets.tenantId, tenantId), eq(budgets.id, id), isNull(budgets.deletedAt)));
      if (!budget) throw new DomainError('BUDGET_NOT_FOUND', 'الموازنة غير موجودة في هذه المنشأة', 404, { field: 'id' });

      const lines = await tx
        .select({
          id: budgetLines.id,
          accountId: budgetLines.accountId,
          accountCode: accounts.code,
          accountNameAr: accounts.nameAr,
          accountType: accounts.type,
          fiscalPeriodId: budgetLines.fiscalPeriodId,
          periodName: fiscalPeriods.name,
          periodStart: fiscalPeriods.startDate,
          periodEnd: fiscalPeriods.endDate,
          amount: budgetLines.amount,
        })
        .from(budgetLines)
        .innerJoin(accounts, eq(accounts.id, budgetLines.accountId))
        .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, budgetLines.fiscalPeriodId))
        .where(and(eq(budgetLines.tenantId, tenantId), eq(budgetLines.budgetId, id)))
        .orderBy(asc(accounts.code), asc(fiscalPeriods.startDate));

    const totalAmount = lines.reduce((sum, row) => sum.plus(dec(row.amount)), new Decimal(0));
    return { ...budget, lines, totalAmount: money(totalAmount) };
  }

  async create(tenantId: string, input: BudgetCreateInput, actorId?: string) {
    const name = (input.name ?? '').trim();
    if (!name) throw new DomainError('BUDGET_NAME_REQUIRED', 'اسم الموازنة مطلوب', 422, { field: 'name' });
    if (!input.fiscalYearId) throw new DomainError('BUDGET_FISCAL_YEAR_REQUIRED', 'السنة المالية مطلوبة', 422, { field: 'fiscalYearId' });
    const annualLines = (input.lines ?? []).filter((line) => line);
    if (annualLines.length === 0)
      throw new DomainError('BUDGET_LINES_REQUIRED', 'الموازنة تحتاج حساباً واحداً على الأقل', 422, { field: 'lines' });

    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [year] = await tx
        .select({ id: fiscalYears.id })
        .from(fiscalYears)
        .where(and(eq(fiscalYears.tenantId, tenantId), eq(fiscalYears.id, input.fiscalYearId!)));
      if (!year) throw new DomainError('BUDGET_FISCAL_YEAR_NOT_FOUND', 'السنة المالية غير موجودة في هذه المنشأة', 404, { field: 'fiscalYearId' });

      await this.assertNameFree(tx, tenantId, input.fiscalYearId!, name);

      // الحسابات: ملك المنشأة وقابلة للترحيل وغير محذوفة — والتكرار مرفوض.
      const accountIds = annualLines.map((line) => line.accountId);
      const seen = new Set<string>();
      for (const accountId of accountIds) {
        if (seen.has(accountId))
          throw new DomainError('BUDGET_LINE_DUPLICATE', 'كل حساب يظهر مرة واحدة في الموازنة؛ ادمج المبالغ', 422, { field: 'lines' });
        seen.add(accountId);
      }
      await this.assertAccountsUsable(tx, tenantId, accountIds);
      for (const line of annualLines) {
        const annual = dec(line.annualAmount);
        if (!annual.isFinite() || annual.lte(0))
          throw new DomainError('BUDGET_AMOUNT_INVALID', 'المبلغ السنوي يجب أن يكون أكبر من صفر', 422, { field: 'lines' });
      }

      // التوزيع: قسط متساوٍ على فترات السنة، والأخيرة تحمل الباقي بالضبط.
      const periods = await tx
        .select({ id: fiscalPeriods.id })
        .from(fiscalPeriods)
        .where(and(eq(fiscalPeriods.tenantId, tenantId), eq(fiscalPeriods.fiscalYearId, input.fiscalYearId!)))
        .orderBy(asc(fiscalPeriods.startDate));
      if (periods.length === 0)
        throw new DomainError('BUDGET_YEAR_HAS_NO_PERIODS', 'السنة المالية بلا فترات — لا يمكن توزيع الموازنة عليها', 422, { field: 'fiscalYearId' });

      const rows: Array<{ id: string; budgetId: string; accountId: string; fiscalPeriodId: string; amount: string }> = [];
      for (const line of annualLines) {
        const annual = dec(line.annualAmount);
        const instalment = annual.div(periods.length).toDP(4, Decimal.ROUND_HALF_UP);
        let distributed = new Decimal(0);
        periods.forEach((period, index) => {
          const isLast = index === periods.length - 1;
          const amount = isLast ? annual.minus(distributed) : instalment;
          distributed = distributed.plus(amount);
          if (amount.lt(0)) return; // فترة معدومة القيمة — لا سطر بضجيج صفر
          rows.push({ id: newId(), budgetId: id, accountId: line.accountId, fiscalPeriodId: period.id, amount: money(amount) });
        });
      }

      await tx.insert(budgets).values({
        id,
        tenantId,
        name,
        fiscalYearId: input.fiscalYearId!,
        status: 'draft',
        notes: input.notes?.trim() || null,
        createdBy: actorId ?? tryGetAuthContext()?.userId,
      });
      if (rows.length > 0) {
        await tx.insert(budgetLines).values(rows.map((row) => ({ ...row, tenantId, createdBy: actorId ?? tryGetAuthContext()?.userId })));
      }
      return this.loadInTx(tx, tenantId, id);
    });
  }

  async update(tenantId: string, id: string, input: BudgetUpdateInput, actorId?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [budget] = await tx
        .select({ id: budgets.id, name: budgets.name, status: budgets.status, fiscalYearId: budgets.fiscalYearId })
        .from(budgets)
        .where(and(eq(budgets.tenantId, tenantId), eq(budgets.id, id), isNull(budgets.deletedAt)));
      if (!budget) throw new DomainError('BUDGET_NOT_FOUND', 'الموازنة غير موجودة في هذه المنشأة', 404, { field: 'id' });

      const patch: Partial<typeof budgets.$inferInsert> = { updatedAt: new Date(), updatedBy: actorId ?? tryGetAuthContext()?.userId };

      const name = input.name?.trim();
      if (name !== undefined) {
        if (!name) throw new DomainError('BUDGET_NAME_REQUIRED', 'اسم الموازنة مطلوب', 422, { field: 'name' });
        if (name !== budget.name) await this.assertNameFree(tx, tenantId, budget.fiscalYearId, name);
        patch.name = name;
      }
      if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

      if (input.status !== undefined) {
        if (input.status !== 'approved')
          throw new DomainError('BUDGET_STATUS_INVALID', 'الحالة الوحيدة المتاحة للتغيير هي الاعتماد (approved)', 422, { field: 'status' });
        if (budget.status === 'approved')
          throw new DomainError('BUDGET_ALREADY_APPROVED', 'الموازنة معتمدة أصلًا', 409, { field: 'status' });
        patch.status = 'approved';
        patch.approvedAt = new Date();
        patch.approvedBy = actorId ?? tryGetAuthContext()?.userId;
      }

      if (input.lines !== undefined) {
        if (budget.status === 'approved')
          throw new DomainError('BUDGET_APPROVED_FROZEN', 'الموازنة المعتمدة مجمدة — سطورها لا تُعدَّل', 409, { field: 'lines' });
        await this.replaceLines(tx, tenantId, id, budget.fiscalYearId, input.lines);
      }

      await tx.update(budgets).set(patch).where(and(eq(budgets.tenantId, tenantId), eq(budgets.id, id)));
      return this.loadInTx(tx, tenantId, id);
    });
  }

  async remove(tenantId: string, id: string, actorId?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [budget] = await tx
        .select({ id: budgets.id, status: budgets.status })
        .from(budgets)
        .where(and(eq(budgets.tenantId, tenantId), eq(budgets.id, id), isNull(budgets.deletedAt)));
      if (!budget) throw new DomainError('BUDGET_NOT_FOUND', 'الموازنة غير موجودة في هذه المنشأة', 404, { field: 'id' });
      // المعتمدة أثرٌ محاسبي مُقاسٌ عليه — تُرخَّم لا تُحذف؛ والمسودة خطأُ كتابة يُصحَّح.
      if (budget.status !== 'draft')
        throw new DomainError('BUDGET_APPROVED_FROZEN', 'الموازنة المعتمدة لا تُحذف — احذف سطورها بالمقارنة أو أرشفها في التقارير', 409);
      await tx
        .update(budgets)
        .set({ deletedAt: new Date(), deletedBy: actorId ?? tryGetAuthContext()?.userId, updatedAt: new Date(), updatedBy: actorId ?? tryGetAuthContext()?.userId })
        .where(and(eq(budgets.tenantId, tenantId), eq(budgets.id, id)));
      return { id, status: 'deleted' };
    });
  }

  /**
   * 📊 الموازنة مقابل الفعلي — التقرير المحسوب لا المخزَّن.
   *
   * الموازنة = Σ سطور الفترات **المنقضية كاملةً** حتى `to` (فترةٌ ناقصة لا تُحسب
   * موازنتها والفعلي ناقص)؛ والفعلي = حركة القيود المُرحَّلة على الحساب في
   * [بداية السنة، to] بإشارة رصيده الطبيعي (مدين: مدين−دائن، دائن: دائن−مدين).
   * `to` الافتراضي نهاية السنة، ولا يتجاوزها أبدًا. والانحراف = الموازنة − الفعلي.
   */
  async variance(tenantId: string, id: string, query: BudgetVarianceQuery = {}) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [budget] = await tx
        .select({
          id: budgets.id,
          name: budgets.name,
          status: budgets.status,
          fiscalYearId: budgets.fiscalYearId,
          fiscalYearName: fiscalYears.name,
          from: fiscalYears.startDate,
          to: fiscalYears.endDate,
        })
        .from(budgets)
        .innerJoin(fiscalYears, eq(fiscalYears.id, budgets.fiscalYearId))
        .where(and(eq(budgets.tenantId, tenantId), eq(budgets.id, id), isNull(budgets.deletedAt)));
      if (!budget) throw new DomainError('BUDGET_NOT_FOUND', 'الموازنة غير موجودة في هذه المنشأة', 404, { field: 'id' });

      const to = query.to && query.to < budget.to ? query.to : budget.to;

      const budgetedRows = await tx
        .select({
          accountId: budgetLines.accountId,
          budgeted: sql<string>`COALESCE(SUM(${budgetLines.amount}), 0)::text`,
        })
        .from(budgetLines)
        .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, budgetLines.fiscalPeriodId))
        .where(and(eq(budgetLines.tenantId, tenantId), eq(budgetLines.budgetId, id), lte(fiscalPeriods.endDate, to)))
        .groupBy(budgetLines.accountId);

      const movement = await tx
        .select({
          accountId: journalEntryLines.accountId,
          debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)::text`,
          credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)::text`,
        })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
        .where(
          and(
            eq(journalEntryLines.tenantId, tenantId),
            eq(journalEntries.status, 'posted'),
            sql`${journalEntries.date} >= ${budget.from}`,
            sql`${journalEntries.date} <= ${to}`,
          ),
        )
        .groupBy(journalEntryLines.accountId);

      const referenced = new Set([...budgetedRows.map((row) => row.accountId), ...movement.map((row) => row.accountId)]);
      const cards = referenced.size
        ? await tx
            .select({ id: accounts.id, code: accounts.code, nameAr: accounts.nameAr, type: accounts.type, normalBalance: accounts.normalBalance })
            .from(accounts)
            .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, [...referenced])))
        : [];
      const card = new Map(cards.map((row) => [row.id, row]));
      const budgetedByAccount = new Map(budgetedRows.map((row) => [row.accountId, dec(row.budgeted)]));
      const movementByAccount = new Map(movement.map((row) => [row.accountId, row]));

      const rows = [...referenced]
        .map((accountId) => {
          const info = card.get(accountId);
          if (!info) return null; // حسابٌ محذوف من الدليل بعد الترحيل — لا يُعرض بلا بطاقة
          const budgeted = budgetedByAccount.get(accountId) ?? new Decimal(0);
          const moved = movementByAccount.get(accountId);
          const debit = dec(moved?.debit);
          const credit = dec(moved?.credit);
          const actual = info.normalBalance === 'credit' ? credit.minus(debit) : debit.minus(credit);
          const variance = budgeted.minus(actual);
          const pct = budgeted.gt(0) ? variance.div(budgeted).times(100).toDP(2, Decimal.ROUND_HALF_UP) : null;
          return {
            accountId,
            accountCode: info.code,
            accountNameAr: info.nameAr,
            accountType: info.type,
            normalBalance: info.normalBalance,
            budgeted: money(budgeted),
            actual: money(actual),
            variance: money(variance),
            variancePct: pct === null ? null : pct.toFixed(2),
            inBudget: budgetedRows.some((row) => row.accountId === accountId),
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

      /**
       * نتيجة الموازنة: إيرادات − مصروفات (الحسابات الربحية وحدها — خلط الأصول
       * والخصوم في مجموعٍ واحد لا معنى محاسبياً له). الانحراف = النتيجة الموازنة −
       * النتيجة الفعلية: موجبٌ يعني أداءً أفضل من الخطة.
       */
      let budgetedResult = new Decimal(0);
      let actualResult = new Decimal(0);
      for (const row of rows) {
        if (row.accountType !== 'revenue' && row.accountType !== 'expense') continue;
        const budgeted = dec(row.budgeted);
        const actual = dec(row.actual);
        budgetedResult = row.accountType === 'revenue' ? budgetedResult.plus(budgeted) : budgetedResult.minus(budgeted);
        actualResult = row.accountType === 'revenue' ? actualResult.plus(actual) : actualResult.minus(actual);
      }

      return {
        budget: { id: budget.id, name: budget.name, status: budget.status, fiscalYearName: budget.fiscalYearName },
        from: budget.from,
        to,
        rows,
        totals: { budgetedResult: money(budgetedResult), actualResult: money(actualResult), variance: money(budgetedResult.minus(actualResult)) },
      };
    });
  }

  // ─────────────────────────────────────────────────────────────ـ حارسات

  private async assertNameFree(tx: DrizzleTx, tenantId: string, fiscalYearId: string, name: string) {
    const [clash] = await tx
      .select({ id: budgets.id })
      .from(budgets)
      .where(
        and(
          eq(budgets.tenantId, tenantId),
          eq(budgets.fiscalYearId, fiscalYearId),
          eq(budgets.name, name),
          isNull(budgets.deletedAt),
        ),
      )
      .limit(1);
    if (clash) throw new DomainError('BUDGET_NAME_TAKEN', 'اسم الموازنة مستخدم في هذه السنة المالية', 409, { field: 'name' });
  }

  /** حسابات الموازنة: ملك المنشأة، قابلة للترحيل، وغير محذوفة. */
  private async assertAccountsUsable(tx: DrizzleTx, tenantId: string, accountIds: string[]) {
    const found = await tx
      .select({ id: accounts.id, isPostable: accounts.isPostable, deletedAt: accounts.deletedAt })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, accountIds)));
    const byId = new Map(found.map((row) => [row.id, row]));
    for (const accountId of accountIds) {
      const row = byId.get(accountId);
      if (!row) throw new DomainError('BUDGET_ACCOUNT_NOT_FOUND', 'أحد حسابات الموازنة غير موجود في هذه المنشأة', 404, { field: 'lines' });
      if (!row.isPostable || row.deletedAt)
        throw new DomainError('BUDGET_ACCOUNT_NOT_POSTABLE', 'حسابات الموازنة يجب أن تكون قابلة للترحيل وغير محذوفة', 422, { field: 'lines' });
    }
  }

  /** استبدال السطور الشهرية كاملة — للمسودة فقط، ولفترات السنة نفسها. */
  private async replaceLines(tx: DrizzleTx, tenantId: string, budgetId: string, fiscalYearId: string, lines: BudgetMonthlyLineInput[]) {
    if (lines.length === 0)
      throw new DomainError('BUDGET_LINES_REQUIRED', 'الموازنة تحتاج حساباً واحداً على الأقل', 422, { field: 'lines' });
    const seen = new Set<string>();
    for (const line of lines) {
      const key = `${line.accountId}:${line.fiscalPeriodId}`;
      if (seen.has(key))
        throw new DomainError('BUDGET_LINE_DUPLICATE', 'لكل حسابٍ وفترة سطرٌ واحد؛ ادمج المبالغ', 422, { field: 'lines' });
      seen.add(key);
      const amount = dec(line.amount);
      if (!amount.isFinite() || amount.lt(0))
        throw new DomainError('BUDGET_AMOUNT_INVALID', 'مبلغ السطر يجب أن يكون صفراً أو أكثر', 422, { field: 'lines' });
    }

    const periods = await tx
      .select({ id: fiscalPeriods.id })
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.tenantId, tenantId), eq(fiscalPeriods.fiscalYearId, fiscalYearId)));
    const yearPeriods = new Set(periods.map((period) => period.id));
    for (const line of lines) {
      if (!yearPeriods.has(line.fiscalPeriodId))
        throw new DomainError('BUDGET_PERIOD_INVALID', 'فترةٌ من سنةٍ أخرى — سطور الموازنة من فترات سنتها', 422, { field: 'lines' });
    }
    await this.assertAccountsUsable(tx, tenantId, [...new Set(lines.map((line) => line.accountId))]);

    await tx.delete(budgetLines).where(and(eq(budgetLines.tenantId, tenantId), eq(budgetLines.budgetId, budgetId)));
    await tx.insert(budgetLines).values(
      lines.map((line) => ({ id: newId(), tenantId, budgetId, accountId: line.accountId, fiscalPeriodId: line.fiscalPeriodId, amount: money(dec(line.amount)) })),
    );
  }
}
