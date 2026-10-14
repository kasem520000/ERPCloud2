/* eslint-disable no-restricted-syntax */
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import { marinaBookingAdditions, marinaBookings, marinaDayClosings, marinaOperationPlanLines, marinaOperationPlans, marinaPreparations, marinaViolations, parties, rentalInvoices, tenantSettings, vesselGroupPricing, vesselGroups, vesselOwners, vessels, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';
import { SalesService } from '../sales/sales.service.js';

import { calculateMarinaPeriod } from './marina-pricing.js';

export type RentalInvoiceFilters = { partyId?: string; customer?: string; from?: string; to?: string; minNet?: string; maxNet?: string };

function isISODate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

@Injectable()
export class MarinaService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle, private readonly sales: SalesService) {}
  async ensureEnabled(tenantId: string) { const [flag] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'pack.marina'))).limit(1)); if (flag && flag.value !== true && flag.value !== 'true') throw new DomainError('NOT_FOUND', 'Marina pack is disabled', 404); }
  async createGroup(tenantId: string, input: { name: string; code?: string }) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(vesselGroups).values({ id: newId(), tenantId, ...input }).returning()); return row; }
  async price(tenantId: string, groupId: string, input: { periodKind: string; price: string; currency?: string }) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(vesselGroupPricing).values({ id: newId(), tenantId, groupId, periodKind: input.periodKind, price: input.price, currency: input.currency ?? 'SAR' }).returning()); return row; }
  async createVessel(tenantId: string, input: { groupId?: string; code: string; name: string; capacity?: number; metadata?: Record<string, unknown> }) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(vessels).values({ id: newId(), tenantId, groupId: input.groupId, code: input.code, name: input.name, capacity: input.capacity ?? 0, metadata: input.metadata ?? {} }).returning()); return row; }
  /**
   * «🗑️ حذف» of a ⚓ مركب — it is retired, not erased.
   *
   * The desktop has no window for this: a مركب is never removed, and a فئة can therefore
   * never be removed while one belongs to it («هذه الفئة لها ارتباطات فرعية لايمكن
   * حذفها»). The cloud needs the way out — a مركب that leaves the harbour — so that the
   * فئة can follow it.
   */
  async deleteVessel(tenantId: string, id: string) {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(vessels)
        .set({ deletedAt: new Date(), deletedBy: tryGetAuthContext()?.userId ?? null, updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId ?? null })
        .where(and(eq(vessels.tenantId, tenantId), eq(vessels.id, id), isNull(vessels.deletedAt)))
        .returning({ id: vessels.id }),
    );
    if (!rows.length) throw new DomainError('MARINA_VESSEL_NOT_FOUND', 'المركب غير موجود', 404);
    return { deleted: true, id };
  }

  async addOwner(tenantId: string, vesselId: string, input: { partyId: string; percent: string }) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(vesselOwners).values({ id: newId(), tenantId, vesselId, partyId: input.partyId, percent: input.percent }).returning()); return row; }
  async createBooking(tenantId: string, input: { branchId: string; partyId: string; vesselId: string; startsAt: string; endsAt: string; companions?: number; insuranceAmount?: string; metadata?: Record<string, unknown> }) { await this.ensureEnabled(tenantId); await this.assertDayOpen(tenantId, input.branchId, input.startsAt.slice(0, 10)); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(marinaBookings).values({ id: newId(), tenantId, branchId: input.branchId, partyId: input.partyId, vesselId: input.vesselId, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), companions: input.companions ?? 0, insuranceAmount: input.insuranceAmount ?? '0', metadata: input.metadata ?? {} }).returning()); return row; }
  async addBookingAddition(tenantId: string, bookingId: string, input: { description: string; amount: string }) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(marinaBookingAdditions).values({ id: newId(), tenantId, bookingId, description: input.description, amount: input.amount }).returning()); return row; }
  async createRentalInvoice(tenantId: string, bookingId: string) { await this.ensureEnabled(tenantId); const [booking] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(marinaBookings).where(and(eq(marinaBookings.tenantId, tenantId), eq(marinaBookings.id, bookingId)))); if (!booking) throw new DomainError('BOOKING_NOT_FOUND', 'Booking not found', 404); await this.assertDayOpen(tenantId, booking.branchId, booking.startsAt.toISOString().slice(0, 10)); const [vessel] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(vessels).where(and(eq(vessels.tenantId, tenantId), eq(vessels.id, booking.vesselId)))); const prices = vessel?.groupId ? await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(vesselGroupPricing).where(and(eq(vesselGroupPricing.tenantId, tenantId), eq(vesselGroupPricing.groupId, vessel.groupId!)))) : []; const hourly = prices.find((p) => p.periodKind === 'hour')?.price ?? '0'; const half = prices.find((p) => p.periodKind === 'half_hour')?.price; const offer = prices.find((p) => p.periodKind === 'offer')?.price; // 💰 القيمة (`Booking.Price`) is the operator's; the فئة's tariff is the fall-back.
    const priced = calculateMarinaPeriod({ startsAt: booking.startsAt.toISOString(), endsAt: booking.endsAt.toISOString(), hourlyPrice: hourly, halfHourPrice: half, offerPrice: offer });
    const periodAmount = new Decimal(booking.rentalAmount ?? '0').gt(0) ? booking.rentalAmount : priced; const additions = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(marinaBookingAdditions).where(and(eq(marinaBookingAdditions.tenantId, tenantId), eq(marinaBookingAdditions.bookingId, bookingId)))); const additionsAmount = additions.reduce((sum, line) => sum.plus(line.amount), new Decimal(0)); const total = new Decimal(periodAmount).plus(additionsAmount).plus(booking.insuranceAmount); const invoice = await this.sales.create(tenantId, { branchId: booking.branchId, partyId: booking.partyId, kind: 'sale', lines: [{ description: `Marina rental ${bookingId}`, quantity: '1', unitPrice: total.toFixed(4), taxRate: '0' }] }); // `CalcuAll` — ضريبة 15% على الإجمالي، والصافي = الإجمالي + الضريبة.
    const vatRate = await this.vatRate(tenantId);
    const taxAmount = total.mul(vatRate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const [rental] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(rentalInvoices).values({ id: newId(), tenantId, bookingId, salesInvoiceId: invoice.id, documentDate: booking.documentDate, periodAmount, additionsAmount: additionsAmount.toFixed(4), insuranceAmount: booking.insuranceAmount, total: total.toFixed(4), taxAmount: taxAmount.toFixed(2), netAmount: total.plus(taxAmount).toFixed(2), metadata: { companions: booking.companions, source: 'booking', vatRate, periodHours: booking.periodHours, periodMinutes: booking.periodMinutes } }).returning()); return { data: { ...rental, salesInvoiceId: invoice.id } }; }
  async violation(tenantId: string, input: { vesselId?: string; bookingId?: string; partyId?: string; violationDate: string; amount?: string; description: string }) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(marinaViolations).values({ id: newId(), tenantId, ...input, amount: input.amount ?? '0' }).returning()); return row; }
  async plan(tenantId: string, input: { groupId?: string; planDate: string; name: string; lines?: Array<{ vesselId: string; periodLabel?: string; metadata?: Record<string, unknown> }> }) { await this.ensureEnabled(tenantId); const id = newId(); await withTenantTx(this.database.db, tenantId, async (tx) => { await tx.insert(marinaOperationPlans).values({ id, tenantId, groupId: input.groupId, planDate: input.planDate, name: input.name }); if (input.lines?.length) await tx.insert(marinaOperationPlanLines).values(input.lines.map((line, index) => ({ planId: id, tenantId, lineNo: index + 1, vesselId: line.vesselId, periodLabel: line.periodLabel, metadata: line.metadata ?? {} }))); }); return { id }; }
  async listBookings(tenantId: string) { await this.ensureEnabled(tenantId); return withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(marinaBookings).where(eq(marinaBookings.tenantId, tenantId)).orderBy(desc(marinaBookings.startsAt)).limit(200)); }
  async listViolations(tenantId: string) { await this.ensureEnabled(tenantId); return withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(marinaViolations).where(and(eq(marinaViolations.tenantId, tenantId), isNull(marinaViolations.deletedAt))).orderBy(desc(marinaViolations.violationDate)).limit(200)); }
  async list(tenantId: string) { await this.ensureEnabled(tenantId); return { groups: await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(vesselGroups).where(and(eq(vesselGroups.tenantId, tenantId), isNull(vesselGroups.deletedAt)))), vessels: await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(vessels).where(and(eq(vessels.tenantId, tenantId), isNull(vessels.deletedAt)))) }; }

  // ------------------------------------------------------------- operations (0025)

  /**
   * خطة الدور. The plan already had a writer and no reader, which made the screen
   * impossible: you could file a rota and never see it again.
   */
  async listPlans(tenantId: string, planDate?: string) {
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const plans = await tx
        .select()
        .from(marinaOperationPlans)
        .where(and(eq(marinaOperationPlans.tenantId, tenantId), isNull(marinaOperationPlans.deletedAt), planDate ? eq(marinaOperationPlans.planDate, planDate) : undefined))
        .orderBy(desc(marinaOperationPlans.planDate))
        .limit(100);
      if (!plans.length) return [];
      const lines = await tx
        .select()
        .from(marinaOperationPlanLines)
        .where(and(eq(marinaOperationPlanLines.tenantId, tenantId), inArray(marinaOperationPlanLines.planId, plans.map((plan) => plan.id))))
        .orderBy(asc(marinaOperationPlanLines.lineNo));
      return plans.map((plan) => ({ ...plan, lines: lines.filter((line) => line.planId === plan.id) }));
    });
  }

  /** تحضير المراكب — the pre-departure checklist, one per booking. */
  async listPreparations(tenantId: string, filters: { date?: string; status?: string } = {}) {
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(marinaPreparations)
        .where(and(
          eq(marinaPreparations.tenantId, tenantId),
          filters.date ? eq(marinaPreparations.preparedOn, filters.date) : undefined,
          filters.status ? eq(marinaPreparations.status, filters.status) : undefined,
        ))
        .orderBy(desc(marinaPreparations.preparedAt))
        .limit(200));
  }

  async prepareBooking(tenantId: string, bookingId: string, input: { preparedOn?: string; fuelLevel?: string; lifeJackets?: number; checklist?: Record<string, unknown>; notes?: string }) {
    await this.ensureEnabled(tenantId);
    const [booking] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(marinaBookings).where(and(eq(marinaBookings.tenantId, tenantId), eq(marinaBookings.id, bookingId))));
    if (!booking) throw new DomainError('BOOKING_NOT_FOUND', 'Booking not found', 404);
    if ((input.lifeJackets ?? 0) < 0) throw new DomainError('MARINA_JACKETS_INVALID', 'Life jacket count cannot be negative', 422);
    // A vessel carrying passengers without a jacket each is the one check a harbour is
    // actually inspected on, so it is a rule here rather than a note in the UI.
    if (input.lifeJackets !== undefined && booking.companions > 0 && input.lifeJackets < booking.companions) {
      throw new DomainError('MARINA_JACKETS_INSUFFICIENT', 'Life jackets must cover every companion on the booking', 422);
    }
    const existing = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(marinaPreparations).where(and(eq(marinaPreparations.tenantId, tenantId), eq(marinaPreparations.bookingId, bookingId))));
    if (existing.length) throw new DomainError('MARINA_ALREADY_PREPARED', 'This booking has already been prepared', 409);

    const [row] = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const inserted = await tx.insert(marinaPreparations).values({
        id: newId(),
        tenantId,
        bookingId,
        vesselId: booking.vesselId,
        preparedOn: input.preparedOn ?? booking.startsAt.toISOString().slice(0, 10),
        status: 'prepared',
        fuelLevel: input.fuelLevel,
        lifeJackets: input.lifeJackets ?? 0,
        checklist: input.checklist ?? {},
        notes: input.notes,
        createdBy: tryGetAuthContext()?.userId,
      }).returning();
      await tx.update(marinaBookings).set({ status: 'prepared', updatedAt: new Date() }).where(and(eq(marinaBookings.tenantId, tenantId), eq(marinaBookings.id, bookingId)));
      return inserted;
    });
    return row;
  }

  async returnPreparation(tenantId: string, preparationId: string, input: { returnNotes?: string } = {}) {
    await this.ensureEnabled(tenantId);
    const [preparation] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(marinaPreparations).where(and(eq(marinaPreparations.tenantId, tenantId), eq(marinaPreparations.id, preparationId))));
    if (!preparation) throw new DomainError('MARINA_PREPARATION_NOT_FOUND', 'Preparation was not found', 404);
    if (preparation.status !== 'prepared') throw new DomainError('MARINA_PREPARATION_INVALID_STATUS', 'This vessel has already been returned', 409);
    const [row] = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const updated = await tx.update(marinaPreparations)
        .set({ status: 'returned', returnedAt: new Date(), returnNotes: input.returnNotes, updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(marinaPreparations.tenantId, tenantId), eq(marinaPreparations.id, preparationId)))
        .returning();
      await tx.update(marinaBookings).set({ status: 'returned', updatedAt: new Date() }).where(and(eq(marinaBookings.tenantId, tenantId), eq(marinaBookings.id, preparation.bookingId)));
      return updated;
    });
    return row;
  }

  /** ربط الفواتير — rental invoices with their booking and the sales invoice behind them. */
  /**
   * `GET /marina/rental-invoices` — «🧾 قائمة الفواتير» of
   * `Form_WPF/frmInvoiceRentSrch.xaml` («بحث الفواتير»): «🔍 خيارات البحث» are رقم
   * الفاتورة · التاريخ من/إلى · العميل · جوال العميل · الصافي من/إلى, and the grid is
   * `الرقم · 📅 التاريخ · 👤 العميل · 💰 الصافي · 👤 المستخدم · 📱 الجوال`.
   *
   * «نوع العملية» و«المستخدم» are not filters here: this table holds rental invoices
   * only (`proc_type=4` was the desktop's discriminator), and no column carries the
   * cashier — both are left out rather than offered and ignored.
   */
  async listRentalInvoices(tenantId: string, filters: RentalInvoiceFilters = {}) {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ invoice: rentalInvoices, customerName: parties.name, customerPhone: parties.phone, bookingNumber: marinaBookings.number })
        .from(rentalInvoices)
        .innerJoin(marinaBookings, eq(marinaBookings.id, rentalInvoices.bookingId))
        .leftJoin(parties, eq(parties.id, marinaBookings.partyId))
        .where(
          and(
            eq(rentalInvoices.tenantId, tenantId),
            filters.partyId ? eq(marinaBookings.partyId, filters.partyId) : undefined,
            filters.customer ? or(ilike(parties.phone, `%${filters.customer.trim()}%`), ilike(parties.name, `%${filters.customer.trim()}%`)) : undefined,
            filters.minNet ? gte(rentalInvoices.netAmount, filters.minNet) : undefined,
            filters.maxNet ? lte(rentalInvoices.netAmount, filters.maxNet) : undefined,
          ),
        )
        .orderBy(desc(rentalInvoices.createdAt))
        .limit(200),
    );
    const from = isISODate(filters.from) ? filters.from : undefined;
    const to = isISODate(filters.to) ? filters.to : undefined;
    return rows
      .filter(({ invoice }) => {
        const day = String(invoice.documentDate ?? invoice.createdAt.toISOString().slice(0, 10));
        if (from && day < from) return false;
        if (to && day > to) return false;
        return true;
      })
      .map(({ invoice, customerName, customerPhone, bookingNumber }) => ({
        ...invoice,
        // 🔢 الرقم — the حجز's own number is the invoice's الرقم in the search grid.
        number: bookingNumber ?? null,
        customerName: customerName ?? '',
        customerPhone: customerPhone ?? '',
        documentDate: invoice.documentDate ?? invoice.createdAt.toISOString().slice(0, 10),
      }));
  }

  /** Bookings that have finished but were never invoiced — the work list of that screen. */
  async listUninvoicedBookings(tenantId: string) {
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const bookings = await tx
        .select()
        .from(marinaBookings)
        .where(and(eq(marinaBookings.tenantId, tenantId), isNull(marinaBookings.deletedAt)))
        .orderBy(desc(marinaBookings.startsAt))
        .limit(200);
      if (!bookings.length) return [];
      const invoiced = await tx.select({ bookingId: rentalInvoices.bookingId }).from(rentalInvoices).where(eq(rentalInvoices.tenantId, tenantId));
      const done = new Set(invoiced.map((row) => row.bookingId));
      return bookings.filter((booking) => !done.has(booking.id));
    });
  }

  /** Issues the rental invoice for several bookings at once; failures are reported per booking. */
  async linkInvoices(tenantId: string, bookingIds: string[]) {
    await this.ensureEnabled(tenantId);
    if (!bookingIds?.length) throw new DomainError('MARINA_BOOKINGS_REQUIRED', 'Select at least one booking', 422);
    const linked: Array<{ bookingId: string; rentalInvoiceId: string | null; salesInvoiceId: string | null }> = [];
    const failed: Array<{ bookingId: string; code: string; message: string }> = [];
    for (const bookingId of bookingIds) {
      try {
        const created = await this.createRentalInvoice(tenantId, bookingId);
        linked.push({ bookingId, rentalInvoiceId: created.data.id ?? null, salesInvoiceId: created.data.salesInvoiceId ?? null });
      } catch (error) {
        const domain = error as DomainError;
        failed.push({ bookingId, code: domain.code ?? 'MARINA_LINK_FAILED', message: domain.message });
      }
    }
    return { linked, failed };
  }

  /** إغلاق اليومية — the day's totals, whether or not it has been closed yet. */
  async dayCloseSummary(tenantId: string, branchId: string, closeDate: string) {
    await this.ensureEnabled(tenantId);
    if (!branchId) throw new DomainError('MARINA_BRANCH_REQUIRED', 'A branch is required to close the day', 422);
    const dayStart = new Date(`${closeDate}T00:00:00.000Z`);
    const dayEnd = new Date(`${closeDate}T23:59:59.999Z`);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const bookings = await tx
        .select()
        .from(marinaBookings)
        .where(and(
          eq(marinaBookings.tenantId, tenantId),
          eq(marinaBookings.branchId, branchId),
          isNull(marinaBookings.deletedAt),
          gte(marinaBookings.startsAt, dayStart),
          lte(marinaBookings.startsAt, dayEnd),
        ));
      const bookingIds = bookings.map((booking) => booking.id);
      const rentals = bookingIds.length
        ? await tx.select().from(rentalInvoices).where(and(eq(rentalInvoices.tenantId, tenantId), inArray(rentalInvoices.bookingId, bookingIds)))
        : [];
      const violations = await tx
        .select()
        .from(marinaViolations)
        .where(and(eq(marinaViolations.tenantId, tenantId), isNull(marinaViolations.deletedAt), eq(marinaViolations.violationDate, closeDate)));
      const [closing] = await tx
        .select()
        .from(marinaDayClosings)
        .where(and(eq(marinaDayClosings.tenantId, tenantId), eq(marinaDayClosings.branchId, branchId), eq(marinaDayClosings.closeDate, closeDate)));

      const sum = (rows: Array<Record<string, unknown>>, key: string) => rows.reduce((carry, row) => carry.plus(new Decimal(String(row[key] ?? '0'))), new Decimal(0)).toFixed(4);
      return {
        branchId,
        closeDate,
        closed: Boolean(closing),
        closing: closing ?? null,
        bookingsCount: bookings.length,
        rentalsCount: rentals.length,
        uninvoicedCount: bookings.filter((booking) => !rentals.some((rental) => rental.bookingId === booking.id)).length,
        rentalsTotal: sum(rentals, 'total'),
        additionsTotal: sum(rentals, 'additionsAmount'),
        insuranceTotal: sum(rentals, 'insuranceAmount'),
        violationsTotal: sum(violations, 'amount'),
        violationsCount: violations.length,
      };
    });
  }

  async closeDay(tenantId: string, input: { branchId: string; closeDate: string; notes?: string; force?: boolean }) {
    const summary = await this.dayCloseSummary(tenantId, input.branchId, input.closeDate);
    if (summary.closed) throw new DomainError('MARINA_DAY_ALREADY_CLOSED', 'This day is already closed for the branch', 409);
    if (summary.bookingsCount === 0) throw new DomainError('MARINA_DAY_EMPTY', 'There is nothing to close on this day', 422);
    // Closing over uninvoiced bookings hides revenue, so it takes an explicit override.
    if (summary.uninvoicedCount > 0 && !input.force) {
      throw new DomainError('MARINA_DAY_UNINVOICED', `${summary.uninvoicedCount} booking(s) on this day still have no rental invoice`, 422);
    }
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(marinaDayClosings).values({
      id: newId(),
      tenantId,
      branchId: input.branchId,
      closeDate: input.closeDate,
      bookingsCount: summary.bookingsCount,
      rentalsCount: summary.rentalsCount,
      rentalsTotal: summary.rentalsTotal,
      additionsTotal: summary.additionsTotal,
      insuranceTotal: summary.insuranceTotal,
      violationsTotal: summary.violationsTotal,
      notes: input.notes,
      closedBy: tryGetAuthContext()?.userId,
      createdBy: tryGetAuthContext()?.userId,
    }).returning());
    return row;
  }

  async listDayClosings(tenantId: string, branchId?: string) {
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(marinaDayClosings)
        .where(and(eq(marinaDayClosings.tenantId, tenantId), branchId ? eq(marinaDayClosings.branchId, branchId) : undefined))
        .orderBy(desc(marinaDayClosings.closeDate))
        .limit(200));
  }

  /** `SettingGeneral.MainVAT where Inv_Id=4` — «ضريبة 15%», unless the tenant changed it. */
  private async vatRate(tenantId: string): Promise<number> {
    const [setting] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'marina.vatRate'))).limit(1),
    );
    const value = Number(setting?.value ?? 15);
    return Number.isFinite(value) && value >= 0 ? value : 15;
  }

  /** A closed day is frozen: no new booking and no new rental invoice may be dated into it. */
  private async assertDayOpen(tenantId: string, branchId: string, day: string) {
    const [closing] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(marinaDayClosings).where(and(eq(marinaDayClosings.tenantId, tenantId), eq(marinaDayClosings.branchId, branchId), eq(marinaDayClosings.closeDate, day))));
    if (closing) throw new DomainError('MARINA_DAY_CLOSED', 'The harbour day is closed; reopen it before adding movements', 409);
  }
}
