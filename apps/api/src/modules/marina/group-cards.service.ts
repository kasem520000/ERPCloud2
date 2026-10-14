import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  tenantSettings,
  vesselGroupPricing,
  vesselGroups,
  vessels,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

/**
 * ⛵ المرسى — `Form_WPF/frmGroupM.xaml` («📋 بطاقة فئة») و`Form_WPF/frmAddPeriod.xaml`
 * («⏰ إدارة فترات التأجير»).
 *
 * The فئة is the harbour's tariff. Its card carries 🔢 رقم الفئة · رمز الفئة · اسم الفئة
 * (عربي) · اسم الفئة (EN) · قيمة الساعة · عرض الساعة (دقيقة) · قيمة النصف ساعة · عرض
 * النصف ساعة (دقيقة) · 🖼️ صورة الفئة, and «➕ إضافة مدة» opens the second window whose
 * grid is «⏰ المدة · 💵 السعر · 🎁 العرض · 🗑️».
 *
 * `frmGroupM.btnSave_Click` writes the card and then **re-writes the two canonical
 * periods** — `RentPeriodSub(periodID=2)` من قيمة الساعة و`periodID=1` من قيمة النصف
 * ساعة — every time, whatever `frmAddPeriod` had stored:
 *
 *   insert into GroupMarine(id, code, name, nameEN, HourPrice, HalfHPrice,
 *     OfferHour, OfferHalf, IsDeleted, image) …
 *   delete from RentPeriodSub where MGroupID=…
 *   insert into RentPeriodSub(MGroupID, code, periodID, rent, offer) …   -- ساعة
 *   insert into RentPeriodSub(MGroupID, code, periodID, rent, offer) …   -- نصف ساعة
 *
 * and `frmAddPeriod.SaveRentPeriods` is the mirror image: `delete` everything for the
 * فئة, then every row of the grid again. Both are kept here.
 *
 * What they refuse, in the windows' own words: «ادخل الفئة» · «الفئة تم ادخالها مسبقا» ·
 * «اختر الفئة ليتم حذفها» · «هذه الفئة لها ارتباطات فرعية لايمكن حذفها» من البطاقة،
 * و«يجب إستكمال البيانات ⚠️» · «يجب اختيار الفئة أولاً ⚠️» من نافذة الفترات.
 */

/**
 * ⏰ المدة — `RentPeriod(id, name)`, the ten seeded durations of the desktop
 * (`AlterDb.txt` L3317). There is no window for the list, so it lives here as a constant
 * — the way «حجز عادي»/«بحر مفتوح» do — and only the `id` is stored.
 *
 * The desktop's seed rows carry stray spaces (`N' ساعة'` · `N'خمس ساعات '`); the names
 * below are the trimmed ones, since they are shown in a grid.
 */
export const RENT_PERIODS = [
  { id: 1, name: 'نصف ساعة', minutes: 30 },
  { id: 2, name: 'ساعة', minutes: 60 },
  { id: 3, name: 'ساعة و نصف', minutes: 90 },
  { id: 4, name: 'ساعتين', minutes: 120 },
  { id: 5, name: 'ساعتين و نصف', minutes: 150 },
  { id: 6, name: 'ثلاث ساعات', minutes: 180 },
  { id: 7, name: 'ثلاث ساعات و نصف', minutes: 210 },
  { id: 8, name: 'أربع ساعات', minutes: 240 },
  { id: 9, name: 'أربع ساعات و نصف', minutes: 270 },
  { id: 10, name: 'خمس ساعات', minutes: 300 },
] as const;

/** ⏰ المدة of the two canonical rows — `ساعة` is 2 and `نصف ساعة` is 1 in `RentPeriod`. */
const HOUR_PERIOD_ID = 2;
const HALF_HOUR_PERIOD_ID = 1;

/** The `period_kind` each فترة takes, so the pricing of a حجز keeps reading 'hour'/'half_hour'. */
function kindOfPeriod(periodId: number): string {
  if (periodId === HOUR_PERIOD_ID) return 'hour';
  if (periodId === HALF_HOUR_PERIOD_ID) return 'half_hour';
  return `period_${periodId}`;
}

export type RentPeriodRow = { id: number; name: string; minutes: number };

export type GroupPeriodInput = {
  /** ⏰ المدة — `RentPeriod.id` (1 … 10). */
  periodId: number | string;
  /** 💵 السعر — `RentPeriodSub.rent`. */
  price: number | string;
  /** 🎁 العرض — `RentPeriodSub.offer`, in minutes. */
  offerMinutes?: number | string;
};

export type GroupPeriodRow = {
  id: string;
  periodId: number;
  periodName: string;
  minutes: number;
  price: string;
  offerMinutes: number;
  currency: string;
};

export type GroupCardInput = {
  /** رمز الفئة — `txtCode`; «ادخل الفئة» is the window's refusal when it is empty. */
  code: string;
  /** اسم الفئة (عربي) — `txtName`; stands the code in when the caller omits it. */
  name?: string;
  /** اسم الفئة (EN) — `txtNameEN`. */
  nameEn?: string;
  /** قيمة الساعة — `HourPrice`. */
  hourPrice?: number | string;
  /** عرض الساعة (دقيقة) — `OfferHour`. */
  hourOfferMinutes?: number | string;
  /** قيمة النصف ساعة — `HalfHPrice`. */
  halfHourPrice?: number | string;
  /** عرض النصف ساعة (دقيقة) — `OfferHalf`. */
  halfHourOfferMinutes?: number | string;
  /** 🖼️ صورة الفئة — a URL (this platform has no attachment store). */
  imageUrl?: string | null;
  /** ⏰ فترات التأجير — when sent, they *replace* the فئة's set. */
  periods?: GroupPeriodInput[];
  metadata?: Record<string, unknown>;
};

export type GroupCardPatch = Partial<GroupCardInput> & { version?: number };

export type GroupCardRow = {
  id: string;
  number: number | null;
  code: string;
  name: string;
  nameEn: string;
  hourPrice: string;
  hourOfferMinutes: number;
  halfHourPrice: string;
  halfHourOfferMinutes: number;
  imageUrl: string | null;
  /** ⛵ ما يركب under this فئة — the desktop refuses deletion while any is there. */
  vesselCount: number;
  periods: GroupPeriodRow[];
  version: number;
  createdAt: string;
};

export type NavigateDirection = 'first' | 'previous' | 'next' | 'last';

function decimal(value: number | string | null | undefined): Decimal {
  if (value === undefined || value === null || value === '') return new Decimal(0);
  const parsed = new Decimal(String(value));
  return parsed.isFinite() ? parsed : new Decimal(0);
}

/** Money in this repository is four decimals. */
function four(value: Decimal): string {
  return value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

function whole(value: number | string | null | undefined): number {
  const parsed = Math.trunc(Number(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function periodById(periodId: number) {
  return RENT_PERIODS.find((period) => period.id === periodId);
}

/**
 * 💵 السعر و🎁 العرض of one ⏰ المدة — and the refusal that guards them:
 * `frmAddPeriod.SaveRentPeriods` refuses a row with no فترة أو سعرٍ بصفر
 * («يجب إستكمال البيانات ⚠️»).
 */
function periodOf(input: GroupPeriodInput) {
  const periodId = Math.trunc(Number(input?.periodId ?? 0));
  const period = Number.isFinite(periodId) ? periodById(periodId) : undefined;
  const rent = decimal(input?.price);
  if (!period || rent.lte(0)) throw new DomainError('MARINA_PERIOD_INCOMPLETE', 'يجب إستكمال البيانات ⚠️', 422);
  return { periodId: period.id, minutes: period.minutes, name: period.name, price: four(rent), offerMinutes: whole(input?.offerMinutes) };
}

/** 🖼️ صورة الفئة — a link or a data URL; the desktop stored bytes, this platform stores neither. */
function imageUrlOf(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^(https?:\/\/|data:image\/)/i.test(text)) throw new DomainError('MARINA_GROUP_IMAGE_INVALID', 'رابط صورة الفئة غير صحيح', 422);
  return text;
}

function periodRow(row: typeof vesselGroupPricing.$inferSelect): GroupPeriodRow {
  const period = periodById(Number(row.periodId ?? 0));
  return {
    id: row.id,
    periodId: Number(row.periodId ?? 0),
    periodName: period?.name ?? '—',
    minutes: Number(row.minutes ?? 0),
    price: row.price,
    offerMinutes: Number(row.offerMinutes ?? 0),
    currency: row.currency,
  };
}

function cardRow(row: typeof vesselGroups.$inferSelect, periods: GroupPeriodRow[], vesselCount: number): GroupCardRow {
  return {
    id: row.id,
    number: row.number,
    code: row.code ?? '',
    name: row.name,
    nameEn: row.nameEn ?? '',
    hourPrice: row.hourPrice,
    hourOfferMinutes: Number(row.hourOfferMinutes ?? 0),
    halfHourPrice: row.halfHourPrice,
    halfHourOfferMinutes: Number(row.halfHourOfferMinutes ?? 0),
    imageUrl: row.imageUrl ?? null,
    vesselCount,
    periods,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class MarinaGroupCardsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async ensureEnabled(tenantId: string) {
    const [flag] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'pack.marina'))).limit(1),
    );
    if (flag && flag.value !== true && flag.value !== 'true') throw new DomainError('NOT_FOUND', 'Marina pack is disabled', 404);
  }

  // ─────────────────────────────── ⏰ المدة ───────────────────────────────

  /** «⏰ المدة» — the ten durations of `RentPeriod`, for the drop-down of `frmAddPeriod`. */
  async listRentPeriods(): Promise<RentPeriodRow[]> {
    return RENT_PERIODS.map((period) => ({ id: period.id, name: period.name, minutes: period.minutes }));
  }

  // ─────────────────────────────── 📋 قائمة الفئات ───────────────────────────────

  /**
   * «📋 قائمة الفئات» — `select * from GroupMarine where IsDeleted=0` in the order the
   * ⏮/◀/▶/⏭ buttons walk it (🔢 الرقم then creation).
   */
  async list(tenantId: string): Promise<GroupCardRow[]> {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(vesselGroups)
        .where(and(eq(vesselGroups.tenantId, tenantId), isNull(vesselGroups.deletedAt)))
        .orderBy(asc(vesselGroups.number), asc(vesselGroups.createdAt))
        .limit(500),
    );
    return this.shape(tenantId, rows);
  }

  /** «📋 بطاقة فئة» — one فئة with its ⏰ فترات التأجير and ⛵ ما يركب تحتها. */
  async get(tenantId: string, id: string): Promise<GroupCardRow> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(vesselGroups)
        .where(and(eq(vesselGroups.tenantId, tenantId), eq(vesselGroups.id, id), isNull(vesselGroups.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('MARINA_GROUP_NOT_FOUND', 'الفئة غير موجودة', 404);
    const [shaped] = await this.shape(tenantId, [row]);
    return shaped!;
  }

  /**
   * «💾 حفظ» — the card, then the two canonical ⏰ فترات written from قيمة الساعة وقيمة
   * النصف ساعة (`frmGroupM.btnSave_Click`).
   *
   * 🔢 الرقم is `LoadNextNo` — the desktop's `count(GroupMarine) + 1`, kept monotonic per
   * tenant so a deleted فئة does not hand its رقم to the next one.
   */
  async create(tenantId: string, input: GroupCardInput, userId?: string): Promise<GroupCardRow> {
    await this.ensureEnabled(tenantId);
    const code = String(input?.code ?? '').trim();
    if (!code) throw new DomainError('MARINA_GROUP_CODE_REQUIRED', 'ادخل الفئة', 422);
    await this.assertCodeFree(tenantId, code);

    const id = newId();
    const values = {
      name: String(input?.name ?? '').trim() || code,
      code,
      nameEn: String(input?.nameEn ?? '').trim(),
      hourPrice: four(decimal(input?.hourPrice)),
      hourOfferMinutes: whole(input?.hourOfferMinutes),
      halfHourPrice: four(decimal(input?.halfHourPrice)),
      halfHourOfferMinutes: whole(input?.halfHourOfferMinutes),
      imageUrl: imageUrlOf(input?.imageUrl),
    };
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [allocated] = await tx
        .select({ max: sql<number>`coalesce(max(${vesselGroups.number}), 0)` })
        .from(vesselGroups)
        .where(eq(vesselGroups.tenantId, tenantId));
      await tx.insert(vesselGroups).values({ ...values, id, tenantId, number: Number(allocated?.max ?? 0) + 1, createdBy: userId ?? null });
      if (input?.periods?.length) await this.replacePeriodsIn(tx, tenantId, id, input.periods, userId);
      else await this.writeCanonicalPeriods(tx, tenantId, id, values, userId);
    });
    return this.get(tenantId, id);
  }

  /** «💾» on a فئة that is already there — the card, and its فترات when they are sent. */
  async update(tenantId: string, id: string, patch: GroupCardPatch, userId?: string): Promise<GroupCardRow> {
    await this.ensureEnabled(tenantId);
    const current = await this.raw(tenantId, id);
    const code = patch.code === undefined ? current.code : String(patch.code ?? '').trim();
    if (patch.code !== undefined) {
      if (!code) throw new DomainError('MARINA_GROUP_CODE_REQUIRED', 'ادخل الفئة', 422);
      if (code !== current.code) await this.assertCodeFree(tenantId, code, id);
    }
    const values = {
      name: patch.name === undefined ? current.name : String(patch.name ?? '').trim() || code || current.name,
      code,
      nameEn: patch.nameEn === undefined ? current.nameEn ?? '' : String(patch.nameEn ?? '').trim(),
      hourPrice: patch.hourPrice === undefined ? current.hourPrice : four(decimal(patch.hourPrice)),
      hourOfferMinutes: patch.hourOfferMinutes === undefined ? current.hourOfferMinutes ?? 0 : whole(patch.hourOfferMinutes),
      halfHourPrice: patch.halfHourPrice === undefined ? current.halfHourPrice : four(decimal(patch.halfHourPrice)),
      halfHourOfferMinutes: patch.halfHourOfferMinutes === undefined ? current.halfHourOfferMinutes ?? 0 : whole(patch.halfHourOfferMinutes),
      imageUrl: patch.imageUrl === undefined ? current.imageUrl ?? null : imageUrlOf(patch.imageUrl),
    };
    const touchesTariff =
      patch.hourPrice !== undefined ||
      patch.hourOfferMinutes !== undefined ||
      patch.halfHourPrice !== undefined ||
      patch.halfHourOfferMinutes !== undefined;

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const updated = await tx
        .update(vesselGroups)
        .set({ ...values, updatedAt: new Date(), updatedBy: userId ?? null, version: sql`${vesselGroups.version} + 1` })
        .where(
          and(
            eq(vesselGroups.tenantId, tenantId),
            eq(vesselGroups.id, id),
            isNull(vesselGroups.deletedAt),
            patch.version === undefined ? undefined : eq(vesselGroups.version, patch.version),
          ),
        )
        .returning({ id: vesselGroups.id });
      if (!updated.length) throw new DomainError('VERSION_CONFLICT', 'تم تعديل هذا السجل من مكان آخر', 409);
      // `frmGroupM` re-writes ساعة ونصف ساعة on every save — so does this.
      if (patch.periods?.length) await this.replacePeriodsIn(tx, tenantId, id, patch.periods, userId);
      else if (touchesTariff) await this.writeCanonicalPeriods(tx, tenantId, id, values, userId);
    });
    return this.get(tenantId, id);
  }

  /**
   * «🗑️ حذف» — `update GroupMarine set IsDeleted=1`, after two refusals:
   * «اختر الفئة ليتم حذفها» when there is no فئة, و«هذه الفئة لها ارتباطات فرعية لايمكن
   * حذفها» when a مركب still belongs to it.
   *
   * The desktop looks for `Marine where Groupcode='…'` — by the code it copied; this
   * looks at the vessels that point at the فئة itself.
   */
  async remove(tenantId: string, id: string, userId?: string): Promise<{ deleted: true; id: string }> {
    await this.ensureEnabled(tenantId);
    const existing = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: vesselGroups.id })
        .from(vesselGroups)
        .where(and(eq(vesselGroups.tenantId, tenantId), eq(vesselGroups.id, id), isNull(vesselGroups.deletedAt)))
        .limit(1),
    );
    // 404, not 422: a stranger must not learn whether another tenant's فئة exists — the
    // window's own sentence is kept, only the status changes.
    if (!existing.length) throw new DomainError('MARINA_GROUP_DELETE_REQUIRED', 'اختر الفئة ليتم حذفها', 404);
    const used = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: vessels.id })
        .from(vessels)
        .where(and(eq(vessels.tenantId, tenantId), eq(vessels.groupId, id), isNull(vessels.deletedAt)))
        .limit(1),
    );
    if (used.length) throw new DomainError('MARINA_GROUP_IN_USE', 'هذه الفئة لها ارتباطات فرعية لايمكن حذفها', 409);

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx
        .update(vesselGroups)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null, updatedAt: new Date(), updatedBy: userId ?? null })
        .where(and(eq(vesselGroups.tenantId, tenantId), eq(vesselGroups.id, id), isNull(vesselGroups.deletedAt)));
      // ⏰ فترات التأجير belong to the فئة; the tariff goes where the فئة goes.
      await tx.delete(vesselGroupPricing).where(and(eq(vesselGroupPricing.tenantId, tenantId), eq(vesselGroupPricing.groupId, id)));
    });
    return { deleted: true, id };
  }

  // ─────────────────────────────── ⏰ فترات التأجير ───────────────────────────────

  /**
   * «💾» of `frmAddPeriod` — `delete RentPeriodSub where MGroupID=…` then every row of the
   * grid again, with its two refusals: «يجب اختيار الفئة أولاً ⚠️»، و«يجب إستكمال
   * البيانات ⚠️» لأي صفٍّ لا فترة له أو لا سعر.
   */
  async replacePeriods(tenantId: string, groupId: string, periods: GroupPeriodInput[], userId?: string): Promise<GroupCardRow> {
    await this.ensureEnabled(tenantId);
    await this.raw(tenantId, groupId);
    await withTenantTx(this.database.db, tenantId, (tx) => this.replacePeriodsIn(tx, tenantId, groupId, periods, userId));
    return this.get(tenantId, groupId);
  }

  // ─────────────────────────────── ⏮ ◀ ▶ ⏭ ───────────────────────────────

  /**
   * ⏮ الأول · ◀ السابق · ▶ التالي · ⏭ الأخير — `frmGroupM` walks `GroupMarine` by `id`
   * and **stays where it is** when there is nothing further (`if (!reader.HasRows) return`).
   * So does this: it answers with the فئة it landed on, or with the current one.
   */
  async navigate(tenantId: string, direction: NavigateDirection, currentId?: string): Promise<GroupCardRow | null> {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: vesselGroups.id, number: vesselGroups.number, createdAt: vesselGroups.createdAt })
        .from(vesselGroups)
        .where(and(eq(vesselGroups.tenantId, tenantId), isNull(vesselGroups.deletedAt)))
        .orderBy(asc(vesselGroups.number), asc(vesselGroups.createdAt))
        .limit(500),
    );
    if (!rows.length) return null;

    const index = currentId ? rows.findIndex((row) => row.id === currentId) : -1;
    if (index < 0) return this.get(tenantId, (direction === 'last' || direction === 'previous' ? rows[rows.length - 1]! : rows[0]!).id);
    const target =
      direction === 'first' ? 0
      : direction === 'last' ? rows.length - 1
      : direction === 'next' ? Math.min(index + 1, rows.length - 1)
      : Math.max(index - 1, 0);
    return this.get(tenantId, rows[target]!.id);
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private async raw(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(vesselGroups)
        .where(and(eq(vesselGroups.tenantId, tenantId), eq(vesselGroups.id, id), isNull(vesselGroups.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('MARINA_GROUP_NOT_FOUND', 'الفئة غير موجودة', 404);
    return row;
  }

  /** «الفئة تم ادخالها مسبقا» — the desktop's own duplicate check on the code. */
  private async assertCodeFree(tenantId: string, code: string, exceptId?: string) {
    const [duplicate] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: vesselGroups.id })
        .from(vesselGroups)
        .where(
          and(
            eq(vesselGroups.tenantId, tenantId),
            eq(vesselGroups.code, code),
            isNull(vesselGroups.deletedAt),
            exceptId ? sql`${vesselGroups.id} <> ${exceptId}` : undefined,
          ),
        )
        .limit(1),
    );
    if (duplicate) throw new DomainError('MARINA_GROUP_DUPLICATE', 'الفئة تم ادخالها مسبقا', 422);
  }

  private async shape(tenantId: string, rows: Array<typeof vesselGroups.$inferSelect>): Promise<GroupCardRow[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [pricing, fleet] = await Promise.all([
      withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .select()
          .from(vesselGroupPricing)
          .where(and(eq(vesselGroupPricing.tenantId, tenantId), inArray(vesselGroupPricing.groupId, ids)))
          .orderBy(asc(vesselGroupPricing.minutes), asc(vesselGroupPricing.periodKind)),
      ),
      withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .select({ groupId: vessels.groupId, id: vessels.id })
          .from(vessels)
          .where(and(eq(vessels.tenantId, tenantId), isNull(vessels.deletedAt), inArray(vessels.groupId, ids))),
      ),
    ]);
    return rows.map((row) => {
      const periods = pricing.filter((line) => line.groupId === row.id).map(periodRow);
      const vesselCount = fleet.filter((line) => line.groupId === row.id).length;
      return cardRow(row, periods, vesselCount);
    });
  }

  /**
   * `frmGroupM` writes ساعة ونصف ساعة from the card's own boxes — with no refusal, even
   * when both stand at zero, because the tariff may be filled in later.
   */
  private async writeCanonicalPeriods(
    tx: DrizzleTx,
    tenantId: string,
    groupId: string,
    values: { hourPrice: string; hourOfferMinutes: number; halfHourPrice: string; halfHourOfferMinutes: number },
    userId?: string,
  ) {
    const rows = [
      { periodId: HOUR_PERIOD_ID, minutes: 60, price: values.hourPrice, offerMinutes: values.hourOfferMinutes },
      { periodId: HALF_HOUR_PERIOD_ID, minutes: 30, price: values.halfHourPrice, offerMinutes: values.halfHourOfferMinutes },
    ];
    await tx
      .delete(vesselGroupPricing)
      .where(
        and(
          eq(vesselGroupPricing.tenantId, tenantId),
          eq(vesselGroupPricing.groupId, groupId),
          or(isNotNull(vesselGroupPricing.periodId), inArray(vesselGroupPricing.periodKind, ['hour', 'half_hour'])),
        ),
      );
    await tx.insert(vesselGroupPricing).values(
      rows.map((row) => ({
        id: newId(),
        tenantId,
        groupId,
        periodKind: kindOfPeriod(row.periodId),
        periodId: row.periodId,
        minutes: row.minutes,
        offerMinutes: row.offerMinutes,
        price: row.price,
        currency: 'SAR',
        createdBy: userId ?? null,
      })),
    );
  }

  /** `frmAddPeriod.SaveRentPeriods` — `delete` everything for the فئة, then the grid again. */
  private async replacePeriodsIn(
    tx: DrizzleTx,
    tenantId: string,
    groupId: string,
    periods: GroupPeriodInput[],
    userId?: string,
  ) {
    if (!Array.isArray(periods)) throw new DomainError('MARINA_PERIOD_INCOMPLETE', 'يجب إستكمال البيانات ⚠️', 422);
    const rows = periods.map(periodOf);
    await tx.delete(vesselGroupPricing).where(and(eq(vesselGroupPricing.tenantId, tenantId), eq(vesselGroupPricing.groupId, groupId)));
    if (!rows.length) return;
    await tx.insert(vesselGroupPricing).values(
      rows.map((row) => ({
        id: newId(),
        tenantId,
        groupId,
        periodKind: kindOfPeriod(row.periodId),
        periodId: row.periodId,
        minutes: row.minutes,
        offerMinutes: row.offerMinutes,
        price: row.price,
        currency: 'SAR',
        createdBy: userId ?? null,
      })),
    );
  }
}
