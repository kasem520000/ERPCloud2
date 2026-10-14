import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  marinaAdditions,
  marinaBookingAdditions,
  marinaBookings,
  marinaDayClosings,
  marinaViolations,
  parties,
  tenantSettings,
  vesselGroupPricing,
  vessels,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { SequencesService } from '../platform-services/index.js';

import { calculateMarinaPeriod } from './marina-pricing.js';

/**
 * ⛵ المرسى — `Form_WPF/frmBookingM.xaml` («الحجوزات») و`Form_WPF/frmViolationM.xaml`
 * («المخالفات»).
 *
 * The الحجز is one window on two tabs — «📋 بيانات الحجوزات» و«🔍 البحث» — and one
 * transaction that writes three tables (`Booking` · `BookingAddition` · `RentInvoice`).
 * What it refuses, it refuses in its own words: «يجب تحديد مدة الحجز» before any row is
 * written, and «يجب اختيار المركب» · «يجب تحديد مدة المخالفة» · «يجب تحديد نوع المخالفة»
 * on the smaller card.
 *
 * Two values are the desktop's own **strings**, not codes: 🔖 حالة الحجز is the content
 * of `cmbBookingStatu` («مؤكد» / «غير مؤكد») and 🚢 نوع الحجز is
 * `rbNormal.IsChecked ? "حجز عادي" : "بحر مفتوح"` — both stored as the Arabic text, so
 * they are kept as the Arabic text here too (`'booked'` from before this part reads as
 * «مؤكد»).
 */
export const BOOKING_STATUS = { confirmed: 'مؤكد', unconfirmed: 'غير مؤكد' } as const;
export const BOOKING_TYPES = { normal: 'حجز عادي', openSea: 'بحر مفتوح' } as const;
/** ⚙️ الحالة of a مخالفة — `Violation.status` is 1 on insert and nothing ever changes it. */
export const VIOLATION_STATUS = { open: 'open', closed: 'closed' } as const;

const BOOKING_SEQUENCE = { prefix: 'BK-', padding: 6 } as const;
const VIOLATION_SEQUENCE = { prefix: 'VI-', padding: 6 } as const;

/** `SettingGeneral.MainVAT where Inv_Id=4` — «ضريبة 15%» is its shadow in the XAML. */
const VAT_SETTING_KEY = 'marina.vatRate';
const DEFAULT_VAT_RATE = 15;

export type AdditionInput = {
  /**
   * ➕ الإضافة — `BookingAddition.AditionID`: ما اختاره المشغّل من «🎁 الإضافات», whose
   * تعريف is `Additions` (`Form_WPF/frmAdditions.xaml`). With it come the 📝 الاسم and the
   * 💰 القيمة of the line, unless the caller says otherwise.
   */
  additionId?: string;
  description?: string;
  quantity?: number | string;
  unitPrice?: number | string;
  amount?: number | string;
};
export type AdditionRow = {
  id: string;
  /** ➕ الإضافة — `AditionID`; `null` لصفٍّ كُتب وصفه باليد. */
  additionId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
};

export type BookingInput = {
  branchId: string;
  partyId: string;
  vesselId: string;
  startsAt: string;
  endsAt: string;
  /** 📅 التاريخ — `Bdate`; today when the card does not say otherwise. */
  documentDate?: string;
  /** 🚢 نوع الحجز — «حجز عادي» or «بحر مفتوح». */
  bookingType?: string;
  /** ⏱️ المدة ساعة — `PeriodHour`; taken from the two timestamps when not sent. */
  periodHours?: number | string;
  /** ⏱️ المدة دقيقة — `PeriodMinute`. */
  periodMinutes?: number | string;
  /** 💰 القيمة — `Price`; priced from the vessel's فئة when left empty. */
  rentalAmount?: number | string;
  /** 🔖 حالة الحجز — «مؤكد» or «غير مؤكد». */
  status?: string;
  companions?: number;
  insuranceAmount?: number | string;
  additions?: AdditionInput[];
  metadata?: Record<string, unknown>;
};
export type BookingPatch = Partial<BookingInput> & { version?: number };
export type BookingQuery = {
  number?: string;
  customer?: string;
  partyId?: string;
  vesselId?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number | string;
  offset?: number | string;
};

export type BookingRow = {
  id: string;
  number: string | null;
  branchId: string;
  partyId: string;
  customerName: string;
  customerPhone: string;
  vesselId: string;
  vesselName: string;
  vesselCode: string;
  documentDate: string;
  startsAt: string;
  endsAt: string;
  bookingType: string;
  periodHours: number;
  periodMinutes: number;
  /** ⏱️ المدة — `RentPeriod` = الساعة + الدقيقة ÷ 60. */
  rentalPeriod: number;
  rentalAmount: string;
  insuranceAmount: string;
  companions: number;
  status: string;
  statusText: string;
  additions: AdditionRow[];
  /** إجمالي الإضافات — Σ(العدد × السعر). */
  additionsTotal: string;
  /** الإجمالي — الإضافات + القيمة (+ التأمين). */
  total: string;
  /** ضريبة 15% — `ROUND(الإجمالي × MainVAT ÷ 100, 2)`. */
  taxAmount: string;
  /** الصافي — الإجمالي + الضريبة. */
  netAmount: string;
  vatRate: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  version: number;
};

export type ViolationInput = {
  vesselId?: string;
  bookingId?: string;
  partyId?: string;
  violationDate: string;
  /** ⚠️ نوع المخالفة — `ViolatType`. */
  violationType?: string;
  /** ⏱️ مدة المخالفة (يوم) — `Period`. */
  periodDays?: number | string;
  amount?: number | string;
  /** 📝 ملاحظة — `Violation.notes`. */
  description?: string;
};
export type ViolationPatch = Partial<ViolationInput> & { status?: string; version?: number };
export type ViolationQuery = { number?: string; type?: string; vesselId?: string; status?: string; from?: string; to?: string };

export type ViolationRow = {
  id: string;
  number: string | null;
  vesselId: string | null;
  vesselName: string;
  bookingId: string | null;
  partyId: string | null;
  customerName: string;
  violationDate: string;
  /** ⏱️ مدة المخالفة (يوم) — the desktop's grid labels this column «الحالة» by mistake. */
  periodDays: string | null;
  violationType: string | null;
  amount: string;
  description: string;
  status: string;
  statusText: string;
  createdAt: string;
  version: number;
};

const four = (value: Decimal): string => value.toFixed(4);
const round2 = (value: Decimal): Decimal => new Decimal(value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP));

function decimal(value: number | string | null | undefined): Decimal {
  if (value === undefined || value === null || value === '') return new Decimal(0);
  const parsed = new Decimal(String(value));
  return parsed.isFinite() ? parsed : new Decimal(0);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isISODate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** `CalcuAll` (L478): الإضافات، ثم الإجمالي، ثم الضريبة، ثم الصافي. */
function totalsOf(input: { rentalAmount: Decimal; insuranceAmount: Decimal; additions: Decimal }, vatRate: number) {
  const gross = input.rentalAmount.plus(input.additions).plus(input.insuranceAmount);
  const vat = round2(gross.mul(vatRate).div(100));
  // Money in this repository is four decimals; the ضريبة والصافي are money like the rest.
  return { additionsTotal: four(input.additions), total: four(gross), taxAmount: four(vat), netAmount: four(gross.plus(vat)) };
}

@Injectable()
export class MarinaDocumentsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sequences: SequencesService,
  ) {}

  async ensureEnabled(tenantId: string) {
    const [flag] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'pack.marina'))).limit(1),
    );
    if (flag && flag.value !== true && flag.value !== 'true') throw new DomainError('NOT_FOUND', 'Marina pack is disabled', 404);
  }

  // ─────────────────────────────── 📋 بيانات الحجوزات ───────────────────────────────

  /**
   * `GET /marina/bookings` — «📋 نتائج البحث» is the desktop's second tab
   * (`رقم الحركة · الرقم · التاريخ · العميل · الجوال · رقم العميل`), and «📋 بيانات
   * الحجوزات» is one of them opened again.
   */
  async listBookings(tenantId: string, query: BookingQuery = {}): Promise<BookingRow[]> {
    await this.ensureEnabled(tenantId);
    const limit = Math.min(Math.max(Number(query.limit ?? 200) || 200, 1), 500);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ booking: marinaBookings, customerName: parties.name, customerPhone: parties.phone, vesselName: vessels.name, vesselCode: vessels.code })
        .from(marinaBookings)
        .innerJoin(parties, eq(parties.id, marinaBookings.partyId))
        .innerJoin(vessels, eq(vessels.id, marinaBookings.vesselId))
        .where(
          and(
            eq(marinaBookings.tenantId, tenantId),
            isNull(marinaBookings.deletedAt),
            query.number ? eq(marinaBookings.number, query.number.trim()) : undefined,
            query.partyId ? eq(marinaBookings.partyId, query.partyId) : undefined,
            query.vesselId ? eq(marinaBookings.vesselId, query.vesselId) : undefined,
            query.status ? eq(marinaBookings.status, normaliseStatus(query.status)) : undefined,
            isISODate(query.from) ? gte(marinaBookings.documentDate, query.from) : undefined,
            isISODate(query.to) ? lte(marinaBookings.documentDate, query.to) : undefined,
            query.customer ? this.customerSearch(query.customer) : undefined,
          ),
        )
        .orderBy(desc(marinaBookings.documentDate), desc(marinaBookings.createdAt))
        .limit(limit)
        .offset(offset),
    );
    return this.shape(tenantId, rows);
  }

  async getBooking(tenantId: string, id: string): Promise<BookingRow> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ booking: marinaBookings, customerName: parties.name, customerPhone: parties.phone, vesselName: vessels.name, vesselCode: vessels.code })
        .from(marinaBookings)
        .innerJoin(parties, eq(parties.id, marinaBookings.partyId))
        .innerJoin(vessels, eq(vessels.id, marinaBookings.vesselId))
        .where(and(eq(marinaBookings.tenantId, tenantId), eq(marinaBookings.id, id), isNull(marinaBookings.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('MARINA_BOOKING_NOT_FOUND', 'الحجز غير موجود', 404);
    const [shaped] = await this.shape(tenantId, [row]);
    return shaped!;
  }

  /**
   * «💾» — one transaction, three tables, and one refusal before them all:
   * «يجب تحديد مدة الحجز» when الساعة والدقيقة stand at zero.
   *
   * 💰 القيمة is the operator's (`txtPrice`). When it is not sent, the فئة's tariff
   * prices the period instead — the desktop leaves the box to the operator because the
   * tariff is on the wall, and the cloud has the tariff in `vessel_group_pricing`.
   */
  async createBooking(tenantId: string, input: BookingInput, userId?: string): Promise<BookingRow> {
    await this.ensureEnabled(tenantId);
    const period = periodOf(input);
    if (period.hours === 0 && period.minutes === 0)
      throw new DomainError('MARINA_BOOKING_PERIOD_REQUIRED', 'يجب تحديد مدة الحجز', 422);
    // A closed harbour day is frozen — the invariant the day close exists to hold.
    await this.assertDayOpen(tenantId, input.branchId, String(input.startsAt).slice(0, 10));

    const id = newId();
    const rentalAmount = decimal(input.rentalAmount).gt(0) ? decimal(input.rentalAmount) : await this.pricedPeriod(tenantId, input);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const allocated = await this.sequences.next({ tenantId, docType: 'marina_booking' }, tx, BOOKING_SEQUENCE);
      await tx.insert(marinaBookings).values({
        id,
        tenantId,
        branchId: input.branchId,
        partyId: input.partyId,
        vesselId: input.vesselId,
        number: allocated.display,
        documentDate: isISODate(input.documentDate) ? input.documentDate : todayISO(),
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        bookingType: normaliseBookingType(input.bookingType),
        periodHours: period.hours,
        periodMinutes: period.minutes,
        rentalAmount: four(rentalAmount),
        companions: input.companions ?? 0,
        insuranceAmount: four(decimal(input.insuranceAmount)),
        status: normaliseStatus(input.status),
        metadata: input.metadata ?? {},
        createdBy: userId ?? null,
      });
      await this.writeAdditions(tx, tenantId, id, input.additions ?? []);
    });
    return this.getBooking(tenantId, id);
  }

  /**
   * «💾» on a حجز that is already there — `update Booking set … where InvId=…`, then
   * `delete BookingAddition` and every addition again.
   */
  async updateBooking(tenantId: string, id: string, patch: BookingPatch, userId?: string): Promise<BookingRow> {
    await this.ensureEnabled(tenantId);
    const current = await this.rawBooking(tenantId, id);
    const period = patch.periodHours !== undefined || patch.periodMinutes !== undefined
      ? { hours: Math.max(0, Math.trunc(Number(patch.periodHours ?? 0) || 0)), minutes: Math.max(0, Math.trunc(Number(patch.periodMinutes ?? 0) || 0)) }
      : { hours: current.periodHours, minutes: current.periodMinutes };
    if (period.hours === 0 && period.minutes === 0)
      throw new DomainError('MARINA_BOOKING_PERIOD_REQUIRED', 'يجب تحديد مدة الحجز', 422);

    const updated = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .update(marinaBookings)
        .set({
          branchId: patch.branchId ?? current.branchId,
          partyId: patch.partyId ?? current.partyId,
          vesselId: patch.vesselId ?? current.vesselId,
          documentDate: isISODate(patch.documentDate) ? patch.documentDate : current.documentDate,
          startsAt: patch.startsAt ? new Date(patch.startsAt) : current.startsAt,
          endsAt: patch.endsAt ? new Date(patch.endsAt) : current.endsAt,
          bookingType: patch.bookingType === undefined ? current.bookingType : normaliseBookingType(patch.bookingType),
          periodHours: period.hours,
          periodMinutes: period.minutes,
          rentalAmount: patch.rentalAmount === undefined ? current.rentalAmount : four(decimal(patch.rentalAmount)),
          companions: patch.companions ?? current.companions,
          insuranceAmount: patch.insuranceAmount === undefined ? current.insuranceAmount : four(decimal(patch.insuranceAmount)),
          status: patch.status === undefined ? current.status : normaliseStatus(patch.status),
          metadata: patch.metadata ?? current.metadata,
          updatedAt: new Date(),
          updatedBy: userId ?? null,
          version: sql`${marinaBookings.version} + 1`,
        })
        .where(
          and(
            eq(marinaBookings.tenantId, tenantId),
            eq(marinaBookings.id, id),
            isNull(marinaBookings.deletedAt),
            patch.version === undefined ? undefined : eq(marinaBookings.version, patch.version),
          ),
        )
        .returning({ id: marinaBookings.id });
      if (!rows.length) throw new DomainError('VERSION_CONFLICT', 'تم تعديل هذا السجل من مكان آخر', 409);
      // `delete BookingAddition where bookId=…` then the rows again — never a diff.
      if (patch.additions) {
        await tx.delete(marinaBookingAdditions).where(and(eq(marinaBookingAdditions.tenantId, tenantId), eq(marinaBookingAdditions.bookingId, id)));
        await this.writeAdditions(tx, tenantId, id, patch.additions);
      }
    });
    void updated;
    return this.getBooking(tenantId, id);
  }

  /** «🗑️» — the row is hidden; «تم الحذف» is what the window says. */
  async deleteBooking(tenantId: string, id: string, userId?: string): Promise<{ deleted: true; id: string }> {
    await this.ensureEnabled(tenantId);
    await this.rawBooking(tenantId, id);
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(marinaBookings)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null, updatedAt: new Date(), updatedBy: userId ?? null })
        .where(and(eq(marinaBookings.tenantId, tenantId), eq(marinaBookings.id, id), isNull(marinaBookings.deletedAt))),
    );
    return { deleted: true, id };
  }

  // ─────────────────────────────── 🎁 الإضافات ───────────────────────────────

  /**
   * «✔» beside the additions grid — `Add2Dgv` من `frmBookingM.xaml.cs`, in its own order:
   *
   *   • «يجب إدخال الكمية  » when «الكمية» is empty (and an ➕ الإضافة is chosen — a line
   *     written by hand keeps the `1` it always had);
   *   • الاسم من `Additions.name` و💰 القيمة من `Additions.SalePrice`, ما لم يقل المشغّل
   *     غير ذلك — وهو ما يفعله `cmbAdditions_SelectionChanged` بـ«السعر»؛
   *   • وإضافةٌ في الشبكة أصلاً **تُجمَع كمّيتها على صفّها** (`Quantity += quant` ثم
   *     `TotalPrice = Quantity * UnitPrice`)، فلا صفّان للإضافة الواحدة.
   */
  async addAddition(tenantId: string, bookingId: string, input: AdditionInput, userId?: string): Promise<AdditionRow> {
    await this.ensureEnabled(tenantId);
    await this.rawBooking(tenantId, bookingId);
    const definitions = await this.resolveAdditions(tenantId, [input]);
    const definition = definitions.get(this.keyOf(input.additionId));
    if (definition && input.quantity !== undefined && !decimal(input.quantity).gt(0))
      throw new DomainError('MARINA_ADDITION_QUANTITY_REQUIRED', 'يجب إدخال الكمية  ', 422);
    const line = lineOf(input, definition);

    // `ISfound` — الإضافة موجودة في الشبكة: كمّيتها تُضاف إلى صفّها، وسعرها يبقى كما كُتب.
    if (definition) {
      const [existing] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .select()
          .from(marinaBookingAdditions)
          .where(
            and(
              eq(marinaBookingAdditions.tenantId, tenantId),
              eq(marinaBookingAdditions.bookingId, bookingId),
              eq(marinaBookingAdditions.additionId, definition.id),
            ),
          )
          .limit(1),
      );
      if (existing) {
        const quantity = decimal(existing.quantity).plus(line.quantity);
        const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
          tx
            .update(marinaBookingAdditions)
            .set({ quantity: four(quantity), amount: four(quantity.mul(decimal(existing.unitPrice))) })
            .where(and(eq(marinaBookingAdditions.tenantId, tenantId), eq(marinaBookingAdditions.id, existing.id)))
            .returning(),
        );
        return additionRow(row!);
      }
    }

    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.insert(marinaBookingAdditions).values({ id: newId(), tenantId, bookingId, ...line, createdBy: userId ?? null }).returning(),
    );
    return additionRow(row!);
  }

  /** «🗑️ حذف» on a row of «🎁 الإضافات». */
  async removeAddition(tenantId: string, bookingId: string, additionId: string): Promise<{ deleted: true; id: string }> {
    await this.ensureEnabled(tenantId);
    await this.rawBooking(tenantId, bookingId);
    const removed = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .delete(marinaBookingAdditions)
        .where(and(eq(marinaBookingAdditions.tenantId, tenantId), eq(marinaBookingAdditions.bookingId, bookingId), eq(marinaBookingAdditions.id, additionId)))
        .returning({ id: marinaBookingAdditions.id }),
    );
    if (!removed.length) throw new DomainError('MARINA_ADDITION_NOT_FOUND', 'الإضافة غير موجودة', 404);
    return { deleted: true, id: additionId };
  }

  // ─────────────────────────────── ⚠️ المخالفات ───────────────────────────────

  /**
   * «⚠️ قائمة المخالفات» — `select * from Violation where IsDeleted=0`, newest first.
   *
   * The desktop's grid labels the مدة column «الحالة» by mistake (it is bound to
   * `Period`), and ⛵ المركب shows the vessel's id, not its name. Both are righted here
   * — each column under its own name — and the mistake is written down in the docs.
   */
  async listViolations(tenantId: string, query: ViolationQuery = {}): Promise<ViolationRow[]> {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ violation: marinaViolations, vesselName: vessels.name, customerName: parties.name })
        .from(marinaViolations)
        .leftJoin(vessels, eq(vessels.id, marinaViolations.vesselId))
        .leftJoin(parties, eq(parties.id, marinaViolations.partyId))
        .where(
          and(
            eq(marinaViolations.tenantId, tenantId),
            isNull(marinaViolations.deletedAt),
            query.number ? eq(marinaViolations.number, query.number.trim()) : undefined,
            query.type ? eq(marinaViolations.violationType, query.type.trim()) : undefined,
            query.vesselId ? eq(marinaViolations.vesselId, query.vesselId) : undefined,
            query.status ? eq(marinaViolations.status, query.status.trim()) : undefined,
            isISODate(query.from) ? gte(marinaViolations.violationDate, query.from) : undefined,
            isISODate(query.to) ? lte(marinaViolations.violationDate, query.to) : undefined,
          ),
        )
        .orderBy(desc(marinaViolations.violationDate), asc(marinaViolations.number))
        .limit(200),
    );
    return rows.map(({ violation, vesselName, customerName }) => violationRow(violation, vesselName ?? '', customerName ?? ''));
  }

  async getViolation(tenantId: string, id: string): Promise<ViolationRow> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ violation: marinaViolations, vesselName: vessels.name, customerName: parties.name })
        .from(marinaViolations)
        .leftJoin(vessels, eq(vessels.id, marinaViolations.vesselId))
        .leftJoin(parties, eq(parties.id, marinaViolations.partyId))
        .where(and(eq(marinaViolations.tenantId, tenantId), eq(marinaViolations.id, id), isNull(marinaViolations.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('MARINA_VIOLATION_NOT_FOUND', 'اختر المخالفة ليتم حذفها', 404);
    return violationRow(row.violation, row.vesselName ?? '', row.customerName ?? '');
  }

  /** «💾 حفظ» — three refusals, in the window's own order. */
  async createViolation(tenantId: string, input: ViolationInput, userId?: string): Promise<ViolationRow> {
    await this.ensureEnabled(tenantId);
    if (!input.vesselId) throw new DomainError('MARINA_VESSEL_REQUIRED', 'يجب اختيار المركب', 422);
    const periodDays = decimal(input.periodDays);
    if (periodDays.lte(0)) throw new DomainError('MARINA_VIOLATION_PERIOD_REQUIRED', 'يجب تحديد مدة المخالفة', 422);
    const violationType = String(input.violationType ?? '').trim();
    if (!violationType) throw new DomainError('MARINA_VIOLATION_TYPE_REQUIRED', 'يجب تحديد نوع المخالفة', 422);

    const id = newId();
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const allocated = await this.sequences.next({ tenantId, docType: 'marina_violation' }, tx, VIOLATION_SEQUENCE);
      await tx.insert(marinaViolations).values({
        id,
        tenantId,
        number: allocated.display,
        vesselId: input.vesselId,
        bookingId: input.bookingId ?? null,
        partyId: input.partyId ?? null,
        violationDate: input.violationDate,
        periodDays: four(periodDays),
        violationType,
        amount: four(decimal(input.amount)),
        description: input.description ?? '',
        status: VIOLATION_STATUS.open,
        createdBy: userId ?? null,
      });
    });
    return this.getViolation(tenantId, id);
  }

  async updateViolation(tenantId: string, id: string, patch: ViolationPatch, userId?: string): Promise<ViolationRow> {
    await this.ensureEnabled(tenantId);
    const current = await this.rawViolation(tenantId, id);
    const periodDays = patch.periodDays === undefined ? decimal(current.periodDays) : decimal(patch.periodDays);
    if (periodDays.lte(0)) throw new DomainError('MARINA_VIOLATION_PERIOD_REQUIRED', 'يجب تحديد مدة المخالفة', 422);
    const violationType = patch.violationType === undefined ? current.violationType : String(patch.violationType).trim();
    if (!violationType) throw new DomainError('MARINA_VIOLATION_TYPE_REQUIRED', 'يجب تحديد نوع المخالفة', 422);

    const updated = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(marinaViolations)
        .set({
          vesselId: patch.vesselId === undefined ? current.vesselId : patch.vesselId ?? null,
          bookingId: patch.bookingId === undefined ? current.bookingId : patch.bookingId ?? null,
          partyId: patch.partyId === undefined ? current.partyId : patch.partyId ?? null,
          violationDate: patch.violationDate ?? current.violationDate,
          periodDays: four(periodDays),
          violationType,
          amount: patch.amount === undefined ? current.amount : four(decimal(patch.amount)),
          description: patch.description ?? current.description,
          status: patch.status ?? current.status,
          updatedAt: new Date(),
          updatedBy: userId ?? null,
          version: sql`${marinaViolations.version} + 1`,
        })
        .where(
          and(
            eq(marinaViolations.tenantId, tenantId),
            eq(marinaViolations.id, id),
            isNull(marinaViolations.deletedAt),
            patch.version === undefined ? undefined : eq(marinaViolations.version, patch.version),
          ),
        )
        .returning({ id: marinaViolations.id }),
    );
    if (!updated.length) throw new DomainError('VERSION_CONFLICT', 'تم تعديل هذا السجل من مكان آخر', 409);
    return this.getViolation(tenantId, id);
  }

  async deleteViolation(tenantId: string, id: string, userId?: string): Promise<{ deleted: true; id: string }> {
    await this.ensureEnabled(tenantId);
    await this.rawViolation(tenantId, id);
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(marinaViolations)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null, updatedAt: new Date(), updatedBy: userId ?? null })
        .where(and(eq(marinaViolations.tenantId, tenantId), eq(marinaViolations.id, id), isNull(marinaViolations.deletedAt))),
    );
    return { deleted: true, id };
  }

  // ───────────────────────────────────────────────────────────────────────────────

  /** A closed day refuses a حجز dated into it (MARINA_DAY_CLOSED). */
  private async assertDayOpen(tenantId: string, branchId: string, day: string) {
    const [closing] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(marinaDayClosings).where(and(eq(marinaDayClosings.tenantId, tenantId), eq(marinaDayClosings.branchId, branchId), eq(marinaDayClosings.closeDate, day))),
    );
    if (closing) throw new DomainError('MARINA_DAY_CLOSED', 'The harbour day is closed; reopen it before adding movements', 409);
  }

  /** `SettingGeneral.MainVAT where Inv_Id=4`, or 15 when the tenant never set it. */
  private async vatRate(tenantId: string): Promise<number> {
    const [setting] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, VAT_SETTING_KEY))).limit(1),
    );
    const value = Number(setting?.value ?? DEFAULT_VAT_RATE);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_VAT_RATE;
  }

  /** 💰 القيمة from the vessel's فئة (`vessel_group_pricing`) when the box was left empty. */
  private async pricedPeriod(tenantId: string, input: { vesselId: string; startsAt: string; endsAt: string }): Promise<Decimal> {
    const [vessel] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(vessels).where(and(eq(vessels.tenantId, tenantId), eq(vessels.id, input.vesselId))).limit(1),
    );
    if (!vessel?.groupId) return new Decimal(0);
    const prices = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(vesselGroupPricing).where(and(eq(vesselGroupPricing.tenantId, tenantId), eq(vesselGroupPricing.groupId, vessel.groupId!))),
    );
    const hourly = prices.find((row) => row.periodKind === 'hour')?.price ?? '0';
    const half = prices.find((row) => row.periodKind === 'half_hour')?.price;
    const offer = prices.find((row) => row.periodKind === 'offer')?.price;
    try {
      return new Decimal(calculateMarinaPeriod({ startsAt: input.startsAt, endsAt: input.endsAt, hourlyPrice: hourly, halfHourPrice: half, offerPrice: offer }));
    } catch {
      return new Decimal(0);
    }
  }

  private async rawBooking(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(marinaBookings).where(and(eq(marinaBookings.tenantId, tenantId), eq(marinaBookings.id, id), isNull(marinaBookings.deletedAt))).limit(1),
    );
    if (!row) throw new DomainError('MARINA_BOOKING_NOT_FOUND', 'الحجز غير موجود', 404);
    return row;
  }

  private async rawViolation(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(marinaViolations).where(and(eq(marinaViolations.tenantId, tenantId), eq(marinaViolations.id, id), isNull(marinaViolations.deletedAt))).limit(1),
    );
    if (!row) throw new DomainError('MARINA_VIOLATION_NOT_FOUND', 'اختر المخالفة ليتم حذفها', 404);
    return row;
  }

  /** `insert into BookingAddition(bookId, AditionID, Price, quanty, notes, IsDeleted)`. */
  private async writeAdditions(
    tx: DrizzleTx,
    tenantId: string,
    bookingId: string,
    additions: AdditionInput[],
  ): Promise<void> {
    if (!additions.length) return;
    const definitions = await this.resolveAdditions(tenantId, additions);
    const rows = additions
      .map((line) => lineOf(line, definitions.get(this.keyOf(line.additionId))))
      .filter((line) => line.description);
    if (!rows.length) return;
    await tx.insert(marinaBookingAdditions).values(rows.map((line) => ({ id: newId(), tenantId, bookingId, ...line })));
  }

  private keyOf(additionId: string | undefined): string {
    return String(additionId ?? '').trim();
  }

  /**
   * ➕ الإضافات of `Additions` — «🎁 الإضافات» reads them with
   * `select id, Name from Additions where IsDeleted=0`, and an إضافة that is not there is
   * not chosen: «الإضافة غير موجودة».
   */
  private async resolveAdditions(tenantId: string, inputs: AdditionInput[]): Promise<Map<string, AdditionDefinition>> {
    const ids = [...new Set(inputs.map((line) => this.keyOf(line.additionId)).filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(marinaAdditions)
        .where(and(eq(marinaAdditions.tenantId, tenantId), inArray(marinaAdditions.id, ids), isNull(marinaAdditions.deletedAt))),
    );
    const found = new Map<string, AdditionDefinition>(rows.map((row) => [row.id, { id: row.id, name: row.name, salePrice: row.salePrice }]));
    const missing = ids.find((id) => !found.has(id));
    if (missing) throw new DomainError('MARINA_ADDITION_NOT_FOUND', 'الإضافة غير موجودة', 404);
    return found;
  }

  private async shape(
    tenantId: string,
    rows: Array<{ booking: typeof marinaBookings.$inferSelect; customerName: string; customerPhone: string | null; vesselName: string; vesselCode: string }>,
  ): Promise<BookingRow[]> {
    if (!rows.length) return [];
    const vatRate = await this.vatRate(tenantId);
    const ids = rows.map(({ booking }) => booking.id);
    const additions = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(marinaBookingAdditions).where(and(eq(marinaBookingAdditions.tenantId, tenantId), inArray(marinaBookingAdditions.bookingId, ids))),
    );
    const byBooking = new Map<string, AdditionRow[]>();
    for (const row of additions) {
      const list = byBooking.get(row.bookingId) ?? [];
      list.push(additionRow(row));
      byBooking.set(row.bookingId, list);
    }
    return rows.map(({ booking, customerName, customerPhone, vesselName, vesselCode }) => {
      const lines = byBooking.get(booking.id) ?? [];
      const additionsTotal = lines.reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
      const totals = totalsOf({ rentalAmount: decimal(booking.rentalAmount), insuranceAmount: decimal(booking.insuranceAmount), additions: additionsTotal }, vatRate);
      return {
        id: booking.id,
        number: booking.number,
        branchId: booking.branchId,
        partyId: booking.partyId,
        customerName,
        customerPhone: customerPhone ?? '',
        vesselId: booking.vesselId,
        vesselName,
        vesselCode,
        documentDate: booking.documentDate,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        bookingType: booking.bookingType,
        periodHours: booking.periodHours,
        periodMinutes: booking.periodMinutes,
        rentalPeriod: Number((booking.periodHours + booking.periodMinutes / 60).toFixed(4)),
        rentalAmount: booking.rentalAmount,
        insuranceAmount: booking.insuranceAmount,
        companions: booking.companions,
        status: booking.status,
        statusText: booking.status === BOOKING_STATUS.unconfirmed ? BOOKING_STATUS.unconfirmed : BOOKING_STATUS.confirmed,
        additions: lines,
        ...totals,
        vatRate,
        metadata: (booking.metadata ?? {}) as Record<string, unknown>,
        createdAt: booking.createdAt.toISOString(),
        version: booking.version,
      };
    });
  }

  /** `mobile LIKE @Search OR name LIKE @Search` — the other verticals' one box. */
  private customerSearch(keyword: string): SQL | undefined {
    const like = `%${keyword.trim()}%`;
    return or(ilike(parties.phone, like), ilike(parties.name, like));
  }
}

/** ⏱️ المدة — the two boxes, or the two timestamps when the boxes were not sent. */
function periodOf(input: { periodHours?: number | string; periodMinutes?: number | string; startsAt?: string; endsAt?: string }): { hours: number; minutes: number } {
  if (input.periodHours !== undefined || input.periodMinutes !== undefined)
    return { hours: Math.max(0, Math.trunc(Number(input.periodHours ?? 0) || 0)), minutes: Math.max(0, Math.trunc(Number(input.periodMinutes ?? 0) || 0)) };
  const ms = input.startsAt && input.endsAt ? new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime() : 0;
  const minutes = Math.max(0, Math.round(ms / 60000));
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/** العدد × السعر = الإجمالي — the grid's own ثلاثة أعمدة. */
/** ➕ الإضافة كما تُقرأ من تعريفها — `Additions(name, SalePrice)`. */
type AdditionDefinition = { id: string; name: string; salePrice: string };

/**
 * «الإجمالي» — الكمية × السعر (`Math.Round(price * quant, 2)` في `txtQuant_TextChanged`).
 * With an ➕ الإضافة the 📝 الاسم comes from `Additions.name` و💰 القيمة من
 * `Additions.SalePrice` — exactly what `cmbAdditions_SelectionChanged` writes into «السعر».
 */
function lineOf(input: AdditionInput, definition?: AdditionDefinition) {
  const quantity = decimal(input.quantity).gt(0) ? decimal(input.quantity) : new Decimal(1);
  const each = input.unitPrice === undefined ? decimal(definition?.salePrice) : decimal(input.unitPrice);
  const lineTotal = input.amount === undefined || decimal(input.amount).lte(0) ? quantity.mul(each) : decimal(input.amount);
  const unit = quantity.gt(0) ? lineTotal.div(quantity) : lineTotal;
  return {
    description: String(input.description ?? definition?.name ?? '').trim(),
    quantity: four(quantity),
    unitPrice: four(unit),
    amount: four(lineTotal),
    additionId: definition?.id ?? null,
  };
}

/** 🔖 حالة الحجز — «مؤكد» · «غير مؤكد», and the 'booked' of every row before this part. */
function normaliseStatus(value: string | undefined): string {
  const text = String(value ?? '').trim();
  if (!text || text === 'booked' || text === 'confirmed' || text === BOOKING_STATUS.confirmed) return BOOKING_STATUS.confirmed;
  if (text === 'unconfirmed' || text === BOOKING_STATUS.unconfirmed) return BOOKING_STATUS.unconfirmed;
  throw new DomainError('MARINA_BOOKING_STATUS_UNKNOWN', 'حالة الحجز غير معروفة', 422);
}

/** 🚢 نوع الحجز — «حجز عادي» · «بحر مفتوح». */
function normaliseBookingType(value: string | undefined): string {
  const text = String(value ?? '').trim();
  if (!text || text === 'normal' || text === BOOKING_TYPES.normal) return BOOKING_TYPES.normal;
  if (text === 'open_sea' || text === BOOKING_TYPES.openSea) return BOOKING_TYPES.openSea;
  throw new DomainError('MARINA_BOOKING_TYPE_UNKNOWN', 'نوع الحجز غير معروف', 422);
}

function additionRow(row: typeof marinaBookingAdditions.$inferSelect): AdditionRow {
  return { id: row.id, additionId: row.additionId ?? null, description: row.description, quantity: row.quantity, unitPrice: row.unitPrice, amount: row.amount };
}

function violationRow(row: typeof marinaViolations.$inferSelect, vesselName: string, customerName: string): ViolationRow {
  return {
    id: row.id,
    number: row.number,
    vesselId: row.vesselId ?? null,
    vesselName,
    bookingId: row.bookingId ?? null,
    partyId: row.partyId ?? null,
    customerName,
    violationDate: row.violationDate,
    periodDays: row.periodDays,
    violationType: row.violationType ?? null,
    amount: row.amount,
    description: row.description,
    status: row.status,
    statusText: row.status === VIOLATION_STATUS.closed ? 'مغلقة' : 'مفتوحة',
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}
