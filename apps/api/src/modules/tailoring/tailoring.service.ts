import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, ilike, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  customerMeasurements,
  parties,
  tailoringGarmentTypes,
  tailoringInvoicePayments,
  tailoringInvoices,
  tailoringOptionCategories,
  tailoringMeasurementAttributes,
  tailoringOptionValues,
  tailoringOrderOptions,
  tailoringOrders,
  tailoringOrderStatuses,
  tailoringTypes,
  tenantSettings,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { isUniqueViolation } from '../organization/shared/org-support.js';
import { SequencesService } from '../platform-services/index.js';
import { TreasuryService } from '../treasury/treasury.service.js';

/**
 * 🧵 طلب التفصيل — the port of `Form_WPF/frmOrders.xaml` («إدارة طلبات التفصيل»),
 * `Form_WPF/frmOrderDetails.xaml` («إضافة طلب تفصيل») and `Form_WPF/frmOptions.xaml`
 * («⚙️ إدارة الخيارات الجاهزة»).
 *
 * The desktop's four tables are just names in queries — no DDL for `TailoringOrders`,
 * `OrderStatus`, `TailoringTypes`, `OptionCategories`, `OptionValues` or `OrderOptions`
 * ships with this repository — so the column shape below is read off the SELECTs and
 * INSERTs that use them:
 *
 *   • `frmOrders.xaml.cs` `LoadOrders` L73 — `vw_OrdersComplete` with `OrderID`,
 *     `OrderNumber`, `CustomerName`, `CustomerPhone`, `MeasurementName`, `TypeName`,
 *     `StatusName`, `OrderDate`, `DeliveryDate`, `Price`, `PaidAmount`,
 *     `RemainingAmount`, `IsDelayed`, filtered by status / من / إلى / search and ordered
 *     `OrderDate DESC`.
 *   • `frmOrderDetails.xaml.cs` — `TailoringOrders(Cust_ID, MeasurementID, TypeID,
 *     DeliveryDate, Quantity, Price, PaidAmount, FabricType, FabricColor, DesignNotes,
 *     GeneralNotes, CreatedBy)` plus `OrderOptions(OrderID, CategoryID, ValueID)`.
 *   • `frmOptions.xaml.cs` — `OptionCategories(CategoryName, DisplayOrder, IsActive)` and
 *     `OptionValues(CategoryID, ValueName, DisplayOrder, IsDefault, IsActive)`.
 *
 * The rules that are ported, all of them from the code-behind:
 *
 *   • «الرجاء اختيار عميل» / «الرجاء اختيار نوع التفصيل» / «الرجاء إدخال السعر»
 *     (`btnSave_Click` L320–341) — a customer, a type and a price greater than zero are
 *     what makes an order savable.
 *   • ⌛ المتبقي = 💰 السعر − 💵 المدفوع (`CalculateRemaining` L290). The desktop never
 *     refuses a negative remaining, it paints it green instead of red, so neither do we.
 *   • «الكل» in `cmbStatus` is `StatusID = 0`, i.e. no filter at all (L79).
 *   • the search box matches رقم الطلب or اسم العميل (L100), never الجوال.
 */
export type MeasurementInput = {
  partyId: string;
  kind?: string;
  /** 👤 اسم صاحب القياس — `MeasurementName`; «قياس بتاريخ …» stands in when it is null. */
  name?: string | null;
  /** 📅 التاريخ — `MeasurementDate`, today when it is not sent. */
  measurementDate?: string;
  /**
   * 📐 قيم القياسات — one row per خاصية, as `frmMeasurementDetails` builds them from
   * `MeasurementAttributes`. A value is written only when it is greater than zero.
   */
  values?: Array<{ attributeId: string; value: string | number }>;
  /** Keys written before the 📏 خصائص existed (`height` · `shoulder` …) are kept as they are. */
  measurements?: Record<string, string>;
  notes?: string | null;
  active?: boolean;
};
export type MeasurementPatch = Partial<MeasurementInput> & { version?: number };
export type MeasurementQuery = { search?: string; partyId?: string; limit?: number | string; offset?: number | string };

export type MeasurementValueRow = { attributeId: string; attributeName: string; value: string; displayOrder: number };
export type MeasurementRow = {
  id: string;
  partyId: string;
  customerName: string;
  customerPhone: string;
  kind: string;
  name: string | null;
  displayName: string;
  measurementDate: string;
  notes: string | null;
  active: boolean;
  measurementCount: number;
  values: MeasurementValueRow[];
  measurements: Record<string, string>;
  createdAt: string;
  version: number;
};
export type MeasurementListResult = {
  data: MeasurementRow[];
  meta: { total: number; customer: { id: string; name: string; phone: string } | null };
};

/** 📏 خصائص القياسات — `MeasurementAttributes(AttributeID, AttributeName, DisplayOrder, IsActive)`. */
export type AttributeRow = {
  id: string;
  nameAr: string;
  displayOrder: number;
  active: boolean;
  /** ⚙️ الحالة — `CASE WHEN IsActive = 1 THEN 'نشط' ELSE 'معطل' END`. */
  statusText: string;
  version: number;
};
export type AttributeInput = { nameAr: string };
export type AttributePatch = { nameAr?: string; active?: boolean; version?: number };

export type StatusRow = {
  id: string;
  code: string;
  nameAr: string;
  displayOrder: number;
  isFinal: boolean;
  active: boolean;
};

export type TypeInput = { code?: string | null; nameAr: string; defaultPrice?: number | string };
export type TypePatch = { code?: string | null; nameAr?: string; defaultPrice?: number | string; active?: boolean };
export type TypeRow = { id: string; code: string | null; nameAr: string; defaultPrice: string; active: boolean };

export type CategoryInput = { nameAr: string; displayOrder?: number };
export type ValueInput = { categoryId: string; nameAr: string; displayOrder?: number; isDefault?: boolean };

export type CategoryRow = {
  id: string;
  nameAr: string;
  displayOrder: number;
  active: boolean;
  values: Array<{ id: string; nameAr: string; displayOrder: number; isDefault: boolean; active: boolean }>;
};

export type OrderOptionInput = { categoryId: string; valueId: string };

export type OrderInput = {
  partyId: string;
  typeId: string;
  statusId?: string;
  measurementId?: string | null;
  orderDate?: string;
  deliveryDate?: string | null;
  quantity?: number | string;
  price: number | string;
  paidAmount?: number | string;
  fabricType?: string | null;
  fabricColor?: string | null;
  designNotes?: string | null;
  generalNotes?: string | null;
  options?: OrderOptionInput[];
};

export type OrderPatch = Partial<OrderInput> & { version?: number };

export type OrderQuery = {
  statusId?: string;
  partyId?: string;
  from?: string;
  to?: string;
  search?: string;
  typeId?: string;
  limit?: number;
  offset?: number;
};

export type OrderRow = {
  id: string;
  number: string;
  partyId: string;
  customerName: string;
  customerPhone: string;
  measurementId: string | null;
  measurementName: string | null;
  typeId: string;
  typeName: string;
  statusId: string;
  statusName: string;
  orderDate: string;
  deliveryDate: string | null;
  quantity: string;
  price: string;
  paidAmount: string;
  remainingAmount: string;
  isDelayed: boolean;
  fabricType: string | null;
  fabricColor: string | null;
  designNotes: string | null;
  generalNotes: string | null;
  version: number;
  options: Array<{ categoryId: string; categoryName: string; valueId: string; valueName: string }>;
};

const ORDER_SEQUENCE = { prefix: 'TO-', padding: 6 } as const;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isISODate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** `frmOrderDetails` reads every number with `decimal.TryParse(…, out x)` — blank is zero. */
function decimal(value: number | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function four(value: number): string {
  return value.toFixed(4);
}

function isDelayedOn(deliveryDate: string | null, isFinal: boolean): boolean {
  if (!deliveryDate || isFinal) return false;
  return deliveryDate < todayISO();
}

@Injectable()
export class TailoringService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sequences: SequencesService,
    /** «💵 إستلام دفعة» writes a سند قبض through the treasury, as `frmSandQ` does. */
    private readonly treasury: TreasuryService,
  ) {}

  async ensureEnabled(tenantId: string) {
    const [flag] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tenantSettings)
        .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'pack.tailoring')))
        .limit(1),
    );
    if (flag && flag.value !== true && flag.value !== 'true')
      throw new DomainError('NOT_FOUND', 'Tailoring pack is disabled', 404);
  }

  // ─────────────────────────────── 📏 القياسات ───────────────────────────────

  /**
   * 📏 القياسات — `Form_WPF/frmMeasurements.xaml` («إدارة قياسات العملاء») with the
   * card of `frmMeasurementDetails.xaml` («📏 بيانات القياس») and the definitions
   * window `frmMeasurementAttributes.xaml` («📏 إدارة خصائص القياسات»).
   *
   * The list is one of two things, and the desktop decides by whether a عميل has been
   * searched for: `LoadAllMeasurements` (every active قياس with its customer,
   * `ORDER BY cm.MeasurementDate DESC`) or `LoadCustomerMeasurements` (one customer's
   * قياسات after «🔍 بحث» resolves `SELECT TOP 10 id, name, mobile FROM Customers WHERE
   * mobile LIKE @Search OR name LIKE @Search ORDER BY name` and takes the first row).
   */
  async listMeasurements(tenantId: string, query: MeasurementQuery = {}): Promise<MeasurementListResult> {
    await this.ensureEnabled(tenantId);
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

    // «🔍 بحث» — the desktop refuses an empty box and reports a customer it cannot find.
    if (query.search !== undefined) {
      const keyword = query.search.trim();
      if (!keyword)
        throw new DomainError(
          'TAILORING_MEASUREMENT_SEARCH_REQUIRED',
          'الرجاء إدخال رقم الجوال أو اسم العميل',
          422,
        );
      const customer = await this.firstCustomerByKeyword(tenantId, keyword);
      if (!customer) throw new DomainError('TAILORING_CUSTOMER_NOT_FOUND', 'لم يتم العثور على عميل', 404);
      const rows = await this.measurementsOf(tenantId, customer.id);
      return { data: rows, meta: { total: rows.length, customer } };
    }

    const where = query.partyId
      ? and(eq(customerMeasurements.tenantId, tenantId), eq(customerMeasurements.partyId, query.partyId), isNull(customerMeasurements.deletedAt))
      : and(eq(customerMeasurements.tenantId, tenantId), isNull(customerMeasurements.deletedAt));
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ measurement: customerMeasurements, customerName: parties.name, customerPhone: parties.phone })
        .from(customerMeasurements)
        .innerJoin(parties, eq(parties.id, customerMeasurements.partyId))
        .where(where)
        .orderBy(desc(customerMeasurements.measurementDate), desc(customerMeasurements.createdAt))
        .limit(limit)
        .offset(offset),
    );
    const [counted] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ total: count() }).from(customerMeasurements).where(where),
    );
    return {
      data: await this.shapeMeasurements(tenantId, rows),
      meta: { total: Number(counted?.total ?? 0), customer: null },
    };
  }

  /** `GET /tailoring/parties/{id}/measurements` — the قياسات of one عميل (unchanged shape, grown). */
  async list(tenantId: string, partyId: string) {
    const rows = await this.measurementsOf(tenantId, partyId);
    return { data: rows };
  }

  async latest(tenantId: string, partyId: string) {
    const rows = await this.measurementsOf(tenantId, partyId);
    return { data: rows[0] ?? null };
  }

  async getMeasurement(tenantId: string, id: string): Promise<MeasurementRow> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ measurement: customerMeasurements, customerName: parties.name, customerPhone: parties.phone })
        .from(customerMeasurements)
        .innerJoin(parties, eq(parties.id, customerMeasurements.partyId))
        .where(and(eq(customerMeasurements.tenantId, tenantId), eq(customerMeasurements.id, id), isNull(customerMeasurements.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('TAILORING_MEASUREMENT_NOT_FOUND', 'القياس غير موجود', 404);
    const [shaped] = await this.shapeMeasurements(tenantId, [row]);
    return shaped!;
  }

  /**
   * `frmMeasurementDetails.btnSave_Click` — one transaction, two refusals:
   * «الرجاء إدخال اسم صاحب القياس» و«الرجاء إدخال قياس واحد على الأقل» (a value counts
   * only when it parses to a decimal greater than zero; the rest are not written).
   *
   * The name is refused only when the caller **sends** it blank — the card always does —
   * because this endpoint existed before the name did, and «قياس بتاريخ …» is the
   * desktop's own label for an unnamed قياس.
   */
  async createMeasurement(tenantId: string, input: MeasurementInput, userId?: string): Promise<MeasurementRow> {
    await this.ensureEnabled(tenantId);
    if (!input.partyId)
      throw new DomainError('TAILORING_MEASUREMENT_CUSTOMER_REQUIRED', 'الرجاء البحث عن عميل أولًا', 422);
    if (input.name !== undefined && !String(input.name).trim())
      throw new DomainError('TAILORING_MEASUREMENT_NAME_REQUIRED', 'الرجاء إدخال اسم صاحب القياس', 422);

    const attributes = await this.loadAttributes(tenantId, { activeOnly: false });
    const values = await this.valuesOrThrow(tenantId, attributes, input);
    const [row] = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const customer = await tx
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.id, input.partyId), isNull(parties.deletedAt)))
        .limit(1);
      if (!customer.length) throw new DomainError('PARTY_NOT_FOUND', 'العميل غير موجود', 404);
      return tx
        .insert(customerMeasurements)
        .values({
          id: newId(),
          tenantId,
          partyId: input.partyId,
          kind: input.kind ?? 'tailoring',
          name: input.name ? String(input.name).trim() : null,
          measurementDate: input.measurementDate && isISODate(input.measurementDate) ? input.measurementDate : todayISO(),
          measurements: values,
          notes: input.notes ?? null,
          active: input.active ?? true,
          createdBy: userId ?? null,
        })
        .returning();
    });
    return this.getMeasurement(tenantId, row!.id);
  }

  /** «✏️ تعديل القياس» — the desktop DELETEs every value then re-inserts those > 0. */
  async updateMeasurement(tenantId: string, id: string, patch: MeasurementPatch, userId?: string): Promise<MeasurementRow> {
    await this.ensureEnabled(tenantId);
    if (patch.name !== undefined && !String(patch.name).trim())
      throw new DomainError('TAILORING_MEASUREMENT_NAME_REQUIRED', 'الرجاء إدخال اسم صاحب القياس', 422);

    const attributes = await this.loadAttributes(tenantId, { activeOnly: false });
    const current = await this.rawMeasurement(tenantId, id);
    const values = patch.values || patch.measurements ? await this.valuesOrThrow(tenantId, attributes, patch) : current.measurements;
    if (patch.values && !Object.keys(values).length)
      throw new DomainError('TAILORING_MEASUREMENT_VALUE_REQUIRED', 'الرجاء إدخال قياس واحد على الأقل', 422);

    const updated = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(customerMeasurements)
        .set({
          kind: patch.kind ?? current.kind,
          name: patch.name !== undefined ? (String(patch.name).trim() || null) : current.name,
          measurementDate:
            patch.measurementDate && isISODate(patch.measurementDate) ? patch.measurementDate : current.measurementDate,
          measurements: values,
          notes: patch.notes !== undefined ? patch.notes : current.notes,
          active: patch.active ?? current.active,
          updatedAt: new Date(),
          updatedBy: userId ?? null,
          version: sql`${customerMeasurements.version} + 1`,
        })
        .where(
          and(
            eq(customerMeasurements.tenantId, tenantId),
            eq(customerMeasurements.id, id),
            isNull(customerMeasurements.deletedAt),
            patch.version === undefined ? undefined : eq(customerMeasurements.version, patch.version),
          ),
        )
        .returning({ id: customerMeasurements.id }),
    );
    if (!updated.length) throw new DomainError('VERSION_CONFLICT', 'تم تعديل هذا السجل من مكان آخر', 409);
    return this.getMeasurement(tenantId, id);
  }

  /** «🗑️ حذف القياس» — `sp_DeleteMeasurement` hides the قياس; a طلب that used it keeps its number. */
  async deleteMeasurement(tenantId: string, id: string, userId?: string): Promise<{ deleted: true; id: string }> {
    await this.ensureEnabled(tenantId);
    await this.rawMeasurement(tenantId, id);
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(customerMeasurements)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null, active: false, updatedAt: new Date(), updatedBy: userId ?? null })
        .where(and(eq(customerMeasurements.tenantId, tenantId), eq(customerMeasurements.id, id), isNull(customerMeasurements.deletedAt))),
    );
    return { deleted: true, id };
  }

  // ─────────────────────────────── 📏 خصائص القياسات ───────────────────────────────

  /**
   * `frmMeasurementAttributes.LoadData` —
   * `SELECT AttributeID, AttributeName, DisplayOrder, CASE WHEN IsActive = 1 THEN 'نشط'
   * ELSE 'معطل' END AS StatusText FROM MeasurementAttributes ORDER BY DisplayOrder`.
   */
  async listAttributes(tenantId: string, options: { activeOnly?: boolean } = {}): Promise<{ data: AttributeRow[] }> {
    await this.ensureEnabled(tenantId);
    return { data: await this.loadAttributes(tenantId, options) };
  }

  /** «➕ إضافة» — `ISNULL(MAX(DisplayOrder), 0) + 1`, then reload ordered by الترتيب. */
  async createAttribute(tenantId: string, input: AttributeInput, userId?: string): Promise<AttributeRow> {
    await this.ensureEnabled(tenantId);
    const nameAr = String(input.nameAr ?? '').trim();
    if (!nameAr) throw new DomainError('TAILORING_ATTRIBUTE_NAME_REQUIRED', 'الرجاء إدخال اسم الخاصية', 422);

    const rows = await this.loadAttributes(tenantId, { activeOnly: false });
    if (rows.some((row) => row.nameAr === nameAr))
      throw new DomainError('TAILORING_ATTRIBUTE_NAME_TAKEN', 'اسم الخاصية موجود مسبقاً', 409);
    const nextOrder = rows.reduce((max, row) => Math.max(max, row.displayOrder), 0) + 1;
    try {
      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx.insert(tailoringMeasurementAttributes).values({
          id: newId(),
          tenantId,
          nameAr,
          displayOrder: nextOrder,
          active: true,
          createdBy: userId ?? null,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('TAILORING_ATTRIBUTE_NAME_TAKEN', 'اسم الخاصية موجود مسبقاً', 409);
      throw error;
    }
    const created = await this.loadAttributes(tenantId, { activeOnly: false });
    return created.find((row) => row.nameAr === nameAr)!;
  }

  /**
   * «✏️ تعديل» — a rename, and the way back from «🔕 تعطيل»: the desktop only ever sets
   * `IsActive = 0` and has no activate button of its own.
   */
  async updateAttribute(tenantId: string, id: string, patch: AttributePatch, userId?: string): Promise<AttributeRow> {
    await this.ensureEnabled(tenantId);
    const current = await this.rawAttribute(tenantId, id);
    const nameAr = patch.nameAr === undefined ? current.nameAr : String(patch.nameAr).trim();
    if (!nameAr) throw new DomainError('TAILORING_ATTRIBUTE_NAME_REQUIRED', 'الرجاء إدخال اسم الخاصية', 422);
    if (nameAr !== current.nameAr) {
      const rows = await this.loadAttributes(tenantId, { activeOnly: false });
      if (rows.some((row) => row.nameAr === nameAr))
        throw new DomainError('TAILORING_ATTRIBUTE_NAME_TAKEN', 'اسم الخاصية موجود مسبقاً', 409);
    }
    try {
      const updated = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(tailoringMeasurementAttributes)
          .set({
            nameAr,
            active: patch.active ?? current.active,
            updatedAt: new Date(),
            updatedBy: userId ?? null,
            version: sql`${tailoringMeasurementAttributes.version} + 1`,
          })
          .where(
            and(
              eq(tailoringMeasurementAttributes.tenantId, tenantId),
              eq(tailoringMeasurementAttributes.id, id),
              isNull(tailoringMeasurementAttributes.deletedAt),
              patch.version === undefined ? undefined : eq(tailoringMeasurementAttributes.version, patch.version),
            ),
          )
          .returning({ id: tailoringMeasurementAttributes.id }),
      );
      if (!updated.length) throw new DomainError('VERSION_CONFLICT', 'تم تعديل هذا السجل من مكان آخر', 409);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('TAILORING_ATTRIBUTE_NAME_TAKEN', 'اسم الخاصية موجود مسبقاً', 409);
      throw error;
    }
    const rows = await this.loadAttributes(tenantId, { activeOnly: false });
    const updated = rows.find((row) => row.id === id);
    if (!updated) throw new DomainError('TAILORING_ATTRIBUTE_NOT_FOUND', 'الخاصية غير موجودة', 404);
    return updated;
  }

  /** «🔕 تعطيل» — `UPDATE … SET IsActive=0`: «سيتم إخفاؤها من القياسات الجديدة». */
  async deactivateAttribute(tenantId: string, id: string, userId?: string): Promise<AttributeRow> {
    return this.updateAttribute(tenantId, id, { active: false }, userId);
  }

  /**
   * «▲ تحريك للأعلى» و«▼ تحريك للأسفل» — the desktop swaps `DisplayOrder` with the
   * neighbour (`WHERE DisplayOrder IN (@Current, @Prev)`) and re-selects the row by id.
   * At either end there is no neighbour and it quietly does nothing.
   */
  async moveAttribute(tenantId: string, id: string, direction: 'up' | 'down', userId?: string): Promise<AttributeRow> {
    await this.ensureEnabled(tenantId);
    const current = await this.rawAttribute(tenantId, id);
    const rows = await this.loadAttributes(tenantId, { activeOnly: false });
    const index = rows.findIndex((row) => row.id === id);
    const neighbour = direction === 'up' ? rows[index - 1] : rows[index + 1];
    if (!neighbour) return rows[index]!;

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx
        .update(tailoringMeasurementAttributes)
        .set({ displayOrder: neighbour.displayOrder, updatedAt: new Date(), updatedBy: userId ?? null })
        .where(and(eq(tailoringMeasurementAttributes.tenantId, tenantId), eq(tailoringMeasurementAttributes.id, current.id)));
      await tx
        .update(tailoringMeasurementAttributes)
        .set({ displayOrder: current.displayOrder, updatedAt: new Date(), updatedBy: userId ?? null })
        .where(and(eq(tailoringMeasurementAttributes.tenantId, tenantId), eq(tailoringMeasurementAttributes.id, neighbour.id)));
    });
    const moved = await this.loadAttributes(tenantId, { activeOnly: false });
    return moved.find((row) => row.id === id)!;
  }

  private async loadAttributes(tenantId: string, options: { activeOnly?: boolean }): Promise<AttributeRow[]> {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tailoringMeasurementAttributes)
        .where(
          and(
            eq(tailoringMeasurementAttributes.tenantId, tenantId),
            isNull(tailoringMeasurementAttributes.deletedAt),
            options.activeOnly ? eq(tailoringMeasurementAttributes.active, true) : undefined,
          ),
        )
        .orderBy(asc(tailoringMeasurementAttributes.displayOrder), asc(tailoringMeasurementAttributes.nameAr)),
    );
    return rows.map((row) => ({
      id: row.id,
      nameAr: row.nameAr,
      displayOrder: row.displayOrder,
      active: row.active,
      // ⚙️ الحالة — `CASE WHEN IsActive = 1 THEN 'نشط' ELSE 'معطل' END`.
      statusText: row.active ? 'نشط' : 'معطل',
      version: row.version,
    }));
  }

  private async rawAttribute(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tailoringMeasurementAttributes)
        .where(
          and(
            eq(tailoringMeasurementAttributes.tenantId, tenantId),
            eq(tailoringMeasurementAttributes.id, id),
            isNull(tailoringMeasurementAttributes.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!row) throw new DomainError('TAILORING_ATTRIBUTE_NOT_FOUND', 'الخاصية غير موجودة', 404);
    return row;
  }

  private async rawMeasurement(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(customerMeasurements)
        .where(and(eq(customerMeasurements.tenantId, tenantId), eq(customerMeasurements.id, id), isNull(customerMeasurements.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('TAILORING_MEASUREMENT_NOT_FOUND', 'القياس غير موجود', 404);
    return row;
  }

  /** `SELECT TOP 10 … ORDER BY name`, then the first row (`SearchCustomer`). */
  private async firstCustomerByKeyword(tenantId: string, keyword: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: parties.id, name: parties.name, phone: parties.phone })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.kind, 'customer'), isNull(parties.deletedAt), this.customerSearch(keyword)))
        .orderBy(asc(parties.name))
        .limit(1),
    );
    return row ? { id: row.id, name: row.name, phone: row.phone ?? '' } : null;
  }

  /** `mobile LIKE @Search OR name LIKE @Search` — one box, two columns. */
  private customerSearch(keyword: string): SQL | undefined {
    const like = `%${keyword}%`;
    return or(ilike(parties.phone, like), ilike(parties.name, like));
  }

  private async measurementsOf(tenantId: string, partyId: string): Promise<MeasurementRow[]> {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ measurement: customerMeasurements, customerName: parties.name, customerPhone: parties.phone })
        .from(customerMeasurements)
        .innerJoin(parties, eq(parties.id, customerMeasurements.partyId))
        .where(and(eq(customerMeasurements.tenantId, tenantId), eq(customerMeasurements.partyId, partyId), isNull(customerMeasurements.deletedAt)))
        .orderBy(desc(customerMeasurements.measurementDate), desc(customerMeasurements.createdAt)),
    );
    return this.shapeMeasurements(tenantId, rows);
  }

  private async shapeMeasurements(
    tenantId: string,
    rows: Array<{ measurement: typeof customerMeasurements.$inferSelect; customerName: string; customerPhone: string | null }>,
  ): Promise<MeasurementRow[]> {
    const attributes = await this.loadAttributes(tenantId, { activeOnly: false });
    const byId = new Map(attributes.map((attribute) => [attribute.id, attribute]));
    return rows.map(({ measurement, customerName, customerPhone }) => {
      const values: MeasurementValueRow[] = [];
      for (const [key, value] of Object.entries(measurement.measurements ?? {})) {
        const attribute = byId.get(key);
        if (!attribute) continue;
        values.push({ attributeId: attribute.id, attributeName: attribute.nameAr, value, displayOrder: attribute.displayOrder });
      }
      values.sort((left, right) => left.displayOrder - right.displayOrder);
      const date = measurement.measurementDate ?? measurement.createdAt.toISOString().slice(0, 10);
      return {
        id: measurement.id,
        partyId: measurement.partyId,
        customerName,
        customerPhone: customerPhone ?? '',
        kind: measurement.kind,
        name: measurement.name,
        // `frmOrderDetails.LoadCustomerMeasurements` L259 — «قياس بتاريخ …» when unnamed.
        displayName: measurement.name ?? `قياس بتاريخ ${date}`,
        measurementDate: date,
        notes: measurement.notes,
        active: measurement.active,
        // 📐 عدد المقاسات — `SELECT COUNT(*) FROM MeasurementValues WHERE MeasurementID=…`,
        // and only values greater than zero are ever written.
        measurementCount: values.filter((row) => decimal(row.value) > 0).length ||
          Object.values(measurement.measurements ?? {}).filter((value) => decimal(value) > 0).length,
        values,
        measurements: measurement.measurements ?? {},
        createdAt: measurement.createdAt.toISOString(),
        version: measurement.version,
      };
    });
  }

  /** The card's values, keyed by attribute id; anything not > 0 is not written. */
  private async valuesOrThrow(
    tenantId: string,
    attributes: AttributeRow[],
    input: { values?: Array<{ attributeId: string; value: string | number }>; measurements?: Record<string, string> },
  ): Promise<Record<string, string>> {
    const merged: Record<string, string> = { ...(input.measurements ?? {}) };
    if (!input.values) {
      if (input.measurements && !Object.keys(merged).length)
        throw new DomainError('TAILORING_MEASUREMENT_VALUE_REQUIRED', 'الرجاء إدخال قياس واحد على الأقل', 422);
      return merged;
    }
    for (const entry of input.values) {
      const attribute = attributes.find((row) => row.id === entry.attributeId);
      if (!attribute) throw new DomainError('TAILORING_ATTRIBUTE_NOT_FOUND', 'الخاصية غير موجودة', 404);
      if (decimal(entry.value) > 0) merged[attribute.id] = String(entry.value);
      else delete merged[attribute.id];
    }
    if (!Object.keys(merged).length)
      throw new DomainError('TAILORING_MEASUREMENT_VALUE_REQUIRED', 'الرجاء إدخال قياس واحد على الأقل', 422);
    return merged;
  }

  /**
   * `frmOrders.LoadStatusFilter` L54 —
   * `SELECT StatusID, StatusName FROM OrderStatus WHERE IsActive=1 ORDER BY DisplayOrder`,
   * with «الكل» (StatusID 0) prepended in the UI rather than in the data.
   */
  async listStatuses(tenantId: string, options: { activeOnly?: boolean } = {}): Promise<{ data: StatusRow[] }> {
    await this.ensureEnabled(tenantId);
    const activeOnly = options.activeOnly ?? true;
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tailoringOrderStatuses)
        .where(
          and(
            eq(tailoringOrderStatuses.tenantId, tenantId),
            isNull(tailoringOrderStatuses.deletedAt),
            ...(activeOnly ? [eq(tailoringOrderStatuses.active, true)] : []),
          ),
        )
        .orderBy(asc(tailoringOrderStatuses.displayOrder), asc(tailoringOrderStatuses.nameAr)),
    );
    return {
      data: rows.map((row) => ({
        id: row.id,
        code: row.code,
        nameAr: row.nameAr,
        displayOrder: row.displayOrder,
        isFinal: row.isFinal,
        active: row.active,
      })),
    };
  }

  private async statusOrThrow(tenantId: string, statusId: string | undefined | null): Promise<StatusRow> {
    if (!statusId) {
      const statuses = await this.listStatuses(tenantId);
      const [first] = statuses.data;
      if (!first) throw new DomainError('TAILORING_STATUS_NOT_FOUND', 'لا توجد حالات للطلبات', 404);
      return first;
    }
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tailoringOrderStatuses)
        .where(
          and(
            eq(tailoringOrderStatuses.tenantId, tenantId),
            eq(tailoringOrderStatuses.id, statusId),
            isNull(tailoringOrderStatuses.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!row) throw new DomainError('TAILORING_STATUS_NOT_FOUND', 'حالة الطلب غير موجودة', 404);
    return {
      id: row.id,
      code: row.code,
      nameAr: row.nameAr,
      displayOrder: row.displayOrder,
      isFinal: row.isFinal,
      active: row.active,
    };
  }

  // ─────────────────────────────── 🧵 أنواع التفصيل ───────────────────────────────

  /**
   * `frmOrderDetails.LoadTypes` L60 —
   * `SELECT TypeID, TypeName, DefaultPrice FROM TailoringTypes WHERE IsActive=1 ORDER BY TypeName`.
   * No desktop screen edits أنواع التفصيل (the table is seeded by the DBA), but a طلب
   * cannot be saved without one, so the cloud exposes the CRUD the desktop leaves to SQL.
   */
  async listTypes(tenantId: string, options: { activeOnly?: boolean } = {}): Promise<{ data: TypeRow[] }> {
    await this.ensureEnabled(tenantId);
    const activeOnly = options.activeOnly ?? true;
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tailoringTypes)
        .where(
          and(
            eq(tailoringTypes.tenantId, tenantId),
            isNull(tailoringTypes.deletedAt),
            ...(activeOnly ? [eq(tailoringTypes.active, true)] : []),
          ),
        )
        .orderBy(asc(tailoringTypes.nameAr)),
    );
    return { data: rows.map((row) => this.toTypeRow(row)) };
  }

  private toTypeRow(row: typeof tailoringTypes.$inferSelect): TypeRow {
    return { id: row.id, code: row.code, nameAr: row.nameAr, defaultPrice: row.defaultPrice, active: row.active };
  }

  async createType(tenantId: string, input: TypeInput, userId?: string): Promise<TypeRow> {
    await this.ensureEnabled(tenantId);
    const nameAr = (input.nameAr ?? '').trim();
    if (!nameAr) throw new DomainError('TAILORING_TYPE_NAME_REQUIRED', 'الرجاء إدخال نوع التفصيل', 422);
    try {
      const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .insert(tailoringTypes)
          .values({
            id: newId(),
            tenantId,
            code: input.code?.trim() || null,
            nameAr,
            defaultPrice: four(decimal(input.defaultPrice)),
            createdBy: userId ?? null,
          })
          .returning(),
      );
      return this.toTypeRow(row!);
    } catch (error) {
      throw this.typeConflict(error);
    }
  }

  async updateType(tenantId: string, id: string, patch: TypePatch, userId?: string): Promise<TypeRow> {
    await this.ensureEnabled(tenantId);
    const values: Partial<typeof tailoringTypes.$inferInsert> = { updatedAt: new Date(), updatedBy: userId ?? null };
    if (patch.nameAr !== undefined) {
      const nameAr = patch.nameAr.trim();
      if (!nameAr) throw new DomainError('TAILORING_TYPE_NAME_REQUIRED', 'الرجاء إدخال نوع التفصيل', 422);
      values.nameAr = nameAr;
    }
    if (patch.code !== undefined) values.code = patch.code?.trim() || null;
    if (patch.defaultPrice !== undefined) values.defaultPrice = four(decimal(patch.defaultPrice));
    if (patch.active !== undefined) values.active = patch.active;
    try {
      const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(tailoringTypes)
          .set(values)
          .where(and(eq(tailoringTypes.tenantId, tenantId), eq(tailoringTypes.id, id), isNull(tailoringTypes.deletedAt)))
          .returning(),
      );
      if (!row) throw new DomainError('TAILORING_TYPE_NOT_FOUND', 'نوع التفصيل غير موجود', 404);
      return this.toTypeRow(row!);
    } catch (error) {
      throw this.typeConflict(error);
    }
  }

  async deleteType(tenantId: string, id: string, userId?: string): Promise<{ deleted: true }> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(tailoringTypes)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null, active: false })
        .where(and(eq(tailoringTypes.tenantId, tenantId), eq(tailoringTypes.id, id), isNull(tailoringTypes.deletedAt)))
        .returning({ id: tailoringTypes.id }),
    );
    if (!row) throw new DomainError('TAILORING_TYPE_NOT_FOUND', 'نوع التفصيل غير موجود', 404);
    return { deleted: true };
  }

  /**
   * The index is the authority — the pre-check can pass under concurrency and the insert
   * still lose, and the operator deserves the same sentence either way.
   */
  private typeConflict(error: unknown): unknown {
    if (isUniqueViolation(error, 'tailoring_types_tenant_name_key'))
      return new DomainError('TAILORING_TYPE_NAME_TAKEN', 'نوع التفصيل موجود مسبقاً', 409);
    if (isUniqueViolation(error, 'tailoring_types_tenant_code_key'))
      return new DomainError('TAILORING_TYPE_CODE_TAKEN', 'رمز نوع التفصيل موجود مسبقاً', 409);
    return error;
  }

  // ─────────────────────────────── 🔧 الخيارات الجاهزة ───────────────────────────────

  /** `frmOptions.xaml.cs` L49 and L81 — categories with their values, both `ORDER BY DisplayOrder`. */
  async listOptionCategories(tenantId: string, options: { activeOnly?: boolean } = {}): Promise<{ data: CategoryRow[] }> {
    await this.ensureEnabled(tenantId);
    const activeOnly = options.activeOnly ?? true;
    return {
      data: await withTenantTx(this.database.db, tenantId, async (tx) => {
        const categories = await tx
          .select()
          .from(tailoringOptionCategories)
          .where(
            and(
              eq(tailoringOptionCategories.tenantId, tenantId),
              isNull(tailoringOptionCategories.deletedAt),
              ...(activeOnly ? [eq(tailoringOptionCategories.active, true)] : []),
            ),
          )
          .orderBy(asc(tailoringOptionCategories.displayOrder), asc(tailoringOptionCategories.nameAr));
        const values = await tx
          .select()
          .from(tailoringOptionValues)
          .where(
            and(
              eq(tailoringOptionValues.tenantId, tenantId),
              isNull(tailoringOptionValues.deletedAt),
              ...(activeOnly ? [eq(tailoringOptionValues.active, true)] : []),
            ),
          )
          .orderBy(asc(tailoringOptionValues.displayOrder), asc(tailoringOptionValues.nameAr));
        return categories.map((category) => ({
          id: category.id,
          nameAr: category.nameAr,
          displayOrder: category.displayOrder,
          active: category.active,
          values: values
            .filter((value) => value.categoryId === category.id)
            .map((value) => ({
              id: value.id,
              nameAr: value.nameAr,
              displayOrder: value.displayOrder,
              isDefault: value.isDefault,
              active: value.active,
            })),
        }));
      }),
    };
  }

  async createOptionCategory(tenantId: string, input: CategoryInput, userId?: string): Promise<{ id: string; nameAr: string; displayOrder: number }> {
    await this.ensureEnabled(tenantId);
    const nameAr = (input.nameAr ?? '').trim();
    if (!nameAr) throw new DomainError('TAILORING_CATEGORY_NAME_REQUIRED', 'الرجاء إدخال اسم التصنيف', 422);
    // `frmOptions.xaml.cs` L136 — `ISNULL(MAX(DisplayOrder),0)+1`
    const [last] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ displayOrder: tailoringOptionCategories.displayOrder })
        .from(tailoringOptionCategories)
        .where(eq(tailoringOptionCategories.tenantId, tenantId))
        .orderBy(desc(tailoringOptionCategories.displayOrder))
        .limit(1),
    );
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(tailoringOptionCategories)
        .values({
          id: newId(),
          tenantId,
          nameAr,
          displayOrder: input.displayOrder ?? (last?.displayOrder ?? 0) + 1,
          createdBy: userId ?? null,
        })
        .returning(),
    );
    return { id: row!.id, nameAr: row!.nameAr, displayOrder: row!.displayOrder };
  }

  async updateOptionCategory(
    tenantId: string,
    id: string,
    patch: { nameAr?: string; displayOrder?: number; active?: boolean },
    userId?: string,
  ): Promise<{ id: string; nameAr: string; displayOrder: number }> {
    await this.ensureEnabled(tenantId);
    if (patch.nameAr !== undefined && !patch.nameAr.trim())
      throw new DomainError('TAILORING_CATEGORY_NAME_REQUIRED', 'الرجاء إدخال اسم التصنيف', 422);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(tailoringOptionCategories)
        .set({
          ...(patch.nameAr === undefined ? {} : { nameAr: patch.nameAr.trim() }),
          ...(patch.displayOrder === undefined ? {} : { displayOrder: patch.displayOrder }),
          ...(patch.active === undefined ? {} : { active: patch.active }),
          updatedAt: new Date(),
          updatedBy: userId ?? null,
        })
        .where(
          and(
            eq(tailoringOptionCategories.tenantId, tenantId),
            eq(tailoringOptionCategories.id, id),
            isNull(tailoringOptionCategories.deletedAt),
          ),
        )
        .returning(),
    );
    if (!row) throw new DomainError('TAILORING_CATEGORY_NOT_FOUND', 'التصنيف غير موجود', 404);
    return { id: row.id, nameAr: row.nameAr, displayOrder: row.displayOrder };
  }

  /** `frmOptions.xaml.cs` L198 — `UPDATE OptionCategories SET IsActive=0`, after «هل أنت متأكد من حذف هذا التصنيف وجميع خياراته؟». */
  async deleteOptionCategory(tenantId: string, id: string, userId?: string): Promise<{ deleted: true }> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(tailoringOptionCategories)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null, active: false })
        .where(
          and(
            eq(tailoringOptionCategories.tenantId, tenantId),
            eq(tailoringOptionCategories.id, id),
            isNull(tailoringOptionCategories.deletedAt),
          ),
        )
        .returning({ id: tailoringOptionCategories.id }),
    );
    if (!row) throw new DomainError('TAILORING_CATEGORY_NOT_FOUND', 'التصنيف غير موجود', 404);
    return { deleted: true };
  }

  async createOptionValue(tenantId: string, input: ValueInput, userId?: string): Promise<{ id: string; nameAr: string; isDefault: boolean }> {
    await this.ensureEnabled(tenantId);
    const nameAr = (input.nameAr ?? '').trim();
    if (!nameAr) throw new DomainError('TAILORING_VALUE_NAME_REQUIRED', 'الرجاء إدخال اسم الخيار', 422);
    await this.categoryOrThrow(tenantId, input.categoryId);
    const [last] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ displayOrder: tailoringOptionValues.displayOrder })
        .from(tailoringOptionValues)
        .where(and(eq(tailoringOptionValues.tenantId, tenantId), eq(tailoringOptionValues.categoryId, input.categoryId)))
        .orderBy(desc(tailoringOptionValues.displayOrder))
        .limit(1),
    );
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(tailoringOptionValues)
        .values({
          id: newId(),
          tenantId,
          categoryId: input.categoryId,
          nameAr,
          isDefault: input.isDefault ?? false,
          displayOrder: input.displayOrder ?? (last?.displayOrder ?? 0) + 1,
          createdBy: userId ?? null,
        })
        .returning(),
    );
    return { id: row!.id, nameAr: row!.nameAr, isDefault: row!.isDefault };
  }

  async updateOptionValue(
    tenantId: string,
    id: string,
    patch: { nameAr?: string; displayOrder?: number; isDefault?: boolean; active?: boolean },
    userId?: string,
  ): Promise<{ id: string; nameAr: string; isDefault: boolean }> {
    await this.ensureEnabled(tenantId);
    if (patch.nameAr !== undefined && !patch.nameAr.trim())
      throw new DomainError('TAILORING_VALUE_NAME_REQUIRED', 'الرجاء إدخال اسم الخيار', 422);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(tailoringOptionValues)
        .set({
          ...(patch.nameAr === undefined ? {} : { nameAr: patch.nameAr.trim() }),
          ...(patch.displayOrder === undefined ? {} : { displayOrder: patch.displayOrder }),
          ...(patch.isDefault === undefined ? {} : { isDefault: patch.isDefault }),
          ...(patch.active === undefined ? {} : { active: patch.active }),
          updatedAt: new Date(),
          updatedBy: userId ?? null,
        })
        .where(and(eq(tailoringOptionValues.tenantId, tenantId), eq(tailoringOptionValues.id, id), isNull(tailoringOptionValues.deletedAt)))
        .returning(),
    );
    if (!row) throw new DomainError('TAILORING_VALUE_NOT_FOUND', 'الخيار غير موجود', 404);
    return { id: row.id, nameAr: row.nameAr, isDefault: row.isDefault };
  }

  /** «هل أنت متأكد من حذف هذا الخيار؟» — `UPDATE OptionValues SET IsActive=0` (`frmOptions.xaml.cs` L298). */
  async deleteOptionValue(tenantId: string, id: string, userId?: string): Promise<{ deleted: true }> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(tailoringOptionValues)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null, active: false })
        .where(and(eq(tailoringOptionValues.tenantId, tenantId), eq(tailoringOptionValues.id, id), isNull(tailoringOptionValues.deletedAt)))
        .returning({ id: tailoringOptionValues.id }),
    );
    if (!row) throw new DomainError('TAILORING_VALUE_NOT_FOUND', 'الخيار غير موجود', 404);
    return { deleted: true };
  }

  /** ⭐ تعيين افتراضي — `UPDATE OptionValues SET IsDefault=0 WHERE CategoryID=@CatID` then `SET IsDefault=1` (L323/L330). */
  async setDefaultOptionValue(tenantId: string, id: string, userId?: string): Promise<{ id: string; isDefault: boolean }> {
    await this.ensureEnabled(tenantId);
    const [current] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tailoringOptionValues)
        .where(and(eq(tailoringOptionValues.tenantId, tenantId), eq(tailoringOptionValues.id, id), isNull(tailoringOptionValues.deletedAt)))
        .limit(1),
    );
    if (!current) throw new DomainError('TAILORING_VALUE_NOT_FOUND', 'الخيار غير موجود', 404);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx
        .update(tailoringOptionValues)
        .set({ isDefault: false, updatedAt: new Date(), updatedBy: userId ?? null })
        .where(
          and(
            eq(tailoringOptionValues.tenantId, tenantId),
            eq(tailoringOptionValues.categoryId, current.categoryId),
            isNull(tailoringOptionValues.deletedAt),
          ),
        );
      await tx
        .update(tailoringOptionValues)
        .set({ isDefault: true, updatedAt: new Date(), updatedBy: userId ?? null })
        .where(and(eq(tailoringOptionValues.tenantId, tenantId), eq(tailoringOptionValues.id, id)));
    });
    return { id, isDefault: true };
  }

  private async categoryOrThrow(tenantId: string, categoryId: string | undefined | null) {
    if (!categoryId) throw new DomainError('TAILORING_CATEGORY_NOT_FOUND', 'التصنيف غير موجود', 404);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tailoringOptionCategories)
        .where(
          and(
            eq(tailoringOptionCategories.tenantId, tenantId),
            eq(tailoringOptionCategories.id, categoryId),
            isNull(tailoringOptionCategories.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!row) throw new DomainError('TAILORING_CATEGORY_NOT_FOUND', 'التصنيف غير موجود', 404);
    return row;
  }

  // ─────────────────────────────── 🧾 الطلبات ───────────────────────────────

  /**
   * `frmOrders.LoadOrders` L73 — the grid «📋 قائمة الطلبات» with
   * `رقم الطلب · 👤 العميل · 📞 الجوال · القياس · نوع التفصيل · ⚙️ الحالة ·
   * 📅 تاريخ الطلب · 📅 موعد التسليم · 💰 السعر · 💵 المدفوع · ⌛ المتبقي`.
   */
  async listOrders(tenantId: string, query: OrderQuery = {}): Promise<{ data: OrderRow[]; meta: { total: number } }> {
    await this.ensureEnabled(tenantId);
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);
    const filters: SQL[] = [eq(tailoringOrders.tenantId, tenantId), isNull(tailoringOrders.deletedAt)];
    if (query.statusId) filters.push(eq(tailoringOrders.statusId, query.statusId));
    if (query.partyId) filters.push(eq(tailoringOrders.partyId, query.partyId));
    if (query.typeId) filters.push(eq(tailoringOrders.typeId, query.typeId));
    if (query.from) filters.push(gte(tailoringOrders.orderDate, query.from));
    if (query.to) filters.push(lte(tailoringOrders.orderDate, query.to));
    const search = query.search?.trim();
    const searchFilter = search
      ? or(ilike(tailoringOrders.number, `%${search}%`), ilike(parties.name, `%${search}%`))
      : undefined;
    if (searchFilter) filters.push(searchFilter);
    const where = and(...filters);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          order: tailoringOrders,
          customerName: parties.name,
          customerPhone: parties.phone,
          typeName: tailoringTypes.nameAr,
          statusName: tailoringOrderStatuses.nameAr,
          statusFinal: tailoringOrderStatuses.isFinal,
        })
        .from(tailoringOrders)
        .innerJoin(parties, eq(parties.id, tailoringOrders.partyId))
        .innerJoin(tailoringTypes, eq(tailoringTypes.id, tailoringOrders.typeId))
        .innerJoin(tailoringOrderStatuses, eq(tailoringOrderStatuses.id, tailoringOrders.statusId))
        .where(where)
        .orderBy(desc(tailoringOrders.orderDate), desc(tailoringOrders.number))
        .limit(limit)
        .offset(offset),
    );
    const data = await this.withMeasurementNames(tenantId, rows);
    const [counted] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ total: count() })
        .from(tailoringOrders)
        .innerJoin(parties, eq(parties.id, tailoringOrders.partyId))
        .where(where),
    );
    return { data, meta: { total: Number(counted?.total ?? 0) } };
  }

  private async withMeasurementNames(
    tenantId: string,
    rows: Array<{
      order: typeof tailoringOrders.$inferSelect;
      customerName: string;
      customerPhone: string | null;
      typeName: string;
      statusName: string;
      statusFinal: boolean;
    }>,
  ): Promise<OrderRow[]> {
    const measurementIds = rows.map((row) => row.order.measurementId).filter((id): id is string => Boolean(id));
    const names = new Map<string, string>();
    if (measurementIds.length) {
      const measurements = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .select({ id: customerMeasurements.id, createdAt: customerMeasurements.createdAt, measurementDate: customerMeasurements.measurementDate, name: customerMeasurements.name })
          .from(customerMeasurements)
          .where(and(eq(customerMeasurements.tenantId, tenantId), isNull(customerMeasurements.deletedAt))),
      );
      for (const measurement of measurements) {
        if (!measurementIds.includes(measurement.id)) continue;
        // `frmOrderDetails.LoadCustomerMeasurements` L259 — the display name falls back to
        // «قياس بتاريخ …» when `MeasurementName` is null.
        const date = (measurement.measurementDate ?? measurement.createdAt.toISOString().slice(0, 10)) as string;
        names.set(measurement.id, measurement.name ?? `قياس بتاريخ ${date}`);
      }
    }
    return rows.map((row) => ({
      id: row.order.id,
      number: row.order.number,
      partyId: row.order.partyId,
      customerName: row.customerName,
      customerPhone: row.customerPhone ?? '',
      measurementId: row.order.measurementId,
      measurementName: names.get(row.order.measurementId ?? '') ?? null,
      typeId: row.order.typeId,
      typeName: row.typeName,
      statusId: row.order.statusId,
      statusName: row.statusName,
      orderDate: row.order.orderDate,
      deliveryDate: row.order.deliveryDate,
      quantity: row.order.quantity,
      price: row.order.price,
      paidAmount: row.order.paidAmount,
      remainingAmount: four(decimal(row.order.price) - decimal(row.order.paidAmount)),
      isDelayed: isDelayedOn(row.order.deliveryDate, row.statusFinal),
      fabricType: row.order.fabricType,
      fabricColor: row.order.fabricColor,
      designNotes: row.order.designNotes,
      generalNotes: row.order.generalNotes,
      version: row.order.version,
      options: [],
    }));
  }

  async getOrder(tenantId: string, id: string): Promise<OrderRow> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          order: tailoringOrders,
          customerName: parties.name,
          customerPhone: parties.phone,
          typeName: tailoringTypes.nameAr,
          statusName: tailoringOrderStatuses.nameAr,
          statusFinal: tailoringOrderStatuses.isFinal,
        })
        .from(tailoringOrders)
        .innerJoin(parties, eq(parties.id, tailoringOrders.partyId))
        .innerJoin(tailoringTypes, eq(tailoringTypes.id, tailoringOrders.typeId))
        .innerJoin(tailoringOrderStatuses, eq(tailoringOrderStatuses.id, tailoringOrders.statusId))
        .where(and(eq(tailoringOrders.tenantId, tenantId), eq(tailoringOrders.id, id), isNull(tailoringOrders.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('TAILORING_ORDER_NOT_FOUND', 'الطلب غير موجود', 404);
    const [shaped] = await this.withMeasurementNames(tenantId, [row]);
    return { ...shaped!, options: await this.readOptions(tenantId, id) };
  }

  private async readOptions(tenantId: string, orderId: string) {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          categoryId: tailoringOrderOptions.categoryId,
          categoryName: tailoringOptionCategories.nameAr,
          valueId: tailoringOrderOptions.valueId,
          valueName: tailoringOptionValues.nameAr,
        })
        .from(tailoringOrderOptions)
        .innerJoin(tailoringOptionCategories, eq(tailoringOptionCategories.id, tailoringOrderOptions.categoryId))
        .innerJoin(tailoringOptionValues, eq(tailoringOptionValues.id, tailoringOrderOptions.valueId))
        .where(and(eq(tailoringOrderOptions.tenantId, tenantId), eq(tailoringOrderOptions.orderId, orderId)))
        .orderBy(asc(tailoringOptionCategories.displayOrder)),
    );
    return rows;
  }

  /** «💾 حفظ الطلب» — `frmOrderDetails.btnSave_Click` L318. */
  async createOrder(tenantId: string, input: OrderInput, userId?: string): Promise<OrderRow> {
    await this.ensureEnabled(tenantId);
    const { partyId, typeId, price: orderPrice, options } = this.validateOrderInput(tenantId, input);
    const status = await this.statusOrThrow(tenantId, input.statusId);
    await this.assertParty(tenantId, partyId);
    await this.assertType(tenantId, typeId);
    await this.assertMeasurement(tenantId, input.measurementId, partyId);
    const orderDate = this.dateOrToday(input.orderDate);
    const id = newId();
    const number = await withTenantTx(this.database.db, tenantId, (tx) =>
      this.sequences.next({ tenantId, docType: 'tailoring_order' }, tx, ORDER_SEQUENCE).then((allocated) => allocated.display),
    );
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.insert(tailoringOrders).values({
        id,
        tenantId,
        number,
        partyId,
        measurementId: input.measurementId ?? null,
        typeId,
        statusId: status.id,
        orderDate,
        deliveryDate: this.dateOrNull(input.deliveryDate),
        quantity: four(decimal(input.quantity, 1)),
        price: four(orderPrice),
        paidAmount: four(decimal(input.paidAmount)),
        fabricType: input.fabricType?.trim() || null,
        fabricColor: input.fabricColor?.trim() || null,
        designNotes: input.designNotes?.trim() || null,
        generalNotes: input.generalNotes?.trim() || null,
        createdBy: userId ?? null,
      });
      await this.writeOptions(tx, tenantId, id, options, userId);
    });
    return this.getOrder(tenantId, id);
  }

  /**
   * `frmOrders.btnEdit_Click` L176 opens `frmOrderDetails`, whose `LoadOrderData` L417 is
   * empty («يمكن تطويرها لاحقًا») and whose save always INSERTs — editing an order on the
   * desktop really does create a second one. The cloud updates the order the user
   * selected instead: that is what «✏️ تعديل» means to the person clicking it.
   */
  async updateOrder(tenantId: string, id: string, patch: OrderPatch, userId?: string): Promise<OrderRow> {
    await this.ensureEnabled(tenantId);
    const [current] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tailoringOrders)
        .where(and(eq(tailoringOrders.tenantId, tenantId), eq(tailoringOrders.id, id), isNull(tailoringOrders.deletedAt)))
        .limit(1),
    );
    if (!current) throw new DomainError('TAILORING_ORDER_NOT_FOUND', 'الطلب غير موجود', 404);
    if (patch.version !== undefined && patch.version !== current.version)
      throw new DomainError('VERSION_CONFLICT', 'تم تعديل الطلب من جهة أخرى', 409);

    const partyId = current.partyId;
    const typeId = patch.typeId ?? current.typeId;
    const orderPrice = patch.price === undefined ? decimal(current.price) : this.priceOrThrow(patch.price);
    if (patch.partyId !== undefined && patch.partyId !== partyId)
      throw new DomainError('TAILORING_CUSTOMER_IMMUTABLE', 'لا يمكن تغيير عميل الطلب', 422);
    await this.assertType(tenantId, typeId);
    const measurementId = patch.measurementId === undefined ? current.measurementId : patch.measurementId;
    await this.assertMeasurement(tenantId, measurementId, partyId);
    const statusId = patch.statusId === undefined ? current.statusId : (await this.statusOrThrow(tenantId, patch.statusId)).id;

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx
        .update(tailoringOrders)
        .set({
          typeId,
          statusId,
          measurementId: measurementId ?? null,
          orderDate: patch.orderDate === undefined ? current.orderDate : this.dateOrToday(patch.orderDate),
          deliveryDate: patch.deliveryDate === undefined ? current.deliveryDate : this.dateOrNull(patch.deliveryDate),
          quantity: four(decimal(patch.quantity ?? current.quantity, 1)),
          price: four(orderPrice),
          paidAmount: four(decimal(patch.paidAmount ?? current.paidAmount)),
          fabricType: patch.fabricType === undefined ? current.fabricType : patch.fabricType?.trim() || null,
          fabricColor: patch.fabricColor === undefined ? current.fabricColor : patch.fabricColor?.trim() || null,
          designNotes: patch.designNotes === undefined ? current.designNotes : patch.designNotes?.trim() || null,
          generalNotes: patch.generalNotes === undefined ? current.generalNotes : patch.generalNotes?.trim() || null,
          updatedAt: new Date(),
          updatedBy: userId ?? null,
          version: current.version + 1,
        })
        .where(and(eq(tailoringOrders.tenantId, tenantId), eq(tailoringOrders.id, id)));
      if (patch.options) await this.writeOptions(tx, tenantId, id, patch.options, userId);
    });
    return this.getOrder(tenantId, id);
  }

  /**
   * `frmOrders.btnChangeStatus_Click` L281 — the «تغيير حالة الطلب» window calls
   * `sp_UpdateOrderStatus @OrderID, @NewStatusID, @ChangedBy`. The procedure's body is not
   * in the repository; what is observable is the reload that follows, so the status is
   * written on the order itself and nothing else is touched.
   */
  async changeStatus(tenantId: string, id: string, statusId: string, userId?: string): Promise<OrderRow> {
    await this.ensureEnabled(tenantId);
    const status = await this.statusOrThrow(tenantId, statusId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(tailoringOrders)
        .set({
          statusId: status.id,
          updatedAt: new Date(),
          updatedBy: userId ?? null,
          version: sql`${tailoringOrders.version} + 1`,
        })
        .where(and(eq(tailoringOrders.tenantId, tenantId), eq(tailoringOrders.id, id), isNull(tailoringOrders.deletedAt)))
        .returning({ id: tailoringOrders.id }),
    );
    if (!row) throw new DomainError('TAILORING_ORDER_NOT_FOUND', 'الطلب غير موجود', 404);
    return this.getOrder(tenantId, id);
  }

  /** «🗑️ حذف» — `DELETE FROM TailoringOrders WHERE OrderID=@ID` (`frmOrders.xaml.cs` L218). */
  async deleteOrder(tenantId: string, id: string, userId?: string): Promise<{ deleted: true }> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(tailoringOrders)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null })
        .where(and(eq(tailoringOrders.tenantId, tenantId), eq(tailoringOrders.id, id), isNull(tailoringOrders.deletedAt)))
        .returning({ id: tailoringOrders.id }),
    );
    if (!row) throw new DomainError('TAILORING_ORDER_NOT_FOUND', 'الطلب غير موجود', 404);
    return { deleted: true };
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private validateOrderInput(tenantId: string, input: OrderInput) {
    const partyId = input.partyId?.trim();
    if (!partyId) throw new DomainError('TAILORING_CUSTOMER_REQUIRED', 'الرجاء اختيار عميل', 422);
    const typeId = input.typeId?.trim();
    if (!typeId) throw new DomainError('TAILORING_TYPE_REQUIRED', 'الرجاء اختيار نوع التفصيل', 422);
    if (input.orderDate && !isISODate(input.orderDate))
      throw new DomainError('TAILORING_DATE_INVALID', 'تاريخ الطلب غير صحيح', 422);
    if (input.deliveryDate && !isISODate(input.deliveryDate))
      throw new DomainError('TAILORING_DATE_INVALID', 'موعد التسليم غير صحيح', 422);
    if (input.quantity !== undefined && decimal(input.quantity, 1) < 0)
      throw new DomainError('TAILORING_QUANTITY_INVALID', 'الكمية غير صحيحة', 422);
    return { partyId, typeId, price: this.priceOrThrow(input.price), options: input.options ?? [] };
  }

  /** «الرجاء إدخال السعر» — the desktop refuses `price <= 0` (`btnSave_Click` L339). */
  private priceOrThrow(value: number | string | undefined): number {
    const parsed = decimal(value);
    if (parsed <= 0) throw new DomainError('TAILORING_PRICE_REQUIRED', 'الرجاء إدخال السعر', 422);
    return parsed;
  }

  private dateOrToday(value: string | undefined): string {
    if (!value) return todayISO();
    return value;
  }

  private dateOrNull(value: string | null | undefined): string | null {
    if (!value) return null;
    return value;
  }

  private async assertParty(tenantId: string, partyId: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId), isNull(parties.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('TAILORING_CUSTOMER_NOT_FOUND', 'العميل غير موجود', 404);
  }

  private async assertType(tenantId: string, typeId: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: tailoringTypes.id })
        .from(tailoringTypes)
        .where(and(eq(tailoringTypes.tenantId, tenantId), eq(tailoringTypes.id, typeId), isNull(tailoringTypes.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('TAILORING_TYPE_NOT_FOUND', 'نوع التفصيل غير موجود', 404);
  }

  /** The القياس must belong to the same عميل — `LoadCustomerMeasurements` L259 filters by `Cust_ID`. */
  private async assertMeasurement(tenantId: string, measurementId: string | null | undefined, partyId: string) {
    if (!measurementId) return;
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: customerMeasurements.id, partyId: customerMeasurements.partyId })
        .from(customerMeasurements)
        .where(
          and(
            eq(customerMeasurements.tenantId, tenantId),
            eq(customerMeasurements.id, measurementId),
            isNull(customerMeasurements.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!row) throw new DomainError('TAILORING_MEASUREMENT_NOT_FOUND', 'القياس غير موجود', 404);
    if (row.partyId !== partyId)
      throw new DomainError('TAILORING_MEASUREMENT_PARTY_MISMATCH', 'القياس لا يتبع هذا العميل', 422);
  }

  private async writeOptions(
    tx: DrizzleTx,
    tenantId: string,
    orderId: string,
    options: OrderOptionInput[],
    userId?: string,
  ) {
    const seen = new Map<string, string>();
    for (const option of options) {
      if (!option?.categoryId || !option?.valueId)
        throw new DomainError('TAILORING_OPTION_INVALID', 'الخيار غير صحيح', 422);
      // `selectedOptions[catId] = valId` — one value per category (`OptionButton_Click` L176).
      seen.set(option.categoryId, option.valueId);
    }
    for (const [categoryId, valueId] of seen) {
      const [value] = await tx
        .select({ id: tailoringOptionValues.id })
        .from(tailoringOptionValues)
        .where(
          and(
            eq(tailoringOptionValues.tenantId, tenantId),
            eq(tailoringOptionValues.id, valueId),
            eq(tailoringOptionValues.categoryId, categoryId),
            isNull(tailoringOptionValues.deletedAt),
          ),
        )
        .limit(1);
      if (!value) throw new DomainError('TAILORING_VALUE_NOT_FOUND', 'الخيار غير موجود', 404);
    }
    await tx.delete(tailoringOrderOptions).where(and(eq(tailoringOrderOptions.tenantId, tenantId), eq(tailoringOrderOptions.orderId, orderId)));
    for (const [categoryId, valueId] of seen) {
      await tx.insert(tailoringOrderOptions).values({
        id: newId(),
        tenantId,
        orderId,
        categoryId,
        valueId,
        createdBy: userId ?? null,
      });
    }
  }

  // ─────────────────────────────── 👔 أنواع الثوب ───────────────────────────────

  /** `typeCB` in `AddNewSizes.xaml` L423 — «👔 نوع الثوب». */
  async listGarmentTypes(tenantId: string): Promise<{ data: GarmentTypeRow[] }> {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tailoringGarmentTypes)
        .where(
          and(
            eq(tailoringGarmentTypes.tenantId, tenantId),
            eq(tailoringGarmentTypes.active, true),
            isNull(tailoringGarmentTypes.deletedAt),
          ),
        )
        .orderBy(asc(tailoringGarmentTypes.displayOrder), asc(tailoringGarmentTypes.nameAr)),
    );
    return {
      data: rows.map((row) => ({
        id: row.id,
        code: row.code,
        nameAr: row.nameAr,
        displayOrder: row.displayOrder,
        active: row.active,
      })),
    };
  }

  // ─────────────────────────────── 🧾 الفواتير ───────────────────────────────

  /**
   * `frmViewOrders.SearchInData` L55 — `Inv_Tailor` filtered by
   * `phone_num LIKE @search OR name LIKE @search`, ordered by `code`.
   */
  async listInvoices(tenantId: string, query: InvoiceQuery = {}): Promise<{ data: InvoiceRow[]; meta: { total: number } }> {
    await this.ensureEnabled(tenantId);
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);
    const filters: SQL[] = [eq(tailoringInvoices.tenantId, tenantId), isNull(tailoringInvoices.deletedAt)];
    if (query.partyId) filters.push(eq(tailoringInvoices.partyId, query.partyId));
    if (query.statusId) filters.push(eq(tailoringInvoices.statusId, query.statusId));
    if (query.from) filters.push(gte(tailoringInvoices.invoiceDate, query.from));
    if (query.to) filters.push(lte(tailoringInvoices.invoiceDate, query.to));
    const search = query.search?.trim();
    if (search) {
      filters.push(
        or(ilike(tailoringInvoices.phone, `%${search}%`), ilike(tailoringInvoices.customerName, `%${search}%`)) as SQL,
      );
    }
    const where = and(...filters);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ invoice: tailoringInvoices, statusName: tailoringOrderStatuses.nameAr, garmentTypeName: tailoringGarmentTypes.nameAr })
        .from(tailoringInvoices)
        .innerJoin(tailoringOrderStatuses, eq(tailoringOrderStatuses.id, tailoringInvoices.statusId))
        .leftJoin(tailoringGarmentTypes, eq(tailoringGarmentTypes.id, tailoringInvoices.garmentTypeId))
        .where(where)
        .orderBy(desc(tailoringInvoices.invoiceDate), desc(tailoringInvoices.number))
        .limit(limit)
        .offset(offset),
    );
    const [counted] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ total: count() }).from(tailoringInvoices).where(where),
    );
    const data: InvoiceRow[] = [];
    for (const row of rows) data.push(await this.shapeInvoice(tenantId, row));
    return { data, meta: { total: Number(counted?.total ?? 0) } };
  }

  /** `👁️ عرض` — `AddNewSizes.showResult(code)` (`frmViewOrders` L156). */
  async getInvoice(tenantId: string, id: string): Promise<InvoiceRow> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ invoice: tailoringInvoices, statusName: tailoringOrderStatuses.nameAr, garmentTypeName: tailoringGarmentTypes.nameAr })
        .from(tailoringInvoices)
        .innerJoin(tailoringOrderStatuses, eq(tailoringOrderStatuses.id, tailoringInvoices.statusId))
        .leftJoin(tailoringGarmentTypes, eq(tailoringGarmentTypes.id, tailoringInvoices.garmentTypeId))
        .where(and(eq(tailoringInvoices.tenantId, tenantId), eq(tailoringInvoices.id, id), isNull(tailoringInvoices.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('TAILORING_INVOICE_NOT_FOUND', 'فاتورة التفصيل غير موجودة', 404);
    return this.shapeInvoice(tenantId, row);
  }

  private async shapeInvoice(
    tenantId: string,
    row: {
      invoice: typeof tailoringInvoices.$inferSelect;
      statusName: string;
      garmentTypeName: string | null;
    },
  ): Promise<InvoiceRow> {
    const payments = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tailoringInvoicePayments)
        .where(and(eq(tailoringInvoicePayments.tenantId, tenantId), eq(tailoringInvoicePayments.invoiceId, row.invoice.id)))
        .orderBy(desc(tailoringInvoicePayments.paidAt), desc(tailoringInvoicePayments.createdAt)),
    );
    const invoiceTotal = decimal(row.invoice.total);
    // 💰 الإجمالي في `frmViewOrders` = sale_price × 1.05 (L88).
    const grossTotal = invoiceTotal + invoiceTotal * TAX_RATE;
    return {
      id: row.invoice.id,
      number: row.invoice.number,
      partyId: row.invoice.partyId,
      customerName: row.invoice.customerName,
      phone: row.invoice.phone,
      invoiceDate: row.invoice.invoiceDate,
      quantity: row.invoice.quantity,
      unitPrice: row.invoice.unitPrice,
      total: row.invoice.total,
      totalWithTax: four(grossTotal),
      paidAmount: row.invoice.paidAmount,
      // ⏳ الباقي = الإجمالي بالضريبة − المدفوع (L90).
      remainingAmount: four(grossTotal - decimal(row.invoice.paidAmount)),
      statusId: row.invoice.statusId,
      statusName: row.statusName,
      garmentTypeId: row.invoice.garmentTypeId,
      garmentTypeName: row.garmentTypeName,
      billed: row.invoice.billed,
      measurements: row.invoice.measurements ?? {},
      notes: row.invoice.notes,
      version: row.invoice.version,
      payments: payments.map((payment) => ({
        id: payment.id,
        amount: payment.amount,
        paidAt: payment.paidAt,
        note: payment.note,
        voucherId: payment.voucherId,
      })),
    };
  }

  /** «💾 حفظ» — `AddNewSizes.btnSave_Click` L191. */
  async createInvoice(tenantId: string, input: InvoiceInput, userId?: string): Promise<InvoiceRow> {
    await this.ensureEnabled(tenantId);
    const customerName = (input.customerName ?? '').trim();
    // «برجاء اختيار العميل» — the desktop's own words for a blank customer (L197).
    if (!customerName) throw new DomainError('TAILORING_INVOICE_CUSTOMER_REQUIRED', 'برجاء اختيار العميل', 422);
    const unitPrice = decimal(input.unitPrice);
    const quantity = decimal(input.quantity, 1);
    // «يرجي إدخال السعر» — the desktop tests الإجمالي against the string "0" (L193).
    if (unitPrice * quantity <= 0) throw new DomainError('TAILORING_INVOICE_PRICE_REQUIRED', 'يرجي إدخال السعر', 422);
    if (quantity < 0) throw new DomainError('TAILORING_QUANTITY_INVALID', 'الكمية غير صحيحة', 422);
    const status = await this.statusOrThrow(tenantId, input.statusId);
    if (input.partyId) await this.assertParty(tenantId, input.partyId);
    if (input.garmentTypeId) await this.assertGarmentType(tenantId, input.garmentTypeId);
    const measurements = this.measurementsOrThrow(input.measurements);
    const id = newId();
    const number = await withTenantTx(this.database.db, tenantId, (tx) =>
      this.sequences.next({ tenantId, docType: 'tailoring_invoice' }, tx, INVOICE_SEQUENCE).then((allocated) => allocated.display),
    );
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.insert(tailoringInvoices).values({
        id,
        tenantId,
        number,
        partyId: input.partyId ?? null,
        customerName,
        phone: input.phone?.trim() || null,
        invoiceDate: input.invoiceDate && isISODate(input.invoiceDate) ? input.invoiceDate : todayISO(),
        quantity: four(quantity),
        unitPrice: four(unitPrice),
        // 💵 الإجمالي = 💰 السعر × 🔢 العدد (`CalculateTotalPrice` L860).
        total: four(unitPrice * quantity),
        statusId: status.id,
        garmentTypeId: input.garmentTypeId ?? null,
        billed: input.billed ?? false,
        measurements,
        notes: input.notes?.trim() || null,
        createdBy: userId ?? null,
      }),
    );
    return this.getInvoice(tenantId, id);
  }

  async updateInvoice(tenantId: string, id: string, patch: InvoicePatch, userId?: string): Promise<InvoiceRow> {
    await this.ensureEnabled(tenantId);
    const [current] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tailoringInvoices)
        .where(and(eq(tailoringInvoices.tenantId, tenantId), eq(tailoringInvoices.id, id), isNull(tailoringInvoices.deletedAt)))
        .limit(1),
    );
    if (!current) throw new DomainError('TAILORING_INVOICE_NOT_FOUND', 'فاتورة التفصيل غير موجودة', 404);
    if (patch.version !== undefined && patch.version !== current.version)
      throw new DomainError('VERSION_CONFLICT', 'تم تعديل الفاتورة من جهة أخرى', 409);

    const customerName = patch.customerName === undefined ? current.customerName : patch.customerName.trim();
    if (!customerName) throw new DomainError('TAILORING_INVOICE_CUSTOMER_REQUIRED', 'برجاء اختيار العميل', 422);
    const unitPrice = patch.unitPrice === undefined ? decimal(current.unitPrice) : decimal(patch.unitPrice);
    const quantity = patch.quantity === undefined ? decimal(current.quantity) : decimal(patch.quantity, 1);
    if (unitPrice * quantity <= 0) throw new DomainError('TAILORING_INVOICE_PRICE_REQUIRED', 'يرجي إدخال السعر', 422);
    if (quantity < 0) throw new DomainError('TAILORING_QUANTITY_INVALID', 'الكمية غير صحيحة', 422);
    if (patch.partyId) await this.assertParty(tenantId, patch.partyId);
    if (patch.garmentTypeId) await this.assertGarmentType(tenantId, patch.garmentTypeId);
    const statusId = patch.statusId === undefined ? current.statusId : (await this.statusOrThrow(tenantId, patch.statusId)).id;

    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(tailoringInvoices)
        .set({
          ...(patch.partyId === undefined ? {} : { partyId: patch.partyId }),
          customerName,
          ...(patch.phone === undefined ? {} : { phone: patch.phone?.trim() || null }),
          ...(patch.invoiceDate === undefined || !isISODate(patch.invoiceDate) ? {} : { invoiceDate: patch.invoiceDate }),
          quantity: four(quantity),
          unitPrice: four(unitPrice),
          total: four(unitPrice * quantity),
          statusId,
          ...(patch.garmentTypeId === undefined ? {} : { garmentTypeId: patch.garmentTypeId }),
          ...(patch.billed === undefined ? {} : { billed: patch.billed }),
          ...(patch.measurements === undefined ? {} : { measurements: this.measurementsOrThrow(patch.measurements) }),
          ...(patch.notes === undefined ? {} : { notes: patch.notes?.trim() || null }),
          updatedAt: new Date(),
          updatedBy: userId ?? null,
          version: current.version + 1,
        })
        .where(and(eq(tailoringInvoices.tenantId, tenantId), eq(tailoringInvoices.id, id))),
    );
    return this.getInvoice(tenantId, id);
  }

  /** ✅ الحالة — the `✔` beside `stateCB` (`stateSaveBtN_Click` L761). */
  async changeInvoiceStatus(tenantId: string, id: string, statusId: string, userId?: string): Promise<InvoiceRow> {
    await this.ensureEnabled(tenantId);
    const status = await this.statusOrThrow(tenantId, statusId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(tailoringInvoices)
        .set({ statusId: status.id, updatedAt: new Date(), updatedBy: userId ?? null, version: sql`${tailoringInvoices.version} + 1` })
        .where(and(eq(tailoringInvoices.tenantId, tenantId), eq(tailoringInvoices.id, id), isNull(tailoringInvoices.deletedAt)))
        .returning({ id: tailoringInvoices.id }),
    );
    if (!row) throw new DomainError('TAILORING_INVOICE_NOT_FOUND', 'فاتورة التفصيل غير موجودة', 404);
    return this.getInvoice(tenantId, id);
  }

  /**
   * 💵 إستلام دفعة — `AddNewSizes.btnRecievePaid_Click` L664 opens the treasury window
   * (`frmSandQ` with `ISTailor = true`) pre-filled with المتبقي and the note
   * «تم استلام دفعة من عملية رقم {code}» (L683). Given a صندوق, the cloud writes that
   * سند قبض for real and links it; without one it records the payment on the invoice
   * only, which is all `Inv_Sub_Tailor.paid` ever held.
   */
  async addPayment(tenantId: string, id: string, input: PaymentInput, userId?: string): Promise<InvoiceRow> {
    await this.ensureEnabled(tenantId);
    const current = await this.getInvoice(tenantId, id);
    const received = decimal(input.amount);
    if (received <= 0) throw new DomainError('TAILORING_PAYMENT_AMOUNT_INVALID', 'مبلغ الدفعة غير صحيح', 422);
    const paidAt = input.date && isISODate(input.date) ? input.date : todayISO();
    const note = input.note?.trim() || `تم استلام دفعة من عملية رقم ${current.number}`;

    let voucherId: string | null = null;
    if (input.cashLocationId) {
      const voucher = await this.treasury.createVoucher(tenantId, {
        branchId: input.branchId ?? '',
        kind: 'receipt',
        subtype: 'customer',
        date: paidAt,
        partyId: current.partyId ?? undefined,
        cashLocationId: input.cashLocationId,
        method: input.method ?? 'cash',
        amount: four(received),
        description: note,
      });
      voucherId = voucher!.id;
    }

    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.insert(tailoringInvoicePayments).values({
        id: newId(),
        tenantId,
        invoiceId: id,
        voucherId,
        amount: four(received),
        paidAt,
        note,
        createdBy: userId ?? null,
      }),
    );
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(tailoringInvoices)
        .set({
          paidAmount: four(decimal(current.paidAmount) + received),
          updatedAt: new Date(),
          updatedBy: userId ?? null,
          version: sql`${tailoringInvoices.version} + 1`,
        })
        .where(and(eq(tailoringInvoices.tenantId, tenantId), eq(tailoringInvoices.id, id))),
    );
    return this.getInvoice(tenantId, id);
  }

  async deleteInvoice(tenantId: string, id: string, userId?: string): Promise<{ deleted: true }> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(tailoringInvoices)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null })
        .where(and(eq(tailoringInvoices.tenantId, tenantId), eq(tailoringInvoices.id, id), isNull(tailoringInvoices.deletedAt)))
        .returning({ id: tailoringInvoices.id }),
    );
    if (!row) throw new DomainError('TAILORING_INVOICE_NOT_FOUND', 'فاتورة التفصيل غير موجودة', 404);
    return { deleted: true };
  }

  private async assertGarmentType(tenantId: string, garmentTypeId: string | null) {
    if (!garmentTypeId) return;
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ id: tailoringGarmentTypes.id })
        .from(tailoringGarmentTypes)
        .where(
          and(
            eq(tailoringGarmentTypes.tenantId, tenantId),
            eq(tailoringGarmentTypes.id, garmentTypeId),
            isNull(tailoringGarmentTypes.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!row) throw new DomainError('TAILORING_GARMENT_TYPE_NOT_FOUND', 'نوع الثوب غير موجود', 404);
  }

  /**
   * The 39 columns of `Inv_Sub_Tailor` are the field names; anything else is a typo the
   * screen cannot render, and a measurement nobody can read is a measurement lost.
   */
  private measurementsOrThrow(input: Record<string, string> | undefined): Record<string, string> {
    if (!input) return {};
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!MEASUREMENT_KEYS.has(key))
        throw new DomainError('TAILORING_MEASUREMENT_FIELD_UNKNOWN', `قياس غير معروف: ${key}`, 422, { field: key });
      clean[key] = String(value ?? '');
    }
    return clean;
  }

}

// ---------------------------------------------------------------------------
// 🧾 فاتورة التفصيل — `Inv_Tailor` (`frmViewOrders` + `AddNewSizes`)
//
// The tailoring invoice is a different document from the tailoring order of part two:
// the order is what the tailor promises, the invoice is what he bills and gets paid
// against. `frmViewOrders` reads `Inv_Tailor` and computes two numbers the table never
// stores — 💰 الإجمالي is `sale_price × 1.05` (L88, the same 5% that
// `AddNewSizes.CreateInvoice` L419 hands to the point of sale) and ⏳ الباقي is that
// minus `Inv_Sub_Tailor.paid` (L130).
// ---------------------------------------------------------------------------

/**
 * 📐 المقاسات — the 39 columns of `Inv_Sub_Tailor`, named as the desktop names them and
 * labelled as `AddNewSizes.xaml` labels them. The labels are not data in the desktop
 * (they are XAML), so they live here as the field catalogue the screen renders.
 */
export type MeasurementField = {
  key: string;
  label: string;
  group: 'measurements' | 'shapes' | 'extra';
  kind: 'number' | 'text' | 'select' | 'flag';
  options?: string[];
};

export const MEASUREMENT_FIELDS: MeasurementField[] = [
  // 📐 المقاسات
  { key: 'height1', label: 'الطول (س)', group: 'measurements', kind: 'number' },
  { key: 'height2', label: 'الطول (ك)', group: 'measurements', kind: 'number' },
  { key: 'shoulder', label: 'الكتف', group: 'measurements', kind: 'number' },
  { key: 'hand1', label: 'اليد (س)', group: 'measurements', kind: 'number' },
  { key: 'hand2', label: 'اليد (ص)', group: 'measurements', kind: 'number' },
  { key: 'neck1', label: 'الرقبه (س)', group: 'measurements', kind: 'number' },
  { key: 'neck2', label: 'الرقبه (ص)', group: 'measurements', kind: 'number' },
  { key: 'expand1', label: 'الوسع (1)', group: 'measurements', kind: 'number' },
  { key: 'expand2', label: 'الوسع (2)', group: 'measurements', kind: 'number' },
  { key: 'expand3', label: 'الوسع (3)', group: 'measurements', kind: 'number' },
  { key: 'expandHand1', label: 'وسع الكم (1)', group: 'measurements', kind: 'number' },
  { key: 'expandHand2', label: 'وسع الكم (2)', group: 'measurements', kind: 'number' },
  { key: 'pocketShape', label: '🔍 نوع الجيب', group: 'measurements', kind: 'text' },
  { key: 'txtPoketSize1', label: 'مقاس الجيب (1)', group: 'measurements', kind: 'number' },
  { key: 'txtPoketSize2', label: 'مقاس الجيب (2)', group: 'measurements', kind: 'number' },
  { key: 'txtPoketLong', label: 'بعد الجيب', group: 'measurements', kind: 'number' },
  // ✨ الأشكال والتفاصيل
  {
    key: 'characterShape',
    label: 'شكل الجبزور',
    group: 'shapes',
    kind: 'select',
    options: ['حرف صدف', 'مخفي صدف', 'مخفي صدف + تركيبة', 'مخفي بائن جديد', 'حرف سحاب بائن', 'حرف تحت سحاب'],
  },
  { key: 'txtCahrSize', label: 'مقاس الجبزور', group: 'shapes', kind: 'number' },
  { key: 'shoulderCB', label: 'الكتف', group: 'shapes', kind: 'select', options: ['نازل', 'مستوي', 'وسط'] },
  { key: 'PocketCB', label: 'الجيب', group: 'shapes', kind: 'select', options: ['مخفي', 'بائن', 'تبنيط'] },
  {
    key: 'neckShape',
    label: 'شكل الرقبه',
    group: 'shapes',
    kind: 'select',
    options: ['رقبه ساده', 'رقبه صينى', 'رقبه قلاب'],
  },
  {
    key: 'nickShape',
    label: 'طقطق',
    group: 'shapes',
    kind: 'select',
    options: ['طقطق مع زر', 'طقطق بدون زر'],
  },
  { key: 'txtNeckShape1', label: 'مقاس الرقبه (1)', group: 'shapes', kind: 'number' },
  { key: 'txtNeckShape2', label: 'مقاس الرقبه (2)', group: 'shapes', kind: 'number' },
  {
    key: 'handShape',
    label: 'شكل اليد',
    group: 'shapes',
    kind: 'select',
    options: ['يد ساده', 'يد ساده مثل الكبك', 'كبك قلاب', 'كبك مربع', 'كبك مشتول', 'كبك مدور'],
  },
  {
    key: 'handShapecb',
    label: 'كسرة اليد',
    group: 'shapes',
    kind: 'select',
    options: ['بدون كسرة', 'كسرة', 'كسرتين', 'بدون كسرة جبذور'],
  },
  { key: 'txtHandShape1', label: 'مقاس اليد (1)', group: 'shapes', kind: 'number' },
  { key: 'txtHandShape2', label: 'مقاس اليد (2)', group: 'shapes', kind: 'number' },
  { key: 'trangle', label: 'شكل الحافة — مثلث', group: 'shapes', kind: 'flag' },
  { key: 'square', label: 'شكل الحافة — مربع', group: 'shapes', kind: 'flag' },
  { key: 'pocketPen', label: 'جيب قلم', group: 'shapes', kind: 'flag' },
  { key: 'disappear', label: 'جيب مخفي', group: 'shapes', kind: 'flag' },
  // 📏 مقاسات إضافية
  { key: 'handDownTB', label: 'كفة تحت', group: 'extra', kind: 'text' },
  { key: 'pho1', label: 'جوال (1)', group: 'extra', kind: 'text' },
  { key: 'pho2', label: 'جوال (2)', group: 'extra', kind: 'text' },
  { key: 'save1', label: 'محفظة (1)', group: 'extra', kind: 'text' },
  { key: 'save2', label: 'محفظة (2)', group: 'extra', kind: 'text' },
  { key: 'down', label: 'أسفل', group: 'extra', kind: 'text' },
  { key: 'pocketCheck', label: 'رقابة', group: 'extra', kind: 'text' },
];

const MEASUREMENT_KEYS = new Set(MEASUREMENT_FIELDS.map((field) => field.key));

/** 👔 نوع الثوب — `typeCB`: سعودي · بحريني · اماراتي · كويتي. */
export type GarmentTypeRow = { id: string; code: string; nameAr: string; displayOrder: number; active: boolean };

export type InvoicePaymentRow = {
  id: string;
  amount: string;
  paidAt: string;
  note: string | null;
  voucherId: string | null;
};

export type InvoiceRow = {
  id: string;
  number: string;
  partyId: string | null;
  customerName: string;
  phone: string | null;
  invoiceDate: string;
  quantity: string;
  unitPrice: string;
  /** 💵 الإجمالي = 💰 السعر × 🔢 العدد (`CalculateTotalPrice` L860) — بلا الضريبة. */
  total: string;
  /** 💰 الإجمالي كما يعرضه `frmViewOrders`: الإجمالي × 1.05 (L88). */
  totalWithTax: string;
  /** ✅ المدفوع — `Inv_Sub_Tailor.paid` (L130). */
  paidAmount: string;
  /** ⏳ الباقي = الإجمالي بالضريبة − المدفوع (L90). */
  remainingAmount: string;
  statusId: string;
  statusName: string;
  garmentTypeId: string | null;
  garmentTypeName: string | null;
  billed: boolean;
  measurements: Record<string, string>;
  notes: string | null;
  version: number;
  payments: InvoicePaymentRow[];
};

export type InvoiceInput = {
  partyId?: string | null;
  customerName: string;
  phone?: string | null;
  invoiceDate?: string;
  quantity?: number | string;
  unitPrice: number | string;
  statusId?: string;
  garmentTypeId?: string | null;
  billed?: boolean;
  measurements?: Record<string, string>;
  notes?: string | null;
};

export type InvoicePatch = Partial<InvoiceInput> & { version?: number };

export type InvoiceQuery = {
  search?: string;
  partyId?: string;
  statusId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export type PaymentInput = {
  amount: number | string;
  date?: string;
  note?: string | null;
  /** صندوق أو بنك — «إستلام دفعة» يفتح سند قبض في الخزينة (`frmSandQ`, L664). */
  cashLocationId?: string | null;
  branchId?: string | null;
  method?: 'cash' | 'cheque' | 'bank_transfer' | 'card';
};

const INVOICE_SEQUENCE = { prefix: 'TI-', padding: 6 } as const;
const TAX_RATE = 0.05;
