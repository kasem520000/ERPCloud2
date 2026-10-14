import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import { marinaAdditions, marinaBookingAdditions, tenantSettings, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

/**
 * ⛵ المرسى — `Form_WPF/frmAdditions.xaml` («📋 إضافات» — لوحتها «📋 إدارة الإضافات»).
 *
 * The window is three boxes and three buttons:
 *
 *   🔢 الرقم (`txtNo`, read-only) · 📝 الاسم (`txtName`) · 💰 القيمة (`txtSalePrice`)
 *   ➕ جديد · 💾 حفظ · 🗑️ حذف · والشبكة تحتها: `🔢 الرقم · 📝 الاسم · 💰 القيمة`
 *
 * and it exists because «🎁 الإضافات» in `frmBookingM` («الحجوزات») is filled from it:
 * `LoadAdditions` is `select id, Name from Additions where IsDeleted=0`, and
 * `cmbAdditions_SelectionChanged` writes «السعر» from `SalePrice`.
 *
 * What «💾 حفظ» does, in the window's own order:
 *
 *   1. رفضٌ بلا اسم — «يجب إدخال اسم الإضافة ⚠️»، والمؤشَّر على صندوق الاسم.
 *   2. «القيمة» فارغة ⇒ صفر (`if (string.IsNullOrWhiteSpace(txtSalePrice.Text)) … = "0"`).
 *   3. `insert into Additions(name, SalePrice, IsDeleted) values(…, …, 0)` لجديد،
 *      أو `update Additions set name=@name, SalePrice=@SalePrice where id=…` لقديم —
 *      والقديم عنده هو «الرقم المعروض موجود أصلاً» (`select id … where id={txtNo}`).
 *   4. «✅ تم الحفظ بنجاح» أول مرة، و«✅ تم حفظ التعديلات بنجاح» بعدها.
 *
 * و«🗑️ حذف»: «يجب تحديد الإضافة المراد حذفها ⚠️» بلا تحديد، ثم
 * «هل أنت متأكد من حذف هذه الإضافة؟ 🗑️»، ثم `delete from Additions where id=…`
 * و«✅ تم الحذف بنجاح».
 */

export type AdditionDefinitionInput = {
  /** 📝 الاسم — `txtName`; the one thing «💾 حفظ» refuses to go without. */
  name: string;
  /** 💰 القيمة — `SalePrice` per unit; an empty box is a zero. */
  salePrice?: number | string;
  /** العملة — `SAR` unless the tenant says otherwise. */
  currency?: string;
};

export type AdditionDefinitionPatch = Partial<AdditionDefinitionInput> & { version?: number };

export type AdditionDefinitionRow = {
  id: string;
  /** 🔢 الرقم — `txtNo`. */
  number: number;
  /** 📝 الاسم — `txtName`. */
  name: string;
  /** 💰 القيمة — `SalePrice`. */
  salePrice: string;
  currency: string;
  /**
   * 🧾 كم حجزاً يستعمل هذه الإضافة — invented here, and the one departure the window
   * cannot argue with: `delete from Additions` at the desktop orphans
   * `BookingAddition.AditionID`, so the count is shown instead of a silent hole.
   */
  usageCount: number;
  version: number;
  createdAt: string;
};

function decimal(value: number | string | null | undefined): Decimal {
  if (value === undefined || value === null || value === '') return new Decimal(0);
  const parsed = new Decimal(String(value));
  return parsed.isFinite() ? parsed : new Decimal(0);
}

/** Money in this repository is four decimals. */
function four(value: Decimal): string {
  return value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

@Injectable()
export class MarinaAdditionsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async ensureEnabled(tenantId: string) {
    const [flag] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'pack.marina'))).limit(1),
    );
    if (flag && flag.value !== true && flag.value !== 'true') throw new DomainError('NOT_FOUND', 'Marina pack is disabled', 404);
  }

  /**
   * «📋 إدارة الإضافات» — `select * from Additions where IsDeleted=0 ORDER BY id`, the
   * same walk «🔢 الرقم» takes.
   */
  async list(tenantId: string): Promise<AdditionDefinitionRow[]> {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(marinaAdditions)
        .where(and(eq(marinaAdditions.tenantId, tenantId), isNull(marinaAdditions.deletedAt)))
        .orderBy(asc(marinaAdditions.number), asc(marinaAdditions.createdAt))
        .limit(500),
    );
    return this.shape(tenantId, rows);
  }

  /**
   * 🔢 الرقم of the next إضافة — `LoadNextAdditionNumber` counts the rows still there and
   * adds one; this takes `max(الرقم) + 1` instead, because the desktop's count collides
   * with a surviving رقم as soon as one row is deleted (`delete from Additions`).
   */
  async nextNumber(tenantId: string): Promise<{ number: number }> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ max: sql<number>`coalesce(max(${marinaAdditions.number}), 0)` }).from(marinaAdditions).where(eq(marinaAdditions.tenantId, tenantId)),
    );
    return { number: Number(row?.max ?? 0) + 1 };
  }

  /** «📝 الاسم · 💰 القيمة» of one إضافة, as the grid shows it. */
  async get(tenantId: string, id: string): Promise<AdditionDefinitionRow> {
    await this.ensureEnabled(tenantId);
    const [row] = await this.shape(tenantId, [await this.raw(tenantId, id)]);
    return row!;
  }

  /**
   * «💾 حفظ» on a blank card — «يجب إدخال اسم الإضافة ⚠️» when there is no name, and a
   * 💰 القيمة that is not there is a zero, exactly as the window writes it.
   */
  async create(tenantId: string, input: AdditionDefinitionInput, userId?: string): Promise<AdditionDefinitionRow> {
    await this.ensureEnabled(tenantId);
    const name = String(input?.name ?? '').trim();
    if (!name) throw new DomainError('MARINA_ADDITION_NAME_REQUIRED', 'يجب إدخال اسم الإضافة ⚠️', 422);

    const id = newId();
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [allocated] = await tx
        .select({ max: sql<number>`coalesce(max(${marinaAdditions.number}), 0)` })
        .from(marinaAdditions)
        .where(eq(marinaAdditions.tenantId, tenantId));
      await tx.insert(marinaAdditions).values({
        id,
        tenantId,
        number: Number(allocated?.max ?? 0) + 1,
        name,
        salePrice: four(decimal(input?.salePrice)),
        currency: String(input?.currency ?? 'SAR').trim() || 'SAR',
        createdBy: userId ?? null,
      });
    });
    return this.get(tenantId, id);
  }

  /** «💾 حفظ» on a card that is already there — «✅ تم حفظ التعديلات بنجاح». */
  async update(tenantId: string, id: string, patch: AdditionDefinitionPatch, userId?: string): Promise<AdditionDefinitionRow> {
    await this.ensureEnabled(tenantId);
    const current = await this.raw(tenantId, id);
    const name = patch.name === undefined ? current.name : String(patch.name ?? '').trim();
    if (patch.name !== undefined && !name) throw new DomainError('MARINA_ADDITION_NAME_REQUIRED', 'يجب إدخال اسم الإضافة ⚠️', 422);

    const updated = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(marinaAdditions)
        .set({
          name,
          salePrice: patch.salePrice === undefined ? current.salePrice : four(decimal(patch.salePrice)),
          currency: patch.currency === undefined ? current.currency : String(patch.currency ?? '').trim() || current.currency,
          updatedAt: new Date(),
          updatedBy: userId ?? null,
          version: sql`${marinaAdditions.version} + 1`,
        })
        .where(
          and(
            eq(marinaAdditions.tenantId, tenantId),
            eq(marinaAdditions.id, id),
            isNull(marinaAdditions.deletedAt),
            patch.version === undefined ? undefined : eq(marinaAdditions.version, patch.version),
          ),
        )
        .returning({ id: marinaAdditions.id }),
    );
    if (!updated.length) throw new DomainError('VERSION_CONFLICT', 'تم تعديل هذا السجل من مكان آخر', 409);
    return this.get(tenantId, id);
  }

  /**
   * «🗑️ حذف» — `delete from Additions where id=…` at the desktop, after
   * «يجب تحديد الإضافة المراد حذفها ⚠️» and the confirm box; here the row is retired
   * instead of erased, so the حجوزات that already carry it keep their «الإجمالي».
   */
  async remove(tenantId: string, id: string, userId?: string): Promise<{ deleted: true; id: string }> {
    await this.ensureEnabled(tenantId);
    const removed = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(marinaAdditions)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null, updatedAt: new Date(), updatedBy: userId ?? null })
        .where(and(eq(marinaAdditions.tenantId, tenantId), eq(marinaAdditions.id, id), isNull(marinaAdditions.deletedAt)))
        .returning({ id: marinaAdditions.id }),
    );
    // 404, not 422: a stranger must not learn whether another tenant's إضافة exists — the
    // window's own sentence is kept, only the status changes.
    if (!removed.length) throw new DomainError('MARINA_ADDITION_DELETE_REQUIRED', 'يجب تحديد الإضافة المراد حذفها ⚠️', 404);
    return { deleted: true, id };
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private async raw(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(marinaAdditions)
        .where(and(eq(marinaAdditions.tenantId, tenantId), eq(marinaAdditions.id, id), isNull(marinaAdditions.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('MARINA_ADDITION_NOT_FOUND', 'الإضافة غير موجودة', 404);
    return row;
  }

  private async shape(tenantId: string, rows: Array<typeof marinaAdditions.$inferSelect>): Promise<AdditionDefinitionRow[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const used = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ additionId: marinaBookingAdditions.additionId, total: count() })
        .from(marinaBookingAdditions)
        .where(and(eq(marinaBookingAdditions.tenantId, tenantId), inArray(marinaBookingAdditions.additionId, ids)))
        .groupBy(marinaBookingAdditions.additionId),
    );
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      name: row.name,
      salePrice: row.salePrice,
      currency: row.currency,
      usageCount: Number(used.find((line) => line.additionId === row.id)?.total ?? 0),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
