/* eslint-disable no-restricted-syntax -- money math is Decimal + decimal-text throughout; the name-based selector cannot see types. */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import {
  accounts,
  assetCategories,
  assetDepreciationEntries,
  branches,
  fixedAssets,
  journalEntries,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { AccountingService, type JournalLineInput } from '../accounting/accounting.service.js';

Decimal.set({ precision: 20 });

/**
 * 🏢 الأصول الثابتة (M6.1) — السجل والتصنيفات وجدول الإهلاك وترحيله الشهري.
 *
 * وحدة معزولة بحكم التصميم (خارطة الطريق M6.1): تملك جداولها الثلاثة (ترحيل 0129)
 * وتقرأ دليل الحسابات، لكنها لا تكتب الأستاذ العام بنفسها أبدًا — كل ترحيل إهلاك
 * يمرّ حصرًا عبر `AccountingService.postJournalInTx`، فيبقى توازن القيود وقفل الفترة
 * المفتوحة وأقفال الوحدات والتسلسل في مكان واحد.
 *
 * الرياضيات (قسط ثابت):
 *   * الشهر الأول = شهر تاريخ الاقتناء؛ عدد الأقساط = عمر الأصل بالأشهر.
 *   * قسط الشهر = (التكلفة − الخردة) ÷ العمر، مقرّبًا لأربعة منازل.
 *   * قسط الشهر الأخير = الباقي بالضبط، فيساوي مجموع الأقساط (التكلفة − الخردة)
 *     تساويًا تامًا لا تقريبًا — سلامة الأستاذ تبقى محفوظة.
 *
 * التكرار (idempotency): القيد الفريد (tenant, asset, period) على
 * `asset_depreciation_entries` هو بوابة التشغيل: إعادة تشغيل نفس الشهر لا تنشئ
 * شيئًا، والأصول المُستوفاة تُتخطى بقائمة معلنة لا بصمت.
 */

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export type AssetCategoryInput = {
  code?: string;
  nameAr?: string;
  nameEn?: string;
  defaultUsefulLifeMonths?: number | string;
  assetAccountId?: string;
  accumulatedAccountId?: string;
  depreciationAccountId?: string;
  notes?: string;
};

export type FixedAssetInput = {
  code?: string;
  nameAr?: string;
  nameEn?: string;
  categoryId?: string;
  branchId?: string;
  acquisitionDate?: string;
  acquisitionCost?: string;
  salvageValue?: string;
  usefulLifeMonths?: number | string;
  assetAccountId?: string;
  accumulatedAccountId?: string;
  depreciationAccountId?: string;
  notes?: string;
};

export type DepreciationRunInput = {
  period?: string;
  date?: string;
  branchId?: string;
  fiscalPeriodId?: string;
  assetIds?: string[];
  description?: string;
};

function dec(value: unknown): Decimal {
  return new Decimal(String(value ?? '0'));
}

function monthOf(dateText: string): string {
  return dateText.slice(0, 7);
}

function yearOf(period: string): number {
  return Number(period.slice(0, 4));
}

function monthOfPeriod(period: string): number {
  return Number(period.slice(5, 7));
}

function addMonths(period: string, months: number): string {
  const total = yearOf(period) * 12 + (monthOfPeriod(period) - 1) + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
}

function monthsBetween(from: string, to: string): number {
  return yearOf(to) * 12 + monthOfPeriod(to) - (yearOf(from) * 12 + monthOfPeriod(from));
}

function periodEndDate(period: string): string {
  const next = addMonths(period, 1);
  const lastDay = new Date(Date.UTC(yearOf(next), monthOfPeriod(next) - 1, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, '0')}`;
}

@Injectable()
export class FixedAssetsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly accounting: AccountingService,
  ) {}

  // ─────────────────────────────────────────────────────────────── التصنيفات

  async listCategories(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rowsList = await tx
        .select()
        .from(assetCategories)
        .where(and(eq(assetCategories.tenantId, tenantId), isNull(assetCategories.deletedAt)))
        .orderBy(asc(assetCategories.code));
      return rowsList.map((row) => ({
        ...row,
        defaultUsefulLifeMonths: row.defaultUsefulLifeMonths,
        assetCount: 0,
      }));
    });
  }

  async createCategory(tenantId: string, input: AssetCategoryInput, actorId?: string) {
    const code = (input.code ?? '').trim();
    const nameAr = (input.nameAr ?? '').trim();
    const life = Number(input.defaultUsefulLifeMonths);
    if (!code) throw new DomainError(errorCodes.VALIDATION_FAILED, 'رمز التصنيف مطلوب', 422, { field: 'code' });
    if (!nameAr) throw new DomainError(errorCodes.VALIDATION_FAILED, 'اسم التصنيف مطلوب', 422, { field: 'nameAr' });
    if (!Number.isInteger(life) || life <= 0)
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'عمر الإهلاك الافتراضي يجب أن يكون عددًا صحيحًا موجبًا من الأشهر', 422, {
        field: 'defaultUsefulLifeMonths',
      });

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.assertAccountsUsable(tx, tenantId, [
        input.assetAccountId,
        input.accumulatedAccountId,
        input.depreciationAccountId,
      ]);
      const [duplicate] = await tx
        .select({ id: assetCategories.id })
        .from(assetCategories)
        .where(and(eq(assetCategories.tenantId, tenantId), eq(assetCategories.code, code)));
      if (duplicate)
        throw new DomainError('ASSET_CATEGORY_CODE_TAKEN', 'رمز التصنيف مستخدم من قبل في هذه المنشأة', 409, { field: 'code' });

      const id = newId();
      await tx.insert(assetCategories).values({
        id,
        tenantId,
        code,
        nameAr,
        nameEn: input.nameEn?.trim() || null,
        defaultUsefulLifeMonths: life,
        assetAccountId: input.assetAccountId || null,
        accumulatedAccountId: input.accumulatedAccountId || null,
        depreciationAccountId: input.depreciationAccountId || null,
        notes: input.notes?.trim() || null,
        createdBy: actorId ?? null,
        updatedBy: actorId ?? null,
      });
      return (await tx.select().from(assetCategories).where(eq(assetCategories.id, id)))[0];
    });
  }

  async updateCategory(tenantId: string, id: string, patch: AssetCategoryInput, actorId?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(assetCategories)
        .where(and(eq(assetCategories.tenantId, tenantId), eq(assetCategories.id, id), isNull(assetCategories.deletedAt)));
      if (!existing) throw new DomainError(errorCodes.NOT_FOUND, 'التصنيف غير موجود', 404, { field: 'id' });

      if (patch.code !== undefined && patch.code.trim() !== existing.code) {
        const code = patch.code.trim();
        const [duplicate] = await tx
          .select({ id: assetCategories.id })
          .from(assetCategories)
          .where(and(eq(assetCategories.tenantId, tenantId), eq(assetCategories.code, code)));
        if (duplicate) throw new DomainError('ASSET_CATEGORY_CODE_TAKEN', 'رمز التصنيف مستخدم من قبل', 409, { field: 'code' });
      }
      if (patch.defaultUsefulLifeMonths !== undefined) {
        const life = Number(patch.defaultUsefulLifeMonths);
        if (!Number.isInteger(life) || life <= 0)
          throw new DomainError(errorCodes.VALIDATION_FAILED, 'عمر الإهلاك الافتراضي يجب أن يكون عددًا صحيحًا موجبًا', 422, {
            field: 'defaultUsefulLifeMonths',
          });
      }
      await this.assertAccountsUsable(tx, tenantId, [
        patch.assetAccountId,
        patch.accumulatedAccountId,
        patch.depreciationAccountId,
      ]);

      await tx
        .update(assetCategories)
        .set({
          ...(patch.code !== undefined ? { code: patch.code.trim() } : {}),
          ...(patch.nameAr !== undefined ? { nameAr: patch.nameAr.trim() } : {}),
          ...(patch.nameEn !== undefined ? { nameEn: patch.nameEn?.trim() || null } : {}),
          ...(patch.defaultUsefulLifeMonths !== undefined
            ? { defaultUsefulLifeMonths: Number(patch.defaultUsefulLifeMonths) }
            : {}),
          ...(patch.assetAccountId !== undefined ? { assetAccountId: patch.assetAccountId || null } : {}),
          ...(patch.accumulatedAccountId !== undefined ? { accumulatedAccountId: patch.accumulatedAccountId || null } : {}),
          ...(patch.depreciationAccountId !== undefined ? { depreciationAccountId: patch.depreciationAccountId || null } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
          updatedBy: actorId ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(assetCategories.tenantId, tenantId), eq(assetCategories.id, id)));
      return (await tx.select().from(assetCategories).where(eq(assetCategories.id, id)))[0];
    });
  }

  // ─────────────────────────────────────────────────────────────── السجل

  async listAssets(tenantId: string, query: { q?: string; categoryId?: string; status?: string } = {}) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rowsList = await tx
        .select()
        .from(fixedAssets)
        .where(and(eq(fixedAssets.tenantId, tenantId), isNull(fixedAssets.deletedAt)))
        .orderBy(asc(fixedAssets.code));
      const posted = await tx
        .select({
          assetId: assetDepreciationEntries.assetId,
          amount: sql<string>`SUM(${assetDepreciationEntries.amount})`,
          months: sql<number>`COUNT(*)::int`,
          lastPeriod: sql<string>`MAX(${assetDepreciationEntries.period})`,
        })
        .from(assetDepreciationEntries)
        .where(eq(assetDepreciationEntries.tenantId, tenantId))
        .groupBy(assetDepreciationEntries.assetId);
      const byAsset = new Map(posted.map((row) => [row.assetId, row]));

      const needle = (query.q ?? '').trim().toLowerCase();
      return rowsList
        .filter((row) => (query.categoryId ? row.categoryId === query.categoryId : true))
        .filter((row) => (query.status ? row.status === query.status : true))
        .filter((row) =>
          needle
            ? row.code.toLowerCase().includes(needle) ||
              row.nameAr.toLowerCase().includes(needle) ||
              (row.nameEn ?? '').toLowerCase().includes(needle)
            : true,
        )
        .map((row) => {
          const summary = byAsset.get(row.id);
          const accumulated = dec(summary?.amount ?? '0');
          const cost = dec(row.acquisitionCost);
          return {
            ...row,
            accumulatedDepreciation: accumulated.toFixed(4),
            netBookValue: cost.minus(accumulated).toFixed(4),
            depreciatedMonths: summary?.months ?? 0,
            lastPostedPeriod: summary?.lastPeriod ?? null,
          };
        });
    });
  }

  async readAsset(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(fixedAssets)
        .where(and(eq(fixedAssets.tenantId, tenantId), eq(fixedAssets.id, id), isNull(fixedAssets.deletedAt)));
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'الأصل غير موجود في هذه المنشأة', 404, { field: 'id' });
      const schedule = await this.scheduleRows(tx, tenantId, row);
      const accumulated = schedule.reduce((sum, entry) => sum.plus(entry.postedAmount), new Decimal(0));
      return {
        asset: {
          ...row,
          accumulatedDepreciation: accumulated.toFixed(4),
          netBookValue: dec(row.acquisitionCost).minus(accumulated).toFixed(4),
        },
        schedule,
      };
    });
  }

  async createAsset(tenantId: string, input: FixedAssetInput, actorId?: string) {
    const code = (input.code ?? '').trim();
    const nameAr = (input.nameAr ?? '').trim();
    if (!code) throw new DomainError(errorCodes.VALIDATION_FAILED, 'رمز الأصل مطلوب', 422, { field: 'code' });
    if (!nameAr) throw new DomainError(errorCodes.VALIDATION_FAILED, 'اسم الأصل مطلوب', 422, { field: 'nameAr' });
    if (!input.categoryId) throw new DomainError(errorCodes.VALIDATION_FAILED, 'التصنيف مطلوب', 422, { field: 'categoryId' });
    if (!input.acquisitionDate || Number.isNaN(Date.parse(input.acquisitionDate)))
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'تاريخ اقتناء غير صالح (YYYY-MM-DD)', 422, { field: 'acquisitionDate' });
    const cost = dec(input.acquisitionCost);
    if (cost.lte(0)) throw new DomainError(errorCodes.VALIDATION_FAILED, 'تكلفة الاقتناء يجب أن تكون أكبر من صفر', 422, { field: 'acquisitionCost' });
    const salvage = dec(input.salvageValue ?? '0');
    if (salvage.lt(0) || salvage.gt(cost))
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'قيمة الخردة يجب أن تكون بين صفر والتكلفة', 422, { field: 'salvageValue' });

    const categoryId = input.categoryId;
    const acquisitionDate = input.acquisitionDate;
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [category] = await tx
        .select()
        .from(assetCategories)
        .where(
          and(
            eq(assetCategories.tenantId, tenantId),
            eq(assetCategories.id, categoryId),
            isNull(assetCategories.deletedAt),
          ),
        );
      if (!category) throw new DomainError(errorCodes.NOT_FOUND, 'التصنيف غير موجود في هذه المنشأة', 404, { field: 'categoryId' });

      const life = input.usefulLifeMonths !== undefined ? Number(input.usefulLifeMonths) : category.defaultUsefulLifeMonths;
      if (!Number.isInteger(life) || life <= 0)
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'عمر الإهلاك بالأشهر يجب أن يكون عددًا صحيحًا موجبًا', 422, {
          field: 'usefulLifeMonths',
        });

      await this.assertAccountsUsable(tx, tenantId, [
        input.assetAccountId,
        input.accumulatedAccountId,
        input.depreciationAccountId,
      ]);
      if (input.branchId) {
        const [branch] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.tenantId, tenantId), eq(branches.id, input.branchId)));
        if (!branch) throw new DomainError(errorCodes.NOT_FOUND, 'الفرع غير موجود في هذه المنشأة', 404, { field: 'branchId' });
      }

      const [duplicate] = await tx
        .select({ id: fixedAssets.id })
        .from(fixedAssets)
        .where(and(eq(fixedAssets.tenantId, tenantId), eq(fixedAssets.code, code)));
      if (duplicate) throw new DomainError('ASSET_CODE_TAKEN', 'رمز الأصل مستخدم من قبل في هذه المنشأة', 409, { field: 'code' });

      const id = newId();
      await tx.insert(fixedAssets).values({
        id,
        tenantId,
        code,
        nameAr,
        nameEn: input.nameEn?.trim() || null,
        categoryId,
        branchId: input.branchId || null,
        acquisitionDate,
        acquisitionCost: cost.toFixed(4),
        salvageValue: salvage.toFixed(4),
        usefulLifeMonths: life,
        assetAccountId: input.assetAccountId || null,
        accumulatedAccountId: input.accumulatedAccountId || null,
        depreciationAccountId: input.depreciationAccountId || null,
        notes: input.notes?.trim() || null,
        createdBy: actorId ?? null,
        updatedBy: actorId ?? null,
      });
      return (await tx.select().from(fixedAssets).where(eq(fixedAssets.id, id)))[0];
    });
  }

  // ──────────────────────────────────────────────────────────── جدول الإهلاك

  /**
   * الجدول الكامل: قسط كل شهر من شهر الاقتناء حتى نهاية العمر، ومعه ما رُحِّل فعلًا
   * (رقم القيد وتاريخه) — الفرق بين المخطط والمرحّل مرئي دائمًا لا مفترض.
   */
  private async scheduleRows(tx: DrizzleTx, tenantId: string, asset: typeof fixedAssets.$inferSelect) {
    const posted = await tx
      .select({
        period: assetDepreciationEntries.period,
        amount: assetDepreciationEntries.amount,
        journalEntryId: assetDepreciationEntries.journalEntryId,
        depreciationDate: assetDepreciationEntries.depreciationDate,
      })
      .from(assetDepreciationEntries)
      .where(and(eq(assetDepreciationEntries.tenantId, tenantId), eq(assetDepreciationEntries.assetId, asset.id)));
    const journalIds = posted.map((row) => row.journalEntryId);
    const journals = journalIds.length
      ? await tx
          .select({ id: journalEntries.id, number: journalEntries.number })
          .from(journalEntries)
          .where(and(eq(journalEntries.tenantId, tenantId), inArray(journalEntries.id, journalIds)))
      : [];
    const journalNumbers = new Map(journals.map((row) => [row.id, row.number]));
    const postedByPeriod = new Map(posted.map((row) => [row.period, row]));

    const depreciable = dec(asset.acquisitionCost).minus(dec(asset.salvageValue));
    const monthly = depreciable.div(asset.usefulLifeMonths).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    const rows: Array<{
      period: string;
      plannedAmount: string;
      postedAmount: string;
      posted: boolean;
      journalEntryId: string | null;
      journalNumber: string | null;
      depreciationDate: string | null;
    }> = [];
    const firstPeriod = monthOf(asset.acquisitionDate);
    for (let index = 0; index < asset.usefulLifeMonths; index += 1) {
      const period = addMonths(firstPeriod, index);
      const planned = index === asset.usefulLifeMonths - 1 ? depreciable.minus(monthly.times(asset.usefulLifeMonths - 1)) : monthly;
      const entry = postedByPeriod.get(period);
      rows.push({
        period,
        plannedAmount: planned.toFixed(4),
        postedAmount: entry ? dec(entry.amount).toFixed(4) : '0.0000',
        posted: Boolean(entry),
        journalEntryId: entry?.journalEntryId ?? null,
        journalNumber: entry ? journalNumbers.get(entry.journalEntryId) ?? null : null,
        depreciationDate: entry?.depreciationDate ?? null,
      });
    }
    return rows;
  }

  async schedule(tenantId: string, assetId: string) {
    const card = await this.readAsset(tenantId, assetId);
    return { asset: card.asset, schedule: card.schedule };
  }

  // ──────────────────────────────────────────────────────── تشغيل الإهلاك

  /**
   * ترحيل إهلاك شهر: لكل أصل نشط يستحق الشهر (لم يُرحَّل ولم يستوفِ عمره) قسطٌ
   * واحد، وقيد يومية واحد متوازن يجمعها — مدين مصروف إهلاك / دائن مجمع إهلاك — عبر
   * `postJournalInTx` حصرًا. إعادة التشغيل لا تُنشئ شيئًا: القيد الفريد
   * (asset, period) يردّ الأمر، والمتخطى يُعلن بقائمة لا بصمت.
   */
  async runDepreciation(tenantId: string, input: DepreciationRunInput, actorId?: string) {
    const period = (input.period ?? '').trim();
    if (!PERIOD_PATTERN.test(period))
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'الشهر المحاسبي يجب أن يكون بصيغة YYYY-MM', 422, { field: 'period' });
    const date = input.date?.trim() || periodEndDate(period);
    if (Number.isNaN(Date.parse(date)))
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'تاريخ ترحيل غير صالح', 422, { field: 'date' });

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      // سياق الترحيل (فرع + فترة مالية مفتوحة) يُستنتج من التاريخ كما في القيود.
      const context = await this.accounting.resolvePostingContext(tx, tenantId, date, input.branchId, input.fiscalPeriodId);

      const candidates = await tx
        .select()
        .from(fixedAssets)
        .where(
          and(
            eq(fixedAssets.tenantId, tenantId),
            isNull(fixedAssets.deletedAt),
            inArray(fixedAssets.status, ['active', 'fully_depreciated']),
            ...(input.assetIds?.length ? [inArray(fixedAssets.id, input.assetIds)] : []),
          ),
        )
        .for('update');

      const skipped: Array<{ assetId: string; code: string; reason: string }> = [];
      const payable: Array<{ asset: typeof fixedAssets.$inferSelect; amount: Decimal }> = [];
      for (const asset of candidates) {
        const offset = monthsBetween(monthOf(asset.acquisitionDate), period);
        if (offset < 0) {
          skipped.push({ assetId: asset.id, code: asset.code, reason: 'قبل تاريخ الاقتناء' });
          continue;
        }
        if (offset >= asset.usefulLifeMonths) {
          skipped.push({ assetId: asset.id, code: asset.code, reason: 'استوفى عمره الإهلاكي' });
          continue;
        }
        const [already] = await tx
          .select({ id: assetDepreciationEntries.id })
          .from(assetDepreciationEntries)
          .where(
            and(
              eq(assetDepreciationEntries.tenantId, tenantId),
              eq(assetDepreciationEntries.assetId, asset.id),
              eq(assetDepreciationEntries.period, period),
            ),
          );
        if (already) {
          skipped.push({ assetId: asset.id, code: asset.code, reason: 'مرحَّل مسبقًا لهذا الشهر' });
          continue;
        }
        const depreciable = dec(asset.acquisitionCost).minus(dec(asset.salvageValue));
        const monthly = depreciable.div(asset.usefulLifeMonths).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
        const amount = offset === asset.usefulLifeMonths - 1 ? depreciable.minus(monthly.times(asset.usefulLifeMonths - 1)) : monthly;
        if (amount.lte(0)) {
          skipped.push({ assetId: asset.id, code: asset.code, reason: 'لا قسط مستحق (الخردة تساوي التكلفة)' });
          continue;
        }
        payable.push({ asset, amount });
      }

      if (payable.length === 0) {
        return { processed: 0, skipped, journalEntry: null, totalDepreciation: '0.0000' };
      }

      // حسابات الترحيل: تجاوز الأصل، وإلا فحساب التصنيف — وكلاهما مطلوب موجودًا.
      const categoryIds = [...new Set(payable.map(({ asset }) => asset.categoryId))];
      const categories = await tx
        .select()
        .from(assetCategories)
        .where(and(eq(assetCategories.tenantId, tenantId), inArray(assetCategories.id, categoryIds)));
      const byCategory = new Map(categories.map((row) => [row.id, row]));

      const lines: JournalLineInput[] = [];
      for (const { asset, amount } of payable) {
        const category = byCategory.get(asset.categoryId);
        const expenseAccountId = asset.depreciationAccountId ?? category?.depreciationAccountId ?? null;
        const accumulatedAccountId = asset.accumulatedAccountId ?? category?.accumulatedAccountId ?? null;
        if (!expenseAccountId || !accumulatedAccountId)
          throw new DomainError(
            'ASSET_ACCOUNTS_MISSING',
            `الأصل ${asset.code} وتصنيفه لا يحددان حساب مصروف الإهلاك ومجمعه — اكتملهما من شاشة التصنيفات`,
            422,
            { field: 'categoryId' },
          );
        lines.push(
          { accountId: expenseAccountId, debit: amount.toFixed(4), credit: '0', description: `إهلاك الأصل ${asset.code} — ${asset.nameAr}` },
          { accountId: accumulatedAccountId, debit: '0', credit: amount.toFixed(4), description: `مجمع إهلاك الأصل ${asset.code}` },
        );
      }

      const entry = await this.accounting.postJournalInTx(tx, tenantId, {
        branchId: context.branchId,
        fiscalPeriodId: context.fiscalPeriodId,
        date,
        description: input.description?.trim() || `إهلاك الأصول الثابتة — شهر ${period}`,
        lines,
        sourceType: 'asset_depreciation',
      });
      if (!entry) throw new DomainError('INTERNAL', 'لم يُنشأ قيد الإهلاك — أعد المحاولة', 500);

      for (const { asset, amount } of payable) {
        await tx.insert(assetDepreciationEntries).values({
          id: newId(),
          tenantId,
          assetId: asset.id,
          period,
          depreciationDate: date,
          amount: amount.toFixed(4),
          journalEntryId: entry.id,
          fiscalPeriodId: context.fiscalPeriodId,
          branchId: context.branchId,
          createdBy: actorId ?? null,
        });
      }

      // من استوفى أقساطه كلها يصير «مستوفى» — حالة معلنة لا استنتاج كل قراءة.
      for (const { asset } of payable) {
        const [count] = await tx
          .select({ months: sql<number>`COUNT(*)::int` })
          .from(assetDepreciationEntries)
          .where(and(eq(assetDepreciationEntries.tenantId, tenantId), eq(assetDepreciationEntries.assetId, asset.id)));
        if ((count?.months ?? 0) >= asset.usefulLifeMonths) {
          await tx
            .update(fixedAssets)
            .set({ status: 'fully_depreciated', updatedAt: new Date(), updatedBy: actorId ?? null })
            .where(and(eq(fixedAssets.tenantId, tenantId), eq(fixedAssets.id, asset.id)));
        }
      }

      const totalDepreciation = payable.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
      return {
        processed: payable.length,
        skipped,
        journalEntry: { id: entry.id, number: entry.number, date: entry.date, description: entry.description },
        totalDepreciation: totalDepreciation.toFixed(4),
        assets: payable.map(({ asset, amount }) => ({ id: asset.id, code: asset.code, amount: amount.toFixed(4) })),
      };
    });
  }

  /** سجل التشغيلات — صفوف الإهلاك المرحّلة كما هي، شهرًا شهرًا. */
  async listRuns(tenantId: string, period?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rowsList = await tx
        .select({
          id: assetDepreciationEntries.id,
          assetId: assetDepreciationEntries.assetId,
          assetCode: fixedAssets.code,
          assetName: fixedAssets.nameAr,
          period: assetDepreciationEntries.period,
          depreciationDate: assetDepreciationEntries.depreciationDate,
          amount: assetDepreciationEntries.amount,
          journalEntryId: assetDepreciationEntries.journalEntryId,
          journalNumber: journalEntries.number,
        })
        .from(assetDepreciationEntries)
        .innerJoin(fixedAssets, eq(fixedAssets.id, assetDepreciationEntries.assetId))
        .innerJoin(journalEntries, eq(journalEntries.id, assetDepreciationEntries.journalEntryId))
        .where(
          and(
            eq(assetDepreciationEntries.tenantId, tenantId),
            ...(period ? [eq(assetDepreciationEntries.period, period)] : []),
          ),
        )
        .orderBy(asc(assetDepreciationEntries.period), asc(fixedAssets.code));
      return rowsList.map((row) => ({ ...row, amount: dec(row.amount).toFixed(4) }));
    });
  }

  // ─────────────────────────────────────────────────────────────ـ حارسات

  /** حسابات الترحيل يجب أن تكون حسابات هذا المستأجر وقابلة للترحيل. */
  private async assertAccountsUsable(
    tx: DrizzleTx,
    tenantId: string,
    accountIds: Array<string | undefined>,
  ) {
    const ids = [...new Set((accountIds ?? []).filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return;
    const found = await tx
      .select({ id: accounts.id, isPostable: accounts.isPostable, deletedAt: accounts.deletedAt })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, ids)));
    const foundIds = new Set(found.filter((row) => row.isPostable && !row.deletedAt).map((row) => row.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length)
      throw new DomainError(
        errorCodes.NOT_FOUND,
        'حسابات الترحيل يجب أن تكون من دليل حسابات هذه المنشأة وقابلة للترحيل',
        404,
        { field: 'accountIds' },
      );
  }
}
