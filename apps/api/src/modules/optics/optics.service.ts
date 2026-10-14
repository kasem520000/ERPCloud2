import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  opticalPrescriptions,
  opticsFieldLabels,
  parties,
  tenantSettings,
  withTenantTx,
  type DatabaseHandle,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

/**
 * 👓 القيم الخمس لكل عين — `Glasses(SPH, CYL, AX, [ADD], IPD)`
 * (`Class/InvoiceOper.cs` L1662 and `Class/Print.cs` L710: `ReSPH` … `LeIPD`).
 *
 * The desktop never parses them: `bindClass` writes `txtReSPH.Text` straight into a
 * `VarChar` column, and `glassOtions` reads it back with `Conversions.ToString`. So they
 * stay **text** here too — «+1.25» و«-0.50 × 90» و«PL» are all legitimate, and a number
 * box that rejects them would lose data the optician means.
 */
export const EYE_VALUE_KEYS = ['sph', 'cyl', 'axis', 'add', 'ipd'] as const;
export type EyeValueKey = (typeof EYE_VALUE_KEYS)[number];
export type EyeValues = Partial<Record<EyeValueKey, string>>;

/**
 * ⚙️ أسماء الحقول — the ten boxes of «👓  القياسات», in the order «⚙  أسماء الحقول»
 * writes them (`insert into Other_Column (R1,R2,R3,R4,R5,L1,L2,L3,L4,L5)`): حقل 1…5 are
 * the right eye, حقل 6…10 the left. `slot` is the column, `key` is the value it titles.
 */
export const FIELD_LABEL_SLOTS = [
  { slot: 'r1', key: 'sph', side: 'R' as const, order: 1 },
  { slot: 'r2', key: 'cyl', side: 'R' as const, order: 2 },
  { slot: 'r3', key: 'axis', side: 'R' as const, order: 3 },
  { slot: 'r4', key: 'add', side: 'R' as const, order: 4 },
  { slot: 'r5', key: 'ipd', side: 'R' as const, order: 5 },
  { slot: 'l1', key: 'sph', side: 'L' as const, order: 6 },
  { slot: 'l2', key: 'cyl', side: 'L' as const, order: 7 },
  { slot: 'l3', key: 'axis', side: 'L' as const, order: 8 },
  { slot: 'l4', key: 'add', side: 'L' as const, order: 9 },
  { slot: 'l5', key: 'ipd', side: 'L' as const, order: 10 },
] as const;

export type FieldLabelSlot = (typeof FIELD_LABEL_SLOTS)[number]['slot'];

/** `isnull(R1,'RE-SPH') … isnull(L5,'LE-IPD')` — the code-behind's own fallbacks. */
export const FIELD_LABEL_DEFAULTS: Record<FieldLabelSlot, string> = {
  r1: 'RE-SPH',
  r2: 'RE-CYL',
  r3: 'RE-AX',
  r4: 'RE-ADD',
  r5: 'RE-IPD',
  l1: 'LE-SPH',
  l2: 'LE-CYL',
  l3: 'LE-AX',
  l4: 'LE-ADD',
  l5: 'LE-IPD',
};

const VALUE_LENGTH = 64;
const LABEL_LENGTH = 60;

export type PrescriptionInput = {
  partyId: string;
  invoiceLineId?: string | null;
  orientation?: string;
  rightEye?: Record<string, unknown>;
  leftEye?: Record<string, unknown>;
  otherGrid?: Record<string, unknown>;
  notes?: string | null;
};
export type PrescriptionPatch = Partial<PrescriptionInput> & { version?: number };
export type PrescriptionQuery = { search?: string; partyId?: string; limit?: number | string; offset?: number | string };

export type PrescriptionRow = {
  id: string;
  partyId: string;
  customerName: string;
  customerPhone: string;
  invoiceLineId: string | null;
  orientation: string;
  rightEye: EyeValues;
  leftEye: EyeValues;
  otherGrid: Record<string, string>;
  notes: string | null;
  /** 🔢 عدد القيم المدخلة — how much of the card is filled, as the desktop's grid shows. */
  filledCount: number;
  createdAt: string;
  version: number;
};

export type FieldLabelsInput = Partial<Record<FieldLabelSlot, string>>;
export type FieldLabelsRow = {
  id: string | null;
  r1: string;
  r2: string;
  r3: string;
  r4: string;
  r5: string;
  l1: string;
  l2: string;
  l3: string;
  l4: string;
  l5: string;
  /** 🔴 العين اليمنى (RE) — the five captions in the column's order. */
  right: Array<{ key: EyeValueKey; label: string }>;
  /** 🟢 العين اليسرى (LE) — the same for the left column. */
  left: Array<{ key: EyeValueKey; label: string }>;
  /** «حقل 1» … «حقل 10» — the ten boxes of «⚙  أسماء الحقول», in the desktop's order. */
  fields: Array<{ slot: FieldLabelSlot; index: number; key: EyeValueKey; side: 'R' | 'L'; label: string; placeholder: string }>;
  version: number | null;
};

type CustomerRef = { id: string; name: string; phone: string };

function text(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim().slice(0, max);
  return trimmed || undefined;
}

/** `Conversions.ToString(...)` with no parsing — blanks are simply not stored. */
function eyeValues(input: unknown): EyeValues {
  const source = (input ?? {}) as Record<string, unknown>;
  const values: EyeValues = {};
  for (const key of EYE_VALUE_KEYS) {
    const value = text(source[key], VALUE_LENGTH);
    if (value) values[key] = value;
  }
  return values;
}

function stringMap(input: unknown): Record<string, string> {
  const source = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const trimmed = text(value, VALUE_LENGTH);
    if (trimmed) out[key.slice(0, 60)] = trimmed;
  }
  return out;
}

@Injectable()
export class OpticsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  /** 👓 النظارات is a pack: `pack.optics` off means the whole window is unreachable. */
  async ensureEnabled(tenantId: string) {
    const [flag] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'pack.optics'))).limit(1),
    );
    if (flag && flag.value !== true && flag.value !== 'true') throw new DomainError('NOT_FOUND', 'Optics pack is disabled', 404);
  }

  // ─────────────────────────────── 👓 بيانات النظارات ───────────────────────────────

  /**
   * `frmGlasses.xaml` («👓 بيانات النظارات») is reached from a sale invoice —
   * `frmInvSale.glassesOptions` L2505 opens it for the selected صنف with
   * «الرجاء إضافة صنف للفاتورة» / «الرجاء وضع المؤشر على الصنف» — and there is no list
   * window behind it. The cloud keeps the prescription on a عميل (`invoiceLineId` is
   * optional and still drives قسم الطباعة), so this list is the door to the card:
   * `?search=` resolves a عميل the way the other verticals do
   * (`mobile LIKE @Search OR name LIKE @Search`) and lists that عميل's وصفات.
   */
  async listPrescriptions(tenantId: string, query: PrescriptionQuery = {}): Promise<{ data: PrescriptionRow[]; meta: { total: number; customer: CustomerRef | null } }> {
    await this.ensureEnabled(tenantId);
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

    if (query.search !== undefined) {
      const keyword = query.search.trim();
      if (!keyword) throw new DomainError('OPTICS_SEARCH_REQUIRED', 'الرجاء إدخال رقم الجوال أو اسم العميل', 422);
      const customer = await this.firstCustomerByKeyword(tenantId, keyword);
      if (!customer) throw new DomainError('OPTICS_CUSTOMER_NOT_FOUND', 'لم يتم العثور على عميل', 404);
      const rows = await this.prescriptionsOf(tenantId, customer.id);
      return { data: rows, meta: { total: rows.length, customer } };
    }

    const where = query.partyId
      ? and(eq(opticalPrescriptions.tenantId, tenantId), eq(opticalPrescriptions.partyId, query.partyId), isNull(opticalPrescriptions.deletedAt))
      : and(eq(opticalPrescriptions.tenantId, tenantId), isNull(opticalPrescriptions.deletedAt));
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ prescription: opticalPrescriptions, customerName: parties.name, customerPhone: parties.phone })
        .from(opticalPrescriptions)
        .innerJoin(parties, eq(parties.id, opticalPrescriptions.partyId))
        .where(where)
        .orderBy(desc(opticalPrescriptions.createdAt))
        .limit(limit)
        .offset(offset),
    );
    const [counted] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select({ total: count() }).from(opticalPrescriptions).where(where));
    return {
      data: rows.map(({ prescription, customerName, customerPhone }) => shape(prescription, customerName, customerPhone ?? '')),
      meta: { total: Number(counted?.total ?? 0), customer: null },
    };
  }

  async getPrescription(tenantId: string, id: string): Promise<PrescriptionRow> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ prescription: opticalPrescriptions, customerName: parties.name, customerPhone: parties.phone })
        .from(opticalPrescriptions)
        .innerJoin(parties, eq(parties.id, opticalPrescriptions.partyId))
        .where(and(eq(opticalPrescriptions.tenantId, tenantId), eq(opticalPrescriptions.id, id), isNull(opticalPrescriptions.deletedAt)))
        .limit(1),
    );
    if (!row) throw new DomainError('OPTICS_PRESCRIPTION_NOT_FOUND', 'الوصفة غير موجودة', 404);
    return shape(row.prescription, row.customerName, row.customerPhone ?? '');
  }

  /**
   * «✔ إدراج» — `btnSave_Click` → `bindClass()` adds two `Glass` rows (`orientation` "R"
   * then "L") and closes the window. One row holds both eyes here, and the refusal is the
   * desktop's own «الرجاء اختيار عميل» (`frmOrderDetails.xaml.cs` L324), because a وصفة
   * with no عميل has no one to belong to.
   */
  async createPrescription(tenantId: string, input: PrescriptionInput, userId?: string): Promise<PrescriptionRow> {
    await this.ensureEnabled(tenantId);
    if (!input.partyId) throw new DomainError('OPTICS_CUSTOMER_REQUIRED', 'الرجاء اختيار عميل', 422);
    await this.customerOrThrow(tenantId, input.partyId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(opticalPrescriptions)
        .values({
          id: newId(),
          tenantId,
          partyId: input.partyId,
          invoiceLineId: input.invoiceLineId ?? null,
          orientation: text(input.orientation, 32) ?? 'distance',
          rightEye: eyeValues(input.rightEye),
          leftEye: eyeValues(input.leftEye),
          otherGrid: stringMap(input.otherGrid),
          notes: input.notes === undefined ? null : text(input.notes, 2000) ?? null,
          createdBy: userId ?? null,
        })
        .returning(),
    );
    return this.getPrescription(tenantId, row!.id);
  }

  /** ✏️ تعديل — `version` in the `WHERE`, so two windows editing one وصفة cannot both win. */
  async updatePrescription(tenantId: string, id: string, patch: PrescriptionPatch, userId?: string): Promise<PrescriptionRow> {
    await this.ensureEnabled(tenantId);
    const current = await this.rawPrescription(tenantId, id);
    const partyId = patch.partyId ?? current.partyId;
    if (patch.partyId) await this.customerOrThrow(tenantId, partyId);
    const updated = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(opticalPrescriptions)
        .set({
          partyId,
          invoiceLineId: patch.invoiceLineId === undefined ? current.invoiceLineId : patch.invoiceLineId ?? null,
          orientation: patch.orientation === undefined ? current.orientation : text(patch.orientation, 32) ?? current.orientation,
          rightEye: patch.rightEye === undefined ? current.rightEye : eyeValues(patch.rightEye),
          leftEye: patch.leftEye === undefined ? current.leftEye : eyeValues(patch.leftEye),
          otherGrid: patch.otherGrid === undefined ? current.otherGrid : stringMap(patch.otherGrid),
          notes: patch.notes === undefined ? current.notes : text(patch.notes, 2000) ?? null,
          updatedAt: new Date(),
          updatedBy: userId ?? null,
          version: sql`${opticalPrescriptions.version} + 1`,
        })
        .where(
          and(
            eq(opticalPrescriptions.tenantId, tenantId),
            eq(opticalPrescriptions.id, id),
            isNull(opticalPrescriptions.deletedAt),
            patch.version === undefined ? undefined : eq(opticalPrescriptions.version, patch.version),
          ),
        )
        .returning({ id: opticalPrescriptions.id }),
    );
    if (!updated.length) throw new DomainError('VERSION_CONFLICT', 'تم تعديل هذا السجل من مكان آخر', 409);
    return this.getPrescription(tenantId, id);
  }

  /** 🗑️ حذف — `InvoiceOper` deletes a line's glasses with the invoice; a row is hidden. */
  async deletePrescription(tenantId: string, id: string, userId?: string): Promise<{ deleted: true; id: string }> {
    await this.ensureEnabled(tenantId);
    await this.rawPrescription(tenantId, id);
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(opticalPrescriptions)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null, updatedAt: new Date(), updatedBy: userId ?? null })
        .where(and(eq(opticalPrescriptions.tenantId, tenantId), eq(opticalPrescriptions.id, id), isNull(opticalPrescriptions.deletedAt))),
    );
    return { deleted: true, id };
  }

  // ─────────────────────────────── ⚙️ أسماء الحقول ───────────────────────────────

  /**
   * `loadNameLbl` — the ten captions of «👓  القياسات», read at runtime as
   * `isnull(R1,'RE-SPH') … isnull(L5,'LE-IPD') from Other_Column`. With no row the
   * desktop keeps the defaults it declared in its own fields, so a tenant that never
   * opened «⚙  أسماء الحقول» still sees «RE-SPH» … «LE-IPD» here.
   */
  async getFieldLabels(tenantId: string): Promise<FieldLabelsRow> {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(opticsFieldLabels).where(and(eq(opticsFieldLabels.tenantId, tenantId), isNull(opticsFieldLabels.deletedAt))).limit(1),
    );
    return shapeLabels(row ?? null);
  }

  /**
   * `insertglasses` — `delete from Other_Column` then one insert, then
   * `DXMessageBox.Show("تم الحفظ بنجاح", "المدقق")`. The row is replaced, never patched,
   * and there is one row per tenant: `optics_field_labels_tenant_key`.
   *
   * The desktop stores whatever is in the boxes, blanks included. A blank column reads as
   * «» there and the box loses its caption; here a blank reads as its default instead,
   * because `isnull` cannot tell «لم يُسمَّ» from «سُمّي بلا اسم».
   */
  async saveFieldLabels(tenantId: string, input: FieldLabelsInput, userId?: string): Promise<FieldLabelsRow> {
    await this.ensureEnabled(tenantId);
    const values = Object.fromEntries(
      FIELD_LABEL_SLOTS.map(({ slot }) => [slot, text(input[slot], LABEL_LENGTH) ?? '']),
    ) as Record<FieldLabelSlot, string>;
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx
        .update(opticsFieldLabels)
        .set({ deletedAt: new Date(), deletedBy: userId ?? null, updatedAt: new Date(), updatedBy: userId ?? null })
        .where(and(eq(opticsFieldLabels.tenantId, tenantId), isNull(opticsFieldLabels.deletedAt)));
      await tx.insert(opticsFieldLabels).values({ id: newId(), tenantId, ...values, createdBy: userId ?? null });
    });
    return this.getFieldLabels(tenantId);
  }

  // ─────────────────────────────── قسم الطباعة ───────────────────────────────

  /**
   * `Class/Print.cs` L710 — the glasses of one invoice line, printed as
   * `ReSPH · ReCYL · ReAX · ReADD · ReIPD` and `LeSPH · …`. The section keeps its
   * `title` and `rows`, and grows the ten values with the tenant's own captions so a
   * printed وصفة reads in the words the optician chose.
   */
  async invoicePrintSection(tenantId: string, invoiceLineId: string) {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(opticalPrescriptions).where(and(eq(opticalPrescriptions.tenantId, tenantId), eq(opticalPrescriptions.invoiceLineId, invoiceLineId), isNull(opticalPrescriptions.deletedAt))),
    );
    const labels = await this.getFieldLabels(tenantId);
    const latest = rows[rows.length - 1] ?? null;
    return {
      title: '👓 بيانات النظارات',
      rows,
      labels: { right: labels.right, left: labels.left },
      right: latest ? (latest.rightEye as EyeValues) : {},
      left: latest ? (latest.leftEye as EyeValues) : {},
    };
  }

  // ───────────────────────────────────────────────────────────────────────────────

  private async rawPrescription(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(opticalPrescriptions).where(and(eq(opticalPrescriptions.tenantId, tenantId), eq(opticalPrescriptions.id, id), isNull(opticalPrescriptions.deletedAt))).limit(1),
    );
    if (!row) throw new DomainError('OPTICS_PRESCRIPTION_NOT_FOUND', 'الوصفة غير موجودة', 404);
    return row;
  }

  private async prescriptionsOf(tenantId: string, partyId: string): Promise<PrescriptionRow[]> {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({ prescription: opticalPrescriptions, customerName: parties.name, customerPhone: parties.phone })
        .from(opticalPrescriptions)
        .innerJoin(parties, eq(parties.id, opticalPrescriptions.partyId))
        .where(and(eq(opticalPrescriptions.tenantId, tenantId), eq(opticalPrescriptions.partyId, partyId), isNull(opticalPrescriptions.deletedAt)))
        .orderBy(desc(opticalPrescriptions.createdAt)),
    );
    return rows.map(({ prescription, customerName, customerPhone }) => shape(prescription, customerName, customerPhone ?? ''));
  }

  /** `SELECT TOP 10 … ORDER BY name`, then the first row — `SearchCustomer`. */
  private async firstCustomerByKeyword(tenantId: string, keyword: string): Promise<CustomerRef | null> {
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

  /** A وصفة belongs to a عميل of this tenant — «لم يتم العثور على عميل» otherwise. */
  private async customerOrThrow(tenantId: string, partyId: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ id: parties.id }).from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId), eq(parties.kind, 'customer'), isNull(parties.deletedAt))).limit(1),
    );
    if (!row) throw new DomainError('OPTICS_CUSTOMER_NOT_FOUND', 'لم يتم العثور على عميل', 404);
  }
}

function shape(row: typeof opticalPrescriptions.$inferSelect, customerName: string, customerPhone: string): PrescriptionRow {
  const right = (row.rightEye ?? {}) as EyeValues;
  const left = (row.leftEye ?? {}) as EyeValues;
  return {
    id: row.id,
    partyId: row.partyId,
    customerName,
    customerPhone,
    invoiceLineId: row.invoiceLineId ?? null,
    orientation: row.orientation,
    rightEye: right,
    leftEye: left,
    otherGrid: (row.otherGrid ?? {}) as Record<string, string>,
    notes: row.notes ?? null,
    filledCount: Object.values(right).filter(Boolean).length + Object.values(left).filter(Boolean).length,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

/** The ten captions, with `isnull`'s fallbacks applied to anything left blank. */
function shapeLabels(row: typeof opticsFieldLabels.$inferSelect | null): FieldLabelsRow {
  const label = (slot: FieldLabelSlot): string => {
    const value = row ? String(row[slot] ?? '').trim() : '';
    return value || FIELD_LABEL_DEFAULTS[slot];
  };
  const of = (side: 'R' | 'L') =>
    FIELD_LABEL_SLOTS.filter((slot) => slot.side === side).map(({ slot, key }) => ({ key: key as EyeValueKey, label: label(slot) }));
  const right = of('R');
  const left = of('L');
  return {
    id: row?.id ?? null,
    r1: label('r1'),
    r2: label('r2'),
    r3: label('r3'),
    r4: label('r4'),
    r5: label('r5'),
    l1: label('l1'),
    l2: label('l2'),
    l3: label('l3'),
    l4: label('l4'),
    l5: label('l5'),
    right,
    left,
    fields: FIELD_LABEL_SLOTS.map(({ slot, key, side, order }) => ({
      slot,
      index: order,
      key: key as EyeValueKey,
      side,
      label: label(slot),
      // «حقل 1» … «حقل 10» — `frmGlasses.xaml` names the boxes «حقل …» only.
      placeholder: `حقل ${order}`,
    })),
    version: row?.version ?? null,
  };
}
